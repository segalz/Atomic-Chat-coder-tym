//! S1 — Ollama Agent Loop & Context Manager
//!
//! Drives Ollama's OpenAI-compatible /v1/chat/completions endpoint directly via
//! async HTTP streaming. Implements:
//!   - Streaming text deltas and tool call accumulation
//!   - Self-Healing Engine: up to 3 auto-retries on parse or tool errors
//!   - Context Protection: prunes oldest tool_result messages when history grows large
//!   - Search/Replace paradigm enforced for all file edits
//!   - Typed Tauri events: text_delta, tool_call_start, tool_call_result, diff_proposed, done

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
};

use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HEAL_RETRIES: u32 = 3;
const MAX_ITERATIONS: u32 = 40;
/// Prune when history exceeds this many messages (keeps first system message + recent N)
const CONTEXT_PRUNE_THRESHOLD: usize = 60;
const CONTEXT_KEEP_RECENT: usize = 30;

const BLACKLISTED_DIRS: &[&str] = &[
    "node_modules", "ios/Pods", ".git", "target", "dist", ".expo",
    ".next", "build", "__pycache__", ".cache", ".turbo",
];

const SYSTEM_PROMPT: &str = "\
You are a local-first coding assistant running on Ollama. You help the user write, edit, \
and understand code in their project.

## File Editing Rules — MANDATORY
NEVER produce whole-file rewrites or unified diffs.
For every file edit, use the edit_file tool with EXACT search/replace blocks:
  - `search`: the exact text that currently exists in the file (unique, verbatim)
  - `replace`: the new text that should replace it
If a change spans multiple locations, call edit_file once per location.
If you must create a new file, use write_file.

## Context Hygiene
- Never read the same file twice unless its content has changed.
- Prefer grep and list_dir to orient yourself before reading full files.
- Stay focused: do not explore files unrelated to the task.
";

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct AgentTextDeltaEvent {
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct AgentToolCallStartEvent {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct AgentToolCallResultEvent {
    pub id: String,
    pub name: String,
    pub result: String,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
pub struct AgentDiffProposedEvent {
    pub call_id: String,
    pub path: String,
    /// The exact search text (for display)
    pub search: String,
    /// The replacement text (for display)
    pub replace: String,
}

#[derive(Clone, Serialize)]
pub struct AgentDoneEvent {
    pub success: bool,
    pub error: Option<String>,
}

// ── Tauri State ───────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct OllamaAgentState {
    pub cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// Pending diff approvals: call_id → oneshot sender (true = approved, false = rejected)
    pub pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    pub running: Arc<Mutex<bool>>,
}

// ── Accumulated tool call from SSE stream ─────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

// ── Tool schemas (OpenAI function calling format) ─────────────────────────────

/// Delegates to agent_bridge so schemas are defined in a single place (S2).
fn tool_definitions() -> Value {
    crate::core::mcp::agent_bridge::tool_schemas()
}

// ── Tool execution ────────────────────────────────────────────────────────────

async fn execute_tool<R: Runtime>(
    app: &AppHandle<R>,
    call_id: &str,
    name: &str,
    args: &Value,
    project_dir: &str,
    pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
) -> Result<String, String> {
    match name {
        "read_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("read_file failed for '{}': {}", path.display(), e))
        }

        "write_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            let content = args["content"].as_str()
                .ok_or("write_file: missing 'content'")?
                .to_string();

            // S2: Validate JS/TS AST before the diff reaches the UI.
            // Errors are returned to the S1 self-healing loop, not the user.
            crate::core::mcp::agent_bridge::validate_js_ts(&content, &path)?;

            // Emit diff_proposed and wait for approval
            let (tx, rx) = oneshot::channel::<bool>();
            {
                let mut guard = pending_diffs.lock().await;
                guard.insert(call_id.to_string(), tx);
            }

            let _ = app.emit("agent-diff-proposed", AgentDiffProposedEvent {
                call_id: call_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                search: String::new(),
                replace: content.clone(),
            });

            let approved = rx.await.unwrap_or(false);
            if !approved {
                return Err("User rejected the file write.".to_string());
            }

            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("write_file: cannot create dirs: {}", e))?;
            }
            tokio::fs::write(&path, &content)
                .await
                .map_err(|e| format!("write_file failed for '{}': {}", path.display(), e))?;
            Ok(format!("Written {} bytes to {}", content.len(), path.display()))
        }

        "edit_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            let search = args["search"].as_str()
                .ok_or("edit_file: missing 'search'")?
                .to_string();
            let replace = args["replace"].as_str()
                .ok_or("edit_file: missing 'replace'")?
                .to_string();

            let current = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("edit_file: cannot read '{}': {}", path.display(), e))?;

            if !current.contains(&search) {
                return Err(format!(
                    "edit_file: search text not found in '{}'. Make sure 'search' is an exact, verbatim substring.",
                    path.display()
                ));
            }

            // S2: Apply search/replace in-memory and validate the resulting AST
            // before the diff is ever shown to the user.
            let new_content = current.replacen(&search, &replace, 1);
            crate::core::mcp::agent_bridge::validate_js_ts(&new_content, &path)?;

            // Emit diff_proposed and wait for approval
            let (tx, rx) = oneshot::channel::<bool>();
            {
                let mut guard = pending_diffs.lock().await;
                guard.insert(call_id.to_string(), tx);
            }

            let _ = app.emit("agent-diff-proposed", AgentDiffProposedEvent {
                call_id: call_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                search: search.clone(),
                replace: replace.clone(),
            });

            let approved = rx.await.unwrap_or(false);
            if !approved {
                return Err("User rejected the edit.".to_string());
            }

            // new_content already computed and validated above (S2 gate)
            tokio::fs::write(&path, &new_content)
                .await
                .map_err(|e| format!("edit_file: write failed for '{}': {}", path.display(), e))?;
            Ok(format!("Edit applied to {}", path.display()))
        }

        "list_dir" => {
            let path = resolve_path(args, "path", project_dir)?;
            let mut entries = tokio::fs::read_dir(&path)
                .await
                .map_err(|e| format!("list_dir failed for '{}': {}", path.display(), e))?;

            let mut names: Vec<String> = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Skip blacklisted directories
                if is_blacklisted(&name) {
                    continue;
                }
                let suffix = if entry.path().is_dir() { "/" } else { "" };
                names.push(format!("{}{}", name, suffix));
            }
            names.sort();
            Ok(names.join("\n"))
        }

        "grep" => {
            let pattern = args["pattern"].as_str()
                .ok_or("grep: missing 'pattern'")?;
            let path = resolve_path(args, "path", project_dir)?;
            let file_glob = args["file_glob"].as_str().unwrap_or("*");

            let mut cmd = tokio::process::Command::new("grep");
            cmd.arg("-rn")
                .arg("--include").arg(file_glob)
                .arg("--color=never");

            // Exclude blacklisted dirs
            for dir in BLACKLISTED_DIRS {
                cmd.arg("--exclude-dir").arg(dir);
            }

            cmd.arg(pattern).arg(&path);

            let output = cmd.output()
                .await
                .map_err(|e| format!("grep failed: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.is_empty() {
                Ok("No matches found.".to_string())
            } else {
                // Truncate large results
                let truncated: String = stdout.lines().take(200).collect::<Vec<_>>().join("\n");
                Ok(truncated)
            }
        }

        "run_shell" => {
            let command = args["command"].as_str()
                .ok_or("run_shell: missing 'command'")?;
            let cwd = args["cwd"].as_str().unwrap_or(project_dir);

            let output = tokio::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(cwd)
                .output()
                .await
                .map_err(|e| format!("run_shell failed: {}", e))?;

            let mut result = String::new();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !stdout.is_empty() {
                result.push_str(&stdout.lines().take(300).collect::<Vec<_>>().join("\n"));
            }
            if !stderr.is_empty() {
                if !result.is_empty() { result.push('\n'); }
                result.push_str("[stderr]\n");
                result.push_str(&stderr.lines().take(100).collect::<Vec<_>>().join("\n"));
            }
            if !output.status.success() {
                result.push_str(&format!("\n[exit code: {:?}]", output.status.code()));
            }
            Ok(if result.is_empty() { "(no output)".to_string() } else { result })
        }

        unknown => Err(format!("Unknown tool: {}", unknown)),
    }
}

fn resolve_path(args: &Value, key: &str, project_dir: &str) -> Result<PathBuf, String> {
    let raw = args[key].as_str()
        .ok_or_else(|| format!("Missing required argument '{}'", key))?;
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(PathBuf::from(project_dir).join(p))
    }
}

fn is_blacklisted(name: &str) -> bool {
    BLACKLISTED_DIRS.iter().any(|b| {
        let last = b.split('/').last().unwrap_or(b);
        name == last
    })
}

// ── Context pruning ───────────────────────────────────────────────────────────

/// Drop oldest tool_result messages when history exceeds threshold.
/// Always preserves the first (system) message and the most recent CONTEXT_KEEP_RECENT messages.
fn prune_context(messages: &mut Vec<Value>) {
    if messages.len() <= CONTEXT_PRUNE_THRESHOLD {
        return;
    }

    let system: Vec<Value> = messages.iter()
        .filter(|m| m["role"].as_str() == Some("system"))
        .cloned()
        .collect();

    let non_system: Vec<Value> = messages.iter()
        .filter(|m| m["role"].as_str() != Some("system"))
        .cloned()
        .collect();

    let keep_start = non_system.len().saturating_sub(CONTEXT_KEEP_RECENT);
    let pruned_count = keep_start;

    let mut kept: Vec<Value> = system;
    kept.extend(non_system.into_iter().skip(keep_start));
    *messages = kept;

    log::info!("[OllamaAgent] Context pruned: dropped {} old messages", pruned_count);
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

struct StreamResult {
    text: String,
    tool_calls: Vec<PartialToolCall>,
}

async fn stream_completion<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    messages: &[Value],
    tools: &Value,
) -> Result<StreamResult, String> {
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "stream": true,
        "options": {
            "num_ctx": 32768,
        }
    });

    let response = client
        .post(ollama_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request to Ollama failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama returned HTTP {}: {}", status, text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    let mut full_text = String::new();
    // tool_calls_map: index → PartialToolCall
    let mut tool_calls_map: HashMap<usize, PartialToolCall> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines from buffer
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() || line == "data: [DONE]" {
                continue;
            }

            let json_str = if line.starts_with("data: ") {
                &line[6..]
            } else {
                &line
            };

            let chunk_val: Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let delta = &chunk_val["choices"][0]["delta"];

            // Text content
            if let Some(text) = delta["content"].as_str() {
                if !text.is_empty() {
                    full_text.push_str(text);
                    let _ = app.emit("agent-text-delta", AgentTextDeltaEvent {
                        text: text.to_string(),
                    });
                }
            }

            // Tool call fragments
            if let Some(tc_array) = delta["tool_calls"].as_array() {
                for tc_chunk in tc_array {
                    let index = tc_chunk["index"].as_u64().unwrap_or(0) as usize;
                    let entry = tool_calls_map.entry(index).or_default();

                    if let Some(id) = tc_chunk["id"].as_str() {
                        if entry.id.is_empty() {
                            entry.id = id.to_string();
                        }
                    }
                    if let Some(name) = tc_chunk["function"]["name"].as_str() {
                        if entry.name.is_empty() {
                            entry.name = name.to_string();
                        }
                    }
                    if let Some(args_frag) = tc_chunk["function"]["arguments"].as_str() {
                        entry.arguments.push_str(args_frag);
                    }
                }
            }
        }
    }

    let mut tool_calls: Vec<PartialToolCall> = tool_calls_map.into_values().collect();
    tool_calls.sort_by_key(|tc| tc.id.clone());

    Ok(StreamResult { text: full_text, tool_calls })
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async fn run_agent_loop<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    project_dir: &str,
    user_prompt: &str,
    pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let tools = tool_definitions();

    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": SYSTEM_PROMPT }),
        json!({ "role": "user", "content": user_prompt }),
    ];

    let mut iteration = 0u32;
    let mut heal_retries = 0u32;

    loop {
        if cancel.is_cancelled() {
            return Err("cancelled".to_string());
        }
        if iteration >= MAX_ITERATIONS {
            return Err(format!("Reached max iterations ({})", MAX_ITERATIONS));
        }
        iteration += 1;

        // Context protection: prune if needed
        prune_context(&mut messages);

        log::info!("[OllamaAgent] Iteration {} — {} messages in context", iteration, messages.len());

        // Stream from Ollama
        let stream_result = tokio::select! {
            res = stream_completion(app, client, ollama_url, model, &messages, &tools) => res,
            _ = cancel.cancelled() => return Err("cancelled".to_string()),
        };

        let StreamResult { text, tool_calls } = match stream_result {
            Ok(r) => {
                heal_retries = 0; // successful response resets heal counter
                r
            }
            Err(e) => {
                heal_retries += 1;
                log::warn!("[OllamaAgent] Stream error (attempt {}/{}): {}", heal_retries, MAX_HEAL_RETRIES, e);
                if heal_retries >= MAX_HEAL_RETRIES {
                    return Err(format!("Ollama stream failed after {} retries: {}", MAX_HEAL_RETRIES, e));
                }
                // Inject corrective message and retry
                messages.push(json!({
                    "role": "user",
                    "content": format!("[SYSTEM: Previous response failed with error: {}. Please try again.]", e)
                }));
                continue;
            }
        };

        // Append assistant message to history
        if tool_calls.is_empty() {
            messages.push(json!({ "role": "assistant", "content": text }));
            // No tool calls → model is done
            log::info!("[OllamaAgent] Agent finished — no more tool calls");
            return Ok(());
        } else {
            // Build assistant message with tool_calls array
            let tc_json: Vec<Value> = tool_calls.iter().map(|tc| json!({
                "id": tc.id,
                "type": "function",
                "function": { "name": tc.name, "arguments": tc.arguments }
            })).collect();

            messages.push(json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { Value::String(text) },
                "tool_calls": tc_json
            }));
        }

        // Execute each tool call
        for tc in &tool_calls {
            if cancel.is_cancelled() {
                return Err("cancelled".to_string());
            }

            // Parse arguments
            let args: Value = match serde_json::from_str(&tc.arguments) {
                Ok(v) => v,
                Err(e) => {
                    heal_retries += 1;
                    let err_msg = format!(
                        "Failed to parse arguments for tool '{}': {}. Raw: {}",
                        tc.name, e, tc.arguments
                    );
                    log::warn!("[OllamaAgent] JSON parse error (heal {}/{}): {}", heal_retries, MAX_HEAL_RETRIES, err_msg);

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": format!("[ERROR] {}", err_msg)
                    }));

                    if heal_retries >= MAX_HEAL_RETRIES {
                        return Err(format!("Self-healing exhausted after {} retries", MAX_HEAL_RETRIES));
                    }
                    continue;
                }
            };

            // Emit tool_call_start
            let _ = app.emit("agent-tool-call-start", AgentToolCallStartEvent {
                id: tc.id.clone(),
                name: tc.name.clone(),
            });

            log::info!("[OllamaAgent] Executing tool '{}' (id={})", tc.name, tc.id);

            // Execute tool
            let exec_result = execute_tool(
                app,
                &tc.id,
                &tc.name,
                &args,
                project_dir,
                pending_diffs.clone(),
            ).await;

            let (result_content, is_error) = match exec_result {
                Ok(output) => {
                    heal_retries = 0;
                    (output, false)
                }
                Err(e) => {
                    heal_retries += 1;
                    log::warn!("[OllamaAgent] Tool '{}' error (heal {}/{}): {}",
                        tc.name, heal_retries, MAX_HEAL_RETRIES, e);

                    if heal_retries >= MAX_HEAL_RETRIES {
                        return Err(format!(
                            "Self-healing exhausted: tool '{}' kept failing: {}",
                            tc.name, e
                        ));
                    }
                    (format!("[ERROR] {}", e), true)
                }
            };

            // Emit tool_call_result
            let _ = app.emit("agent-tool-call-result", AgentToolCallResultEvent {
                id: tc.id.clone(),
                name: tc.name.clone(),
                result: result_content.clone(),
                is_error,
            });

            // Append tool result to message history
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_content
            }));
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_ollama_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OllamaAgentState>,
    project_dir: String,
    prompt: String,
    model: String,
    ollama_base_url: Option<String>,
) -> Result<(), String> {
    // Guard: only one agent at a time
    {
        let mut running = state.running.lock().await;
        if *running {
            return Err("An Ollama agent is already running. Stop it first.".to_string());
        }
        *running = true;
    }

    let base_url = ollama_base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let ollama_url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let cancel = CancellationToken::new();
    {
        let mut guard = state.cancel.lock().await;
        *guard = Some(cancel.clone());
    }

    let pending_diffs = state.pending_diffs.clone();
    let running_arc = state.running.clone();
    let cancel_arc = state.cancel.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("Failed to build HTTP client");

        let result = run_agent_loop(
            &app_clone,
            &client,
            &ollama_url,
            &model,
            &project_dir,
            &prompt,
            pending_diffs,
            cancel,
        ).await;

        // Cleanup state
        {
            let mut g = running_arc.lock().await;
            *g = false;
        }
        {
            let mut g = cancel_arc.lock().await;
            *g = None;
        }

        match result {
            Ok(()) => {
                log::info!("[OllamaAgent] Completed successfully");
                let _ = app_clone.emit("agent-done", AgentDoneEvent { success: true, error: None });
            }
            Err(ref e) if e == "cancelled" => {
                log::info!("[OllamaAgent] Cancelled by user");
                let _ = app_clone.emit("agent-done", AgentDoneEvent { success: false, error: None });
            }
            Err(e) => {
                log::error!("[OllamaAgent] Error: {}", e);
                let _ = app_clone.emit("agent-done", AgentDoneEvent {
                    success: false,
                    error: Some(e),
                });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_ollama_agent(
    state: State<'_, OllamaAgentState>,
) -> Result<(), String> {
    let guard = state.cancel.lock().await;
    if let Some(token) = guard.as_ref() {
        token.cancel();
        Ok(())
    } else {
        Err("No Ollama agent is running.".to_string())
    }
}

/// Called by the UI to approve a pending diff (edit_file / write_file).
#[tauri::command]
pub async fn approve_agent_diff(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_diffs.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(true);
        Ok(())
    } else {
        Err(format!("No pending diff with id '{}'", call_id))
    }
}

/// Called by the UI to reject a pending diff (edit_file / write_file).
#[tauri::command]
pub async fn reject_agent_diff(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_diffs.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(false);
        Ok(())
    } else {
        Err(format!("No pending diff with id '{}'", call_id))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_context_leaves_system_and_recent() {
        let mut messages: Vec<Value> = vec![
            json!({"role": "system", "content": "sys"}),
        ];
        for i in 0..80 {
            messages.push(json!({"role": "user", "content": format!("msg {}", i)}));
        }

        prune_context(&mut messages);

        // System message preserved
        assert_eq!(messages[0]["role"], "system");
        // Total should be system + CONTEXT_KEEP_RECENT
        assert_eq!(messages.len(), 1 + CONTEXT_KEEP_RECENT);
    }

    #[test]
    fn test_prune_context_noop_when_small() {
        let mut messages: Vec<Value> = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "hello"}),
        ];
        let original_len = messages.len();
        prune_context(&mut messages);
        assert_eq!(messages.len(), original_len);
    }

    #[test]
    fn test_is_blacklisted() {
        assert!(is_blacklisted("node_modules"));
        assert!(is_blacklisted(".git"));
        assert!(is_blacklisted("Pods"));
        assert!(!is_blacklisted("src"));
        assert!(!is_blacklisted("components"));
    }

    #[test]
    fn test_resolve_path_relative() {
        let args = json!({"path": "src/main.tsx"});
        let result = resolve_path(&args, "path", "/home/user/project").unwrap();
        assert_eq!(result, PathBuf::from("/home/user/project/src/main.tsx"));
    }

    #[test]
    fn test_resolve_path_absolute() {
        let args = json!({"path": "/tmp/file.txt"});
        let result = resolve_path(&args, "path", "/home/user/project").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/file.txt"));
    }
}
