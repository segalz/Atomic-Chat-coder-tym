use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

/// State tracking the running code agent process.
/// Only one agent can run at a time — the UI disables Run while active.
#[derive(Default)]
pub struct CodeAgentState {
    child: Arc<Mutex<Option<tokio::process::Child>>>,
}

#[derive(Clone, Serialize)]
#[allow(dead_code)]
struct CodeAgentOutputEvent {
    line: String,
}

#[derive(Clone, Serialize)]
struct CodeAgentDoneEvent {
    exit_code: Option<i32>,
    success: bool,
}

#[derive(Clone, Serialize)]
#[allow(dead_code)]
struct CodeAgentErrorEvent {
    message: String,
}


/// Spawn Cline CLI as a subprocess with the given parameters.
///
/// # Arguments
///
/// * `project_dir` - Path to the project directory
/// * `prompt` - The user's prompt/request for the agent
/// * `model_id` - Model identifier (e.g., "claude-3-5-sonnet")
/// * `permission_mode` - Either "ask" or "auto_accept" (adds --yolo flag if auto_accept)
/// * `server_url` - Base URL of the model server (e.g., "http://127.0.0.1:8000/v1")
/// * `api_key` - API key for the model server
/// * `context` - Optional context to append to the prompt
#[tauri::command]
pub async fn spawn_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    model_id: String,
    permission_mode: String,
    server_url: String,
    api_key: String,
    _context: Option<String>,
) -> Result<(), String> {
    // Check if an agent is already running
    {
        let child_guard = state.child.lock().await;
        if child_guard.is_some() {
            return Err("A code agent is already running. Stop it first.".to_string());
        }
    }

    // Build the cline command
    log::info!("[CodeAgent] Building command with parameters:");
    log::info!("  project_dir: {}", project_dir);
    log::info!("  prompt: {}", prompt);
    log::info!("  model_id: {}", model_id);
    log::info!("  permission_mode: {}", permission_mode);
    log::info!("  server_url: {}", server_url);

    // Build command arguments: cline --model <id> --json -p <prompt>
    // Note: Base URL is passed via ANTHROPIC_BASE_URL environment variable below
    let mut cmd = Command::new("cline");
    cmd.arg("--model")
        .arg(&model_id)
        .arg("--json")
        .arg("-p")
        .arg(&prompt);

    // Add --yolo flag if permission_mode is "auto_accept"
    if permission_mode == "auto_accept" {
        cmd.arg("--yolo");
        log::info!("  [✓] Added --yolo flag for auto-accept mode");
    }

    // Set working directory to project
    cmd.current_dir(&project_dir);

    // Set environment variables for the model server
    cmd.env("ANTHROPIC_BASE_URL", &server_url);
    cmd.env("ANTHROPIC_AUTH_TOKEN", &api_key);

    // Capture stdout and stderr
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        let error_msg = format!("Failed to spawn cline: {}", e);
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

    // Store the child process in state
    {
        let mut child_guard = state.child.lock().await;
        *child_guard = Some(child);
    }

    log::info!("[CodeAgent] Process spawned successfully");

    // Stream stdout in background task
    let app_for_stdout = app.clone();
    let child_arc = state.child.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                let _ = app_for_stdout.emit("code-agent-output", CodeAgentOutputEvent {
                    line: line.clone(),
                });
                log::debug!("[CodeAgent] stdout: {}", line);
            }
        }

        // Wait for process exit
        let exit_result = {
            let mut child_guard = child_arc.lock().await;
            if let Some(ref mut child) = *child_guard {
                child.wait().await.ok()
            } else {
                None
            }
        };

        let (exit_code, success) = match exit_result {
            Some(status) => (status.code(), status.success()),
            None => (None, false),
        };

        // Clear the child from state
        {
            let mut child_guard = child_arc.lock().await;
            *child_guard = None;
        }

        // Emit done event
        let _ = app_for_stdout.emit(
            "code-agent-done",
            CodeAgentDoneEvent {
                exit_code,
                success,
            },
        );

        log::info!(
            "[CodeAgent] Process finished: exit_code={:?}, success={}",
            exit_code,
            success
        );
    });

    // Stream stderr in background task
    let app_for_stderr = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                let _ = app_for_stderr.emit("code-agent-error", CodeAgentErrorEvent {
                    message: line.clone(),
                });
                log::warn!("[CodeAgent] stderr: {}", line);
            }
        }
    });

    Ok(())
}

/// Stop the running code agent process.
#[tauri::command]
pub async fn stop_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().await;

    match child_guard.take() {
        Some(mut child) => {
            // Kill the process
            if let Err(e) = child.kill().await {
                log::warn!("Failed to kill code agent process: {}", e);
            }

            // Wait for it to fully exit
            match child.wait().await {
                Ok(status) => {
                    log::info!("Code agent stopped with status: {}", status);
                }
                Err(e) => {
                    log::warn!("Error waiting for code agent to exit: {}", e);
                }
            }

            let _ = app.emit(
                "code-agent-done",
                CodeAgentDoneEvent {
                    exit_code: None,
                    success: false,
                },
            );

            log::info!("Code agent stopped by user");
            Ok(())
        }
        None => Err("No code agent is running".to_string()),
    }
}

/// Check if Claude Code CLI is installed and return its version.
#[tauri::command]
pub async fn check_claude_cli() -> Result<String, String> {
    let claude_bin = find_claude_binary().await?;

    let output = tokio::process::Command::new(&claude_bin)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("Failed to run claude --version: {}", e))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("claude --version failed: {}", stderr))
    }
}

/// Find the claude binary on the system.
async fn find_claude_binary() -> Result<String, String> {
    // Try `which` first (covers PATH, npm globals, etc.)
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = tokio::process::Command::new(which_cmd)
        .arg("claude")
        .output()
        .await
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    // Check well-known absolute paths (not on PATH)
    let candidates = [
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ];
    for candidate in &candidates {
        if tokio::fs::metadata(candidate).await.is_ok() {
            return Ok(candidate.to_string());
        }
    }

    Err("Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code".to_string())
}
