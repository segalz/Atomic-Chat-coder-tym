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
    // Check if an agent is already running
    {
        let child_guard = state.child.lock().await;
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

    // Build command: ollama launch claude --model <model> -p <prompt>
    // NOTE: --output-format stream-json is NOT used here — it has not been validated
    // against `ollama launch claude`. The output (JSON or plain text) is handled
    // by the frontend's tryParseJson fallback in OutputLine.
    let mut cmd = Command::new("ollama");
    cmd.arg("launch")
        .arg("claude")
        .arg("--model")
        .arg(&ollama_model)
        .arg("-p")
        .arg(&prompt);

    // Add --dangerously-skip-permissions if permission_mode is "auto_accept"
    if permission_mode == "auto_accept" {
        cmd.arg("--dangerously-skip-permissions");
        log::info!("  [✓] Added --dangerously-skip-permissions flag for auto-accept mode");
    }

    // Set working directory to project
    cmd.current_dir(&project_dir);

    // Capture stdout and stderr
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

/// Check if ollama is installed and return its version.
#[tauri::command]
pub async fn check_ollama() -> Result<String, String> {
    let output = tokio::process::Command::new("ollama")
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
    let output = tokio::process::Command::new("ollama")
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
