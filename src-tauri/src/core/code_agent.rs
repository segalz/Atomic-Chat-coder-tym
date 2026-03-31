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
struct CodeAgentOutputEvent {
    line: String,
}

#[derive(Clone, Serialize)]
struct CodeAgentDoneEvent {
    exit_code: Option<i32>,
    success: bool,
}

#[derive(Clone, Serialize)]
struct CodeAgentErrorEvent {
    message: String,
}


/// Spawn Claude Code CLI as a subprocess, streaming output as Tauri events.
///
/// Environment variables mirror `launch_claude_code_with_config`:
/// - `ANTHROPIC_BASE_URL` → proxy server URL
/// - `ANTHROPIC_AUTH_TOKEN` → proxy API key
/// - `ANTHROPIC_DEFAULT_SONNET_MODEL` → model_id for Claude CLI
/// - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` → "1"
#[tauri::command]
pub async fn spawn_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    model_id: String,
    context: Option<String>,
    server_url: Option<String>,
    api_key: Option<String>,
) -> Result<(), String> {
    // Check if an agent is already running
    {
        let child_guard = state.child.lock().await;
        if child_guard.is_some() {
            return Err("A code agent is already running. Stop it first.".to_string());
        }
    }

    // Build the full prompt (user prompt + optional context)
    let full_prompt = match context {
        Some(ctx) if !ctx.is_empty() => format!("{}\n\n{}", prompt, ctx),
        _ => prompt,
    };

    // Resolve env vars (same as launch_claude_code_with_config)
    let base_url = server_url.unwrap_or_else(|| "http://127.0.0.1:1337".to_string());
    let auth_token = api_key.unwrap_or_else(|| "jan".to_string());

    // Find the claude binary
    let claude_bin = find_claude_binary().await?;

    let mut cmd = Command::new(&claude_bin);
    cmd.arg("-p")
        .arg(&full_prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--dangerously-skip-permissions");

    cmd.current_dir(&project_dir);

    // Set environment variables — map all Claude model tiers to the local model
    // so Claude CLI uses the local model regardless of which tier it requests
    cmd.env("ANTHROPIC_BASE_URL", &base_url);
    cmd.env("ANTHROPIC_AUTH_TOKEN", &auth_token);
    cmd.env("ANTHROPIC_DEFAULT_OPUS_MODEL", &model_id);
    cmd.env("ANTHROPIC_DEFAULT_SONNET_MODEL", &model_id);
    cmd.env("ANTHROPIC_DEFAULT_HAIKU_MODEL", &model_id);
    cmd.env("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");

    // Prevent nested Claude Code detection
    cmd.env_remove("CLAUDECODE");

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude CLI: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Store the child process
    {
        let mut child_guard = state.child.lock().await;
        *child_guard = Some(child);
    }

    log::info!(
        "Code agent spawned: model={}, project={}, base_url={}",
        model_id,
        project_dir,
        base_url
    );

    // Stream stdout and stderr concurrently in background tasks
    let app_for_stdout = app.clone();
    let app_for_stderr = app.clone();
    let child_arc = state.child.clone();

    // Stderr task
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                let _ = app_for_stderr.emit(
                    "code-agent-error",
                    CodeAgentErrorEvent { message: line },
                );
            }
        }
    });

    // Stdout task + process lifecycle
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Err(e) = app_for_stdout.emit("code-agent-output", CodeAgentOutputEvent { line })
            {
                log::error!("Failed to emit code-agent-output: {}", e);
                break;
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

        // Always emit done event so UI can re-enable Run button
        let _ = app_for_stdout.emit(
            "code-agent-done",
            CodeAgentDoneEvent {
                exit_code,
                success,
            },
        );

        log::info!(
            "Code agent finished: exit_code={:?}, success={}",
            exit_code,
            success
        );
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
