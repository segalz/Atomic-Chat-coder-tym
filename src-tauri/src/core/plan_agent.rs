//! Plan Mode pipeline — Stages 1–4 (Translate → Vision → Navigate → Architect).

use base64::Engine as _;
use reqwest::Client;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::core::code_agent::{
    check_not_root, find_claude_binary, find_ollama_binary, validate_workspace, CodeAgentDoneEvent,
    CodeAgentErrorEvent, CodeAgentOutputEvent, CodeAgentState,
};
use crate::core::planner_config::{GeminiConfig, OllamaConfig, PlannerConfig};

// ── Events ─────────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct PlanStageProgressEvent {
    pub stage: String,
    pub status: String,
    pub detail: Option<String>,
}

// ── Architect Stages (Gemini + Ollama Fallback) ────────────────────────────

async fn ensure_gemini_user_config(config: &GeminiConfig) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let gemini_dir = home.join(".gemini");
    tokio::fs::create_dir_all(&gemini_dir)
        .await
        .map_err(|e| format!("Cannot create ~/.gemini: {}", e))?;

    let settings_path = gemini_dir.join("settings.json");

    // Read existing settings or start fresh
    let mut settings: serde_json::Value = if settings_path.exists() {
        let raw = tokio::fs::read_to_string(&settings_path)
            .await
            .unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Patch in planner settings without overwriting existing user values
    settings["thinkingConfig"]["thinkingBudget"] = serde_json::json!(config.thinking_budget);

    tokio::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .await
    .map_err(|e| format!("Cannot write ~/.gemini/settings.json: {}", e))?;

    Ok(())
}

async fn run_stage4_gemini<R: Runtime>(
    app: &AppHandle<R>,
    child_arc: Arc<Mutex<Option<tokio::process::Child>>>,
    stdin_arc: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    mega_prompt: &str,
    project_dir: &str,
    config: &PlannerConfig,
) -> Result<(), String> {
    // 1. Ensure config
    ensure_gemini_user_config(&config.gemini).await?;

    // 2. Find binary
    let gemini_bin = find_claude_binary() // We reuse find_claude_binary logic but look for "gemini"
        .map(|_| Path::new(&config.gemini.cli_path).to_path_buf()) // Simplified for now: use config path
        .unwrap_or_else(|| Path::new("gemini").to_path_buf());

    // Better: let's implement find_gemini_binary in code_agent.rs if needed,
    // but for now we follow the spec's find_binary heuristic.
    let mut cmd = Command::new(&gemini_bin);
    cmd.current_dir(project_dir);
    cmd.arg("-y")
        .arg("--include-directories")
        .arg(project_dir)
        .arg("-p")
        .arg(mega_prompt)
        .arg("-o")
        .arg("text");

    if !config.gemini.model.is_empty() {
        cmd.arg("--model").arg(&config.gemini.model);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Path extension logic (reused from Stage 4 Ollama)
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra_paths: Vec<std::path::PathBuf> = vec![
        home.join(".volta/bin"),
        std::path::PathBuf::from("/usr/local/bin"),
        std::path::PathBuf::from("/opt/homebrew/bin"),
    ];
    let nvm_versions_dir = home.join(".nvm/versions/node");
    if nvm_versions_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
            let mut versions: Vec<std::path::PathBuf> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_unstable_by(|a, b| b.cmp(a));
            extra_paths.splice(0..0, versions);
        }
    }
    let current_path = std::env::var("PATH").unwrap_or_default();
    let prepend = extra_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":");
    cmd.env("PATH", format!("{}:{}", prepend, current_path));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn gemini: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Store child so stop_code_agent can kill it
    {
        let mut guard = child_arc.lock().await;
        *guard = Some(child);
    }

    // Drain stderr
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::warn!("[PlanAgent/Gemini] stderr: {}", line);
        }
    });

    // Stream stdout with synthetic NDJSON wrapping
    let app_clone = app.clone();
    let child_arc_clone = child_arc.clone();
    let _stdin_arc_clone = stdin_arc.clone();

    let status = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let synthetic_json = serde_json::json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": format!("{}\n", line) }] }
            });
            let _ = app_clone.emit(
                "code-agent-output",
                CodeAgentOutputEvent {
                    line: synthetic_json.to_string(),
                },
            );
        }

        let mut guard = child_arc_clone.lock().await;
        if let Some(ref mut c) = *guard {
            c.wait().await.ok()
        } else {
            None
        }
    })
    .await
    .map_err(|e| format!("Gemini stream task failed: {}", e))?;

    // Cleanup state
    {
        let mut guard = child_arc.lock().await;
        *guard = None;
    }
    {
        let mut guard = stdin_arc.lock().await;
        *guard = None;
    }

    match status {
        Some(s) if s.success() => Ok(()),
        Some(s) => Err(format!("Gemini exited with code {:?}", s.code())),
        None => Err("Gemini stopped externally".to_string()),
    }
}

async fn run_stage4_ollama<R: Runtime>(
    app: &AppHandle<R>,
    child_arc: Arc<Mutex<Option<tokio::process::Child>>>,
    stdin_arc: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    mega_prompt: &str,
    project_dir: &str,
    config: &PlannerConfig,
) -> Result<(), String> {
    // Locate ollama binary
    let ollama_bin = find_ollama_binary().ok_or_else(|| "Ollama binary not found".to_string())?;

    // ── Check for Claude Code CLI ─────────────────────────
    if find_claude_binary().is_none() {
        return Err(
            "Claude Code CLI not found. Run: npm i -g @anthropic-ai/claude-code".to_string(),
        );
    }

    let mut cmd = Command::new(&ollama_bin);
    cmd.arg("launch")
        .arg("claude")
        .arg("--model")
        .arg(&config.models.architect)
        .arg("--")
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--allowedTools")
        .arg("Read,LS,Glob,Grep")
        .arg("--disallowedTools")
        .arg("Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch")
        .arg(mega_prompt);

    // Path extension logic
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra_paths: Vec<std::path::PathBuf> = vec![
        home.join(".volta/bin"),
        std::path::PathBuf::from("/usr/local/bin"),
        std::path::PathBuf::from("/opt/homebrew/bin"),
    ];
    let nvm_versions_dir = home.join(".nvm/versions/node");
    if nvm_versions_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
            let mut versions: Vec<std::path::PathBuf> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_unstable_by(|a, b| b.cmp(a));
            extra_paths.splice(0..0, versions);
        }
    }
    let current_path = std::env::var("PATH").unwrap_or_default();
    let prepend = extra_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":");
    cmd.env("PATH", format!("{}:{}", prepend, current_path));
    cmd.current_dir(project_dir);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn architect: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    {
        let mut guard = child_arc.lock().await;
        *guard = Some(child);
    }

    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::warn!("[PlanAgent/Ollama] stderr: {}", line);
        }
    });

    let app_clone = app.clone();
    let child_arc_clone = child_arc.clone();
    let _stdin_arc_clone = stdin_arc.clone();

    let status = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_clone.emit("code-agent-output", CodeAgentOutputEvent { line });
        }

        let mut guard = child_arc_clone.lock().await;
        if let Some(ref mut c) = *guard {
            c.wait().await.ok()
        } else {
            None
        }
    })
    .await
    .map_err(|e| format!("Ollama stream task failed: {}", e))?;

    {
        let mut guard = child_arc.lock().await;
        *guard = None;
    }
    {
        let mut guard = stdin_arc.lock().await;
        *guard = None;
    }

    match status {
        Some(s) if s.success() => Ok(()),
        Some(s) => Err(format!("Ollama exited with code {:?}", s.code())),
        None => Err("Ollama stopped externally".to_string()),
    }
}

async fn run_stage4_architect<R: Runtime>(
    app: &AppHandle<R>,
    child_arc: Arc<Mutex<Option<tokio::process::Child>>>,
    stdin_arc: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    mega_prompt: &str,
    project_dir: &str,
    config: &PlannerConfig,
) -> Result<(), String> {
    if config.gemini.enabled {
        match run_stage4_gemini(
            app,
            child_arc.clone(),
            stdin_arc.clone(),
            mega_prompt,
            project_dir,
            config,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!("[PlanAgent] Gemini failed, falling back to Ollama: {}", e);
                let _ = app.emit(
                    "plan-stage-progress",
                    PlanStageProgressEvent {
                        stage: "architect".to_string(),
                        status: "fallback".to_string(),
                        detail: Some(format!("Gemini failed: {}. Using Ollama.", e)),
                    },
                );
            }
        }
    }

    run_stage4_ollama(app, child_arc, stdin_arc, mega_prompt, project_dir, config).await
}

// ── System prompts ─────────────────────────────────────────────────────────

const TRANSLATE_SYSTEM: &str = "You are a technical translator. Convert the user's request to \
clear, concise English suitable for a software development context. If the request is already \
in English, return it unchanged but clarify any ambiguous technical terms. Output only the \
translated/clarified text — no explanation, no prefix, no suffix.";

const NAVIGATE_SYSTEM: &str = "You are a software architect. Given the file tree of an Expo \
React Native project and a task description, identify 3-5 files that are most likely to need \
changes. Output ONLY a JSON array of relative file paths, e.g. \
[\"src/screens/Home.tsx\", \"src/components/Button.tsx\"]. \
No markdown, no explanation — just the JSON array.";

// ── Ollama HTTP helpers ────────────────────────────────────────────────────

/// Check if the Ollama daemon is responding.
#[tauri::command]
pub async fn check_ollama_health<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let config = PlannerConfig::load(&app);
    let url = format!("{}/api/tags", config.ollama.base_url);
    let client = Client::builder()
        .timeout(Duration::from_millis(3000)) // Short timeout for health check
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client.get(&url).send().await;
    match response {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Text-only Ollama /v1/chat/completions call.
async fn ollama_chat(
    ollama: &OllamaConfig,
    model: &str,
    system: &str,
    user_message: &str,
) -> Result<String, String> {
    let url = format!("{}{}", ollama.base_url, ollama.api_path);
    let client = Client::builder()
        .timeout(Duration::from_millis(ollama.request_timeout_ms))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user_message}
        ],
        "stream": false
    });

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request to Ollama failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama returned HTTP {}: {}", status, text));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

    extract_content(&json)
}

/// Multimodal Ollama call (image + text prompt).
async fn ollama_chat_with_image(
    ollama: &OllamaConfig,
    model: &str,
    prompt: &str,
    image_path: &str,
) -> Result<String, String> {
    let image_bytes = std::fs::read(image_path)
        .map_err(|e| format!("Could not read image '{}': {}", image_path, e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);

    let ext = Path::new(image_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpeg")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };

    let url = format!("{}{}", ollama.base_url, ollama.api_path);
    let client = Client::builder()
        .timeout(Duration::from_millis(ollama.request_timeout_ms))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text",      "text": prompt},
                {"type": "image_url", "image_url": {
                    "url": format!("data:{};base64,{}", mime, b64)
                }}
            ]
        }],
        "stream": false
    });

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Vision HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Vision model returned HTTP {}: {}", status, text));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse vision response: {}", e))?;

    extract_content(&json)
}

fn extract_content(json: &Value) -> Result<String, String> {
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Could not extract content field from Ollama response".to_string())
}

// ── File-tree scanner ──────────────────────────────────────────────────────

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".expo",
    ".next",
    "build",
    "__pycache__",
    ".cache",
    ".turbo",
];

pub fn scan_file_tree(project_dir: &str, max_lines: usize) -> String {
    let root = Path::new(project_dir);
    let mut lines: Vec<String> = Vec::with_capacity(max_lines);
    collect_tree(root, root, &mut lines, 0, max_lines);
    lines.join("\n")
}

fn collect_tree(root: &Path, dir: &Path, lines: &mut Vec<String>, depth: usize, max: usize) {
    if lines.len() >= max {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        if lines.len() >= max {
            break;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip blacklisted directory names
        if path.is_dir() && SKIP_DIRS.iter().any(|s| *s == name_str.as_ref()) {
            continue;
        }
        // Skip hidden dotfiles at depth > 0 (allow root-level .env etc.)
        if name_str.starts_with('.') && depth > 0 {
            continue;
        }

        let relative = path.strip_prefix(root).unwrap_or(&path);
        let indent = "  ".repeat(depth);

        if path.is_dir() {
            lines.push(format!("{}{}/", indent, name_str));
            collect_tree(root, &path, lines, depth + 1, max);
        } else {
            lines.push(format!("{}{}", indent, relative.display()));
        }
    }
}

// ── Path heuristic ─────────────────────────────────────────────────────────

fn detect_explicit_paths(text: &str) -> Vec<String> {
    let mut paths: Vec<String> = text
        .split_whitespace()
        .map(|token| {
            token.trim_matches(|c: char| {
                !c.is_alphanumeric() && c != '/' && c != '.' && c != '_' && c != '-'
            })
        })
        .filter(|t| t.contains('/') && !t.starts_with("http") && t.len() > 3)
        .map(|s| s.to_string())
        .collect();
    paths.dedup();
    paths
}

// ── Navigator response parser ──────────────────────────────────────────────

fn parse_file_hints(response: &str) -> Vec<String> {
    let trimmed = response.trim();

    // Direct JSON array
    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(trimmed) {
        return arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
    }

    // Extract first [...] block from prose
    if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        if start < end {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&trimmed[start..=end]) {
                return arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
    }

    log::warn!("[PlanAgent] Could not parse navigator JSON response; using empty file hints");
    Vec::new()
}

// ── Mega-prompt builder ────────────────────────────────────────────────────

fn build_mega_prompt(
    project_dir: &str,
    translated: &str,
    vision_analysis: &str,
    file_hints: &[String],
) -> String {
    let hints_str = if file_hints.is_empty() {
        "none identified".to_string()
    } else {
        file_hints
            .iter()
            .map(|f| format!("- {}", f))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "You are a senior software architect and React Native / Expo specialist.\n\n\
         Your ONLY task is to analyze the Expo project located at:\n  {project_dir}\n\n\
         Then produce a detailed, step-by-step Markdown execution plan.\n\n\
         ══ STRICT RULES ══\n\
         - DO NOT write, create, edit, or delete any files.\n\
         - DO NOT run shell commands, npm scripts, or git operations.\n\
         - DO NOT commit, stage, or touch the git repository in any way.\n\
         - Your ENTIRE output must be a structured Markdown plan.\n\
         - You MAY use Read, LS, Glob, and Grep as much as needed to understand the code.\n\n\
         ══ CONTEXT ══\n\
         Task (English):\n{translated}\n\n\
         Visual analysis of emulator screenshot:\n{vision}\n\n\
         Navigator suggests starting from these files:\n{hints}\n\n\
         ══ OUTPUT FORMAT ══\n\
         # Execution Plan: [short title]\n\n\
         ## Summary\n\
         [2–3 sentences describing what needs to change and why]\n\n\
         ## Affected Files\n\
         [list of files that will need changes, with brief reason for each]\n\n\
         ## Implementation Steps\n\
         ### Step 1: [...]\n\
         **File:** `path/to/file.tsx`\n\
         **Change:** [exact description of what to change and where]\n\
         **Reason:** [why this change is needed]\n\n\
         [repeat for each step]\n\n\
         ## Testing Steps\n\
         [how to verify the implementation is correct]\n\n\
         ## Risks & Notes\n\
         [edge cases, dependencies, gotchas]",
        project_dir = project_dir,
        translated = translated,
        vision = vision_analysis,
        hints = hints_str,
    )
}

// ── Pipeline inner ─────────────────────────────────────────────────────────

async fn run_pipeline_inner<R: Runtime>(
    app: &AppHandle<R>,
    child_arc: Arc<Mutex<Option<tokio::process::Child>>>,
    stdin_arc: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    project_dir: &str,
    prompt: &str,
    image_path: Option<&str>,
    config: &PlannerConfig,
    cancel: CancellationToken,
    pipeline_running_arc: Arc<Mutex<bool>>,
) -> Result<(), String> {
    // Helper macros to reduce repetition
    macro_rules! emit_stage {
        ($stage:expr, $status:expr) => {
            let _ = app.emit(
                "plan-stage-progress",
                PlanStageProgressEvent {
                    stage: $stage.to_string(),
                    status: $status.to_string(),
                    detail: None,
                },
            );
        };
        ($stage:expr, $status:expr, $detail:expr) => {
            let _ = app.emit(
                "plan-stage-progress",
                PlanStageProgressEvent {
                    stage: $stage.to_string(),
                    status: $status.to_string(),
                    detail: Some($detail.to_string()),
                },
            );
        };
    }

    /// Select between a future and cancellation — returns the future result or
    /// `Err("cancelled")` if the token fires first.
    macro_rules! select_or_cancel {
        ($fut:expr) => {
            tokio::select! {
                result = $fut => result,
                _ = cancel.cancelled() => return Err("cancelled".to_string()),
            }
        };
    }

    let ollama = &config.ollama;

    // ── Stage 1: Translate ────────────────────────────────────────────────
    emit_stage!("translate", "running");

    let translated = tokio::select! {
        res = ollama_chat(ollama, &config.models.translator, TRANSLATE_SYSTEM, prompt) => res,
        _ = tokio::time::sleep(Duration::from_millis(config.ollama.request_timeout_ms)) => Err("Translation timed out. Is Ollama responding?".to_string()),
        _ = cancel.cancelled() => return Err("cancelled".to_string()),
    }
    .map_err(|e| format!("Stage 1 (Translate) failed: {}", e))?;

    log::info!(
        "[PlanAgent] Stage 1 done. Translated: {}…",
        &translated[..translated.len().min(120)]
    );
    emit_stage!("translate", "done", translated);

    // ── Stage 2: Vision (conditional) ────────────────────────────────────
    let vision_analysis = if let Some(img) = image_path {
        emit_stage!("vision", "running");

        let vision_prompt = format!(
            "Describe what you see in this screenshot, focusing on visible UI issues, \
             error messages, or state relevant to this task: {}",
            translated
        );

        match select_or_cancel!(ollama_chat_with_image(
            ollama,
            &config.models.vision,
            &vision_prompt,
            img
        )) {
            Ok(analysis) => {
                log::info!(
                    "[PlanAgent] Stage 2 done. Vision length: {}",
                    analysis.len()
                );
                emit_stage!("vision", "done");
                analysis
            }
            Err(e) => {
                log::warn!("[PlanAgent] Stage 2 vision error: {}", e);
                emit_stage!("vision", "error", e);
                "N/A (vision analysis failed)".to_string()
            }
        }
    } else {
        emit_stage!("vision", "skipped");
        "N/A".to_string()
    };

    // ── Stage 3: Navigate ─────────────────────────────────────────────────
    emit_stage!("navigate", "running");

    let file_tree = scan_file_tree(project_dir, config.pipeline.max_file_tree_lines);
    let explicit_paths = detect_explicit_paths(&translated);

    let navigate_user = format!(
        "Task: {}\n\nFile tree:\n{}\n\nExplicitly mentioned paths: {}",
        translated,
        file_tree,
        if explicit_paths.is_empty() {
            "none".to_string()
        } else {
            explicit_paths.join(", ")
        }
    );

    let nav_response = select_or_cancel!(ollama_chat(
        ollama,
        &config.models.navigator,
        NAVIGATE_SYSTEM,
        &navigate_user
    ))
    .map_err(|e| format!("Stage 3 (Navigate) failed: {}", e))?;

    let file_hints = parse_file_hints(&nav_response);
    log::info!("[PlanAgent] Stage 3 done. File hints: {:?}", file_hints);

    let hints_detail = if file_hints.is_empty() {
        "none identified".to_string()
    } else {
        file_hints.join(", ")
    };
    emit_stage!("navigate", "done", hints_detail);

    // ── Stage 4: Architect (Gemini primary, Ollama fallback) ─────────────
    emit_stage!("architect", "running");

    // Transfer "done" event ownership from the outer pipeline task to the Stage-4
    // architect task.
    {
        let mut g = pipeline_running_arc.lock().await;
        *g = false;
    }

    // Last cancellation check before architect
    if cancel.is_cancelled() {
        let _ = app.emit(
            "code-agent-done",
            CodeAgentDoneEvent {
                exit_code: None,
                success: false,
            },
        );
        return Ok(());
    }

    // Build the mega-prompt for the architect agent
    let mega_prompt = build_mega_prompt(project_dir, &translated, &vision_analysis, &file_hints);

    match run_stage4_architect(app, child_arc, stdin_arc, &mega_prompt, project_dir, config).await {
        Ok(()) => {
            let _ = app.emit(
                "plan-stage-progress",
                PlanStageProgressEvent {
                    stage: "architect".to_string(),
                    status: "done".to_string(),
                    detail: None,
                },
            );
            let _ = app.emit(
                "code-agent-done",
                CodeAgentDoneEvent {
                    exit_code: Some(0),
                    success: true,
                },
            );
        }
        Err(e) => {
            log::error!("[PlanAgent] Architect stage failed: {}", e);
            let _ = app.emit(
                "plan-stage-progress",
                PlanStageProgressEvent {
                    stage: "architect".to_string(),
                    status: "error".to_string(),
                    detail: Some(e.clone()),
                },
            );
            let _ = app.emit("code-agent-error", CodeAgentErrorEvent { message: e });
            let _ = app.emit(
                "code-agent-done",
                CodeAgentDoneEvent {
                    exit_code: Some(1),
                    success: false,
                },
            );
        }
    }

    // run_pipeline_inner returns immediately — the architect call above handled done emission.
    Ok(())
}

// ── Project validation ─────────────────────────────────────────────────────

fn is_expo_project(project_dir: &str) -> bool {
    let root = Path::new(project_dir);

    // 1. Check for app.json or app.config.js
    if root.join("app.json").exists()
        || root.join("app.config.js").exists()
        || root.join("app.config.ts").exists()
    {
        return true;
    }

    // 2. Check package.json for "expo" dependency
    if let Ok(content) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<Value>(&content) {
            if let Some(deps) = json.get("dependencies") {
                if deps.get("expo").is_some() {
                    return true;
                }
            }
            if let Some(deps) = json.get("devDependencies") {
                if deps.get("expo").is_some() {
                    return true;
                }
            }
        }
    }

    false
}

// ── Public Tauri command ───────────────────────────────────────────────────

#[tauri::command]
pub async fn run_plan_pipeline<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    image_path: Option<String>,
) -> Result<(), String> {
    check_not_root()?;
    let workspace = validate_workspace(&project_dir)?;
    let workspace_path = workspace.to_string_lossy().into_owned();

    // Warn if not an Expo project
    if !is_expo_project(&workspace_path) {
        let _ = app.emit(
            "plan-stage-progress",
            PlanStageProgressEvent {
                stage: "navigate".to_string(), // Associate warning with early stage
                status: "warning".to_string(),
                detail: Some(
                    "Expo project markers not found. Plan quality may be lower.".to_string(),
                ),
            },
        );
    }

    // Guard: only one pipeline at a time
    {
        let mut running = state.pipeline_running.lock().await;
        if *running {
            return Err("A pipeline is already running. Stop it first.".to_string());
        }
        *running = true;
    }

    // Also guard against a child-process agent already running
    {
        let child_guard = state.child.lock().await;
        if child_guard.is_some() {
            let mut running = state.pipeline_running.lock().await;
            *running = false;
            return Err("A code agent is already running. Stop it first.".to_string());
        }
    }

    // Create and store a cancellation token (used for Stages 1–3 HTTP calls)
    let cancel = CancellationToken::new();
    {
        let mut guard = state.pipeline_cancel.lock().await;
        *guard = Some(cancel.clone());
    }

    // Clone Arcs for the spawned task
    let pipeline_running = state.pipeline_running.clone();
    let pipeline_cancel = state.pipeline_cancel.clone();
    let child_arc = state.child.clone();
    let stdin_arc = state.stdin.clone();
    let config = PlannerConfig::load(&app);
    let app_clone = app.clone();
    let project_dir_str = workspace_path.clone();

    tokio::spawn(async move {
        let result = run_pipeline_inner(
            &app_clone,
            child_arc,
            stdin_arc,
            &project_dir_str,
            &prompt,
            image_path.as_deref(),
            &config,
            cancel,
            pipeline_running.clone(),
        )
        .await;

        // Claim the right to emit `code-agent-done`.
        // If Stage 4 already set pipeline_running=false (which it does before spawning
        // the architect child), should_emit will be false and we skip — the Stage-4
        // stdout task owns the done emission in that case.
        let should_emit = {
            let mut g = pipeline_running.lock().await;
            let was = *g;
            *g = false;
            was
        };
        {
            let mut g = pipeline_cancel.lock().await;
            *g = None;
        }

        if should_emit {
            match result {
                Ok(()) => {
                    // Stage 4 was not reached (pipeline stopped after Stage 3 or
                    // earlier); this path should not normally occur in Phase 4 but
                    // is kept for safety.
                    let _ = app_clone.emit(
                        "code-agent-done",
                        CodeAgentDoneEvent {
                            exit_code: Some(0),
                            success: true,
                        },
                    );
                }
                Err(ref e) if e == "cancelled" => {
                    let _ = app_clone.emit(
                        "code-agent-done",
                        CodeAgentDoneEvent {
                            exit_code: None,
                            success: false,
                        },
                    );
                }
                Err(e) => {
                    log::error!("[PlanAgent] Pipeline error: {}", e);
                    let _ = app_clone.emit("code-agent-error", CodeAgentErrorEvent { message: e });
                    let _ = app_clone.emit(
                        "code-agent-done",
                        CodeAgentDoneEvent {
                            exit_code: Some(1),
                            success: false,
                        },
                    );
                }
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_rejects_nonexistent_dir() {
        let result = crate::core::code_agent::validate_workspace("/nonexistent/path/xyz_123");
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap()
            .contains("Project directory does not exist"));
    }

    #[test]
    fn test_is_expo_project_detects_app_json() {
        let temp = tempfile::tempdir().unwrap();
        let app_json = temp.path().join("app.json");
        std::fs::write(app_json, "{}").unwrap();
        assert!(is_expo_project(temp.path().to_str().unwrap()));
    }

    #[test]
    fn test_is_expo_project_detects_package_json() {
        let temp = tempfile::tempdir().unwrap();
        let pkg_json = temp.path().join("package.json");
        std::fs::write(pkg_json, r#"{"dependencies": {"expo": "51.0.0"}}"#).unwrap();
        assert!(is_expo_project(temp.path().to_str().unwrap()));
    }
}
