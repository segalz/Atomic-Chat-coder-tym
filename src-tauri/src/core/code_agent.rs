use serde::Serialize;
use serde_json::Value;
use std::{env, path::{Path, PathBuf}, sync::Arc};
#[cfg(unix)]
use libc;
use tauri::{AppHandle, Runtime, State, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use std::time::Duration;

/// State tracking the running code agent process and plan pipeline.
/// Only one agent / pipeline can run at a time — the UI disables Run while active.
#[derive(Default)]
pub struct CodeAgentState {
    pub child:            Arc<Mutex<Option<tokio::process::Child>>>,
    pub stdin:            Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    /// True while Stages 1–3 HTTP calls are in-flight (no child process yet).
    pub pipeline_running: Arc<Mutex<bool>>,
    /// Cancel token for in-flight pipeline stages; `take` + `cancel` to abort.
    pub pipeline_cancel:  Arc<Mutex<Option<tokio_util::sync::CancellationToken>>>,
}

#[derive(Clone, Serialize)]
pub struct CodeAgentOutputEvent {
    pub line: String,
}

#[derive(Clone, Serialize)]
pub struct CodeAgentDoneEvent {
    pub exit_code: Option<i32>,
    pub success: bool,
}

#[derive(Clone, Serialize)]
pub struct CodeAgentErrorEvent {
    pub message: String,
}

#[derive(Clone, Serialize)]
#[allow(dead_code)]
struct PermissionReasonCode {
    code: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct DiffSnapshotEvent {
    paths: Vec<String>,
    patch: String,
    is_truncated: bool,
    note: Option<String>,
    tool_call_id: Option<String>,
}

fn get_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

fn get_paths(value: &Value) -> Vec<String> {
    if let Some(paths) = value.get("paths").and_then(|v| v.as_array()) {
        return paths
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect();
    }

    if let Some(path) = get_string_field(value, &["path", "file_path", "filename"]) {
        return vec![path];
    }

    Vec::new()
}

fn extract_tool_name(value: &Value) -> Option<String> {
    get_string_field(value, &["tool_name", "toolName", "name"])
}

fn extract_tool_call_id(value: &Value) -> Option<String> {
    get_string_field(value, &["tool_call_id", "toolCallId", "id"])
}

fn is_successful_tool_result(value: &Value) -> bool {
    let is_error = value
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    !is_error
}

fn generate_diff(workspace: &Path, paths: &[String]) -> Result<String, String> {
    let git_root = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .current_dir(workspace)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !git_root.status.success() {
        return Ok(String::new());
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("diff").arg("--no-ext-diff").arg("-M").arg("--");
    if !paths.is_empty() {
        cmd.args(paths);
    }
    cmd.current_dir(workspace);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if output.status.success() || output.status.code() == Some(1) {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Validate workspace before running agent.
///
/// Checks: path exists, is a directory, not root, canonicalized.
pub fn validate_workspace(project_dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_dir);

    // Must exist
    if !path.exists() {
        return Err(format!("Project directory does not exist: {}", project_dir));
    }

    // Must be a directory
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", project_dir));
    }

    // Canonicalize (resolve symlinks and ..)
    let canon = path.canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    // Cannot be root directory
    if canon == PathBuf::from("/") {
        return Err("Cannot use root directory as workspace".to_string());
    }

    Ok(canon)
}

/// Check that process is not running as root (Unix only).
#[cfg(unix)]
pub fn check_not_root() -> Result<(), String> {
    if unsafe { libc::geteuid() } == 0 {
        return Err("Refusing to run code agent as root".to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn check_not_root() -> Result<(), String> {
    Ok(())
}

/// Spawn ollama launch claude as a subprocess with the given parameters.
///
/// # Arguments
///
/// * `project_dir` - Path to the project directory
/// * `prompt` - The user's prompt/request for the agent
/// * `ollama_model` - Model identifier from ollama (e.g., "qwen3-coder:30b")
/// * `permission_mode` - Either "ask" or "auto_accept" (adds --dangerously-skip-permissions if auto_accept)
#[tauri::command]
pub async fn spawn_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    ollama_model: String,
    permission_mode: String,
) -> Result<(), String> {
    // Check privileges before anything else
    check_not_root()?;

    // Validate workspace before spawning
    let workspace = validate_workspace(&project_dir)?;
    log::info!("[CodeAgent] Workspace validated: {}", workspace.display());

    // Clone state fields early to avoid lifetime issues with async spawn
    let child_arc = state.child.clone();
    let stdin_arc = state.stdin.clone();

    // Check if an agent is already running
    {
        let child_guard = child_arc.lock().await;
        if child_guard.is_some() {
            return Err("A code agent is already running. Stop it first.".to_string());
        }
    }

    // Build the ollama launch command
    log::info!("[CodeAgent] Building ollama launch command:");
    log::info!("  project_dir: {}", project_dir);
    log::info!("  prompt: {}", prompt);
    log::info!("  ollama_model: {}", ollama_model);
    log::info!("  permission_mode: {}", permission_mode);

    let ollama_bin = find_ollama_binary()
        .ok_or_else(|| "Ollama binary not found. Install ollama and ensure it is on PATH.".to_string())?;

    // Build command (Reality Gate validated 2026-04-07):
    //   ollama launch claude --model MODEL -- \
    //     -p --output-format stream-json --verbose \
    //     [--dangerously-skip-permissions] "PROMPT"
    //
    // Rules:
    //   - Flags for claude MUST come after "--" separator
    //   - "--output-format stream-json" requires "--verbose"
    //   - "-p" = --print (non-interactive); prompt is a positional arg at the end
    let mut cmd = Command::new(&ollama_bin);
    cmd.arg("launch")
        .arg("claude")
        .arg("--model")
        .arg(&ollama_model)
        .arg("--")              // separator: everything after goes to claude, not ollama
        .arg("-p")              // non-interactive / print mode
        .arg("--output-format")
        .arg("stream-json")     // NDJSON realtime stream
        .arg("--verbose");      // required: stream-json fails without this

    // auto_accept → bypass all permission prompts
    if permission_mode == "auto_accept" {
        cmd.arg("--dangerously-skip-permissions");
        log::info!("  [✓] Added --dangerously-skip-permissions for auto-accept mode");
    }

    // Prompt is a positional argument — must come last
    cmd.arg(&prompt);

    // Prepend node binary dirs to PATH so that claude (installed via nvm/npm/volta)
    // is reachable. Tauri apps do not inherit the user's full shell PATH on macOS.
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra_paths: Vec<PathBuf> = vec![
        home.join(".volta/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];

    // Dynamically discover all installed nvm node versions and add their bin dirs.
    // This avoids hardcoding a specific version like "v24.11.1".
    let nvm_versions_dir = home.join(".nvm/versions/node");
    if nvm_versions_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            // Sort descending so the highest version comes first in PATH.
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
    log::info!("  [✓] PATH extended with node/nvm dirs ({} nvm versions found)",
        extra_paths.iter().filter(|p| p.starts_with(&nvm_versions_dir)).count()
    );

    // Set working directory to project (use validated workspace path)
    cmd.current_dir(&workspace);

    // Capture stdin, stdout and stderr so we can interact with the agent.
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        let error_msg = format!("Failed to spawn ollama: {}", e);
        log::error!("{}", error_msg);
        error_msg
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Store the child process and stdin handle in state
    let stdin_handle = child.stdin.take();
    {
        let mut child_guard = child_arc.lock().await;
        *child_guard = Some(child);
    }
    {
        let mut stdin_guard = stdin_arc.lock().await;
        *stdin_guard = stdin_handle;
    }

    log::info!("[CodeAgent] Process spawned successfully");

    // Stream stdout in background task
    let app_for_stdout = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                let _ = app_for_stdout.emit("code-agent-output", CodeAgentOutputEvent {
                    line: line.clone(),
                });
                log::debug!("[CodeAgent] stdout: {}", line);

                if let Ok(parsed) = serde_json::from_str::<Value>(&line) {
                    if parsed.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if is_successful_tool_result(&parsed) {
                            if let Some(tool_name) = extract_tool_name(&parsed) {
                                if tool_name.to_lowercase().contains("write") {
                                    let paths = get_paths(&parsed);
                                    let patch = generate_diff(&workspace, &paths).unwrap_or_default();
                                    let note = if patch.is_empty() {
                                        Some("Git diff unavailable or clean workspace".to_string())
                                    } else {
                                        None
                                    };
                                    let _ = app_for_stdout.emit(
                                        "diff_snapshot",
                                        DiffSnapshotEvent {
                                            paths,
                                            patch,
                                            is_truncated: false,
                                            note,
                                            tool_call_id: extract_tool_call_id(&parsed),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // Wait for process exit.
        // If child is None here it means stop_code_agent() already took it
        // and will emit code-agent-done itself — skip to avoid duplicate events.
        let exit_result = {
            let mut child_guard = child_arc.lock().await;
            if let Some(ref mut child) = *child_guard {
                child.wait().await.ok()
            } else {
                None
            }
        };

        // Clear the child and stdin from state
        {
            let mut child_guard = child_arc.lock().await;
            *child_guard = None;
        }
        {
            let mut stdin_guard = stdin_arc.lock().await;
            *stdin_guard = None;
        }

        // Only emit done if WE waited for the process (not stop_code_agent).
        // When stop_code_agent takes the child, exit_result is None and
        // stop_code_agent emits its own code-agent-done.
        if let Some(status) = exit_result {
            log::info!(
                "[CodeAgent] Process finished: exit_code={:?}, success={}",
                status.code(),
                status.success()
            );
            let _ = app_for_stdout.emit(
                "code-agent-done",
                CodeAgentDoneEvent {
                    exit_code: status.code(),
                    success: status.success(),
                },
            );
        } else {
            log::info!("[CodeAgent] Process was stopped externally (stop_code_agent)");
        }
    });

    // Drain stderr in background — log only, do NOT emit to UI.
    // Ollama and claude write progress/debug info to stderr that is not errors.
    // Only truly fatal messages should surface; for now log them all as warnings.
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                log::warn!("[CodeAgent] stderr: {}", line);
            }
        }
    });

    Ok(())
}

/// Stop the running code agent process with proper cleanup.
/// 
/// Termination strategy:
/// 1. Send SIGTERM to process group (graceful shutdown)
/// 2. Wait up to 2 seconds for process to exit
/// 3. If still alive, send SIGKILL (force kill)
/// 4. Wait for process to fully reap (no zombies)
#[tauri::command]
pub async fn stop_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().await;

    match child_guard.take() {
        Some(mut child) => {
            let child_id = child.id();
            log::info!("[CodeAgent] Stopping process with SIGTERM (PID: {:?})", child_id);

            // Step 1: Send SIGTERM to the process group so child processes
            // spawned by ollama (e.g. claude) are also terminated.
            // Using a negative PID signals the whole process group.
            #[cfg(unix)]
            {
                if let Some(pid) = child_id {
                    unsafe {
                        // killpg(pgid, SIGTERM) — targets the whole group
                        libc::killpg(pid as i32, libc::SIGTERM);
                    }
                }
            }

            #[cfg(not(unix))]
            {
                // On Windows, just use kill()
                let _ = child.kill().await;
            }

            // Step 2: Wait up to 2 seconds for graceful shutdown
            let sigterm_wait = tokio::time::timeout(
                Duration::from_secs(2),
                child.wait(),
            )
            .await;

            match sigterm_wait {
                Ok(Ok(status)) => {
                    // Process exited gracefully
                    log::info!("[CodeAgent] Process exited gracefully: {}", status);
                }
                Ok(Err(e)) => {
                    log::warn!("[CodeAgent] Error waiting for process: {}", e);
                }
                Err(_) => {
                    // Timeout — process did not exit, force kill
                    log::warn!("[CodeAgent] Process did not exit after 2s, sending SIGKILL");
                    if let Err(e) = child.kill().await {
                        log::warn!("[CodeAgent] Failed to SIGKILL: {}", e);
                    }

                    // Wait for it to be reaped
                    match child.wait().await {
                        Ok(status) => {
                            log::info!("[CodeAgent] Process killed: {}", status);
                        }
                        Err(e) => {
                            log::warn!("[CodeAgent] Error reaping process: {}", e);
                        }
                    }
                }
            }

            let _ = app.emit(
                "code-agent-done",
                CodeAgentDoneEvent {
                    exit_code: None,
                    success: false,
                },
            );
            let mut stdin_guard = state.stdin.lock().await;
            *stdin_guard = None;

            log::info!("[CodeAgent] Stopped by user");
            Ok(())
        }
        None => {
            // Release child lock before acquiring pipeline locks.
            drop(child_guard);

            // Check if a pre-stage pipeline (Stages 1–3) is in-flight.
            let mut running_guard = state.pipeline_running.lock().await;
            if *running_guard {
                // Claim the "done" emit — set running to false so the pipeline task skips it.
                *running_guard = false;
                drop(running_guard);

                let mut cancel_guard = state.pipeline_cancel.lock().await;
                if let Some(token) = cancel_guard.take() {
                    token.cancel();
                }
                drop(cancel_guard);

                let _ = app.emit(
                    "code-agent-done",
                    CodeAgentDoneEvent { exit_code: None, success: false },
                );
                log::info!("[CodeAgent] Pipeline (stages 1–3) cancelled by user");
                Ok(())
            } else {
                Err("No code agent is running".to_string())
            }
        }
    }
}

#[tauri::command]
pub async fn send_agent_input(
    state: State<'_, CodeAgentState>,
    text: String,
) -> Result<(), String> {
    let mut stdin_guard = state.stdin.lock().await;
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "Agent stdin is not available".to_string())?;

    let mut payload = text;
    if !payload.ends_with('\n') {
        payload.push('\n');
    }

    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to agent stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn pull_ollama_model<R: Runtime>(
    app_handle: AppHandle<R>,
    model_id: String,
) -> Result<(), String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found. Install: https://ollama.com".to_string())?;

    let mut child = Command::new(&ollama)
        .arg("pull")
        .arg(&model_id)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ollama pull: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture ollama pull stdout".to_string())?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let _ = app_handle.emit("ollama-pull-progress", CodeAgentOutputEvent { line: line.clone() });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Ollama pull failed: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Ollama pull failed with exit code {:?}", status.code()))
    }
}

/// Check if ollama is installed and return its version.
#[tauri::command]
pub async fn check_ollama() -> Result<String, String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found. Install: https://ollama.com".to_string())?;

    let output = tokio::process::Command::new(&ollama)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("Failed to run ollama --version: {}", e))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::info!("[CodeAgent] ollama version: {}", version);
        Ok(version)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("ollama --version failed: {}", stderr))
    }
}

/// List all available models from ollama.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found. Install: https://ollama.com".to_string())?;

    let output = tokio::process::Command::new(&ollama)
        .arg("list")
        .output()
        .await
        .map_err(|e| format!("Failed to run ollama list: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut models = Vec::new();

        // Parse output: skip header line, extract model names
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if !parts.is_empty() {
                models.push(parts[0].to_string());
            }
        }

        log::info!("[CodeAgent] Available models: {:?}", models);
        Ok(models)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("ollama list failed: {}", stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_workspace_rejects_root() {
        assert!(validate_workspace("/").is_err());
    }

    #[test]
    fn test_validate_workspace_rejects_nonexistent() {
        assert!(validate_workspace("/nonexistent/path/xyz_does_not_exist").is_err());
    }

    #[test]
    fn test_validate_workspace_accepts_valid_dir() {
        assert!(validate_workspace("/tmp").is_ok());
    }

    #[test]
    fn test_validate_workspace_rejects_file() {
        // /etc/hosts is a file, not a directory
        assert!(validate_workspace("/etc/hosts").is_err());
    }
}

pub fn find_ollama_binary() -> Option<PathBuf> {
    if let Some(paths) = env::var_os("PATH") {
        for entry in env::split_paths(&paths) {
            let candidate = entry.join("ollama");
            if candidate.is_file() {
                return Some(candidate);
            }
            if cfg!(windows) {
                let candidate_exe = entry.join("ollama.exe");
                if candidate_exe.is_file() {
                    return Some(candidate_exe);
                }
            }
        }
    }

    let known_paths = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/usr/bin/ollama",
    ];

    for path in &known_paths {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

pub fn find_claude_binary() -> Option<PathBuf> {
    if let Some(paths) = env::var_os("PATH") {
        for entry in env::split_paths(&paths) {
            let candidate = entry.join("claude");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        home.join(".volta/bin/claude"),
        home.join(".nvm/versions/node/v22.13.1/bin/claude"),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }

    None
}
