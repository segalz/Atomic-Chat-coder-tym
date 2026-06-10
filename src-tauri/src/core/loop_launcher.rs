use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::code_agent::validate_workspace;

const LOOP_LAUNCH_REQUEST_FILE: &str = "loop-launch-request.json";
const DEFAULT_LOOP_TIMES: u32 = 3;
const DEFAULT_LOOP_INTERVAL_MINUTES: u32 = 5;
const MAX_LOOP_TIMES: u32 = 100;
const MAX_LOOP_INTERVAL_MINUTES: u32 = 1440;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopLaunchRequest {
    pub project_dir: String,
    pub prompt: String,
    pub loop_times: u32,
    pub loop_interval_minutes: u32,
    pub max_iterations: Option<u32>,
    pub created_at: DateTime<Utc>,
}

#[tauri::command]
pub fn get_loop_launch_request_path<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(loop_launch_request_path(app).display().to_string())
}

#[tauri::command]
pub fn queue_loop_launch_request<R: Runtime>(
    app: AppHandle<R>,
    project_dir: String,
    prompt: String,
    loop_times: Option<u32>,
    loop_interval_minutes: Option<u32>,
    max_iterations: Option<u32>,
) -> Result<LoopLaunchRequest, String> {
    let request = build_loop_launch_request(
        project_dir,
        prompt,
        loop_times,
        loop_interval_minutes,
        max_iterations,
    )?;
    let path = loop_launch_request_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create loop launch directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(&request)
        .map_err(|error| format!("Failed to serialize loop launch request: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write loop launch request: {error}"))?;
    Ok(request)
}

#[tauri::command]
pub fn consume_loop_launch_request<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<LoopLaunchRequest>, String> {
    let path = loop_launch_request_path(app);
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read loop launch request: {error}"))?;
    let raw = serde_json::from_str::<LoopLaunchRequest>(&content)
        .map_err(|error| format!("Failed to parse loop launch request: {error}"));
    let _ = fs::remove_file(&path);

    let raw = raw?;
    build_loop_launch_request(
        raw.project_dir,
        raw.prompt,
        Some(raw.loop_times),
        Some(raw.loop_interval_minutes),
        raw.max_iterations,
    )
    .map(Some)
}

fn loop_launch_request_path<R: Runtime>(app: AppHandle<R>) -> PathBuf {
    get_jan_data_folder_path(app).join(LOOP_LAUNCH_REQUEST_FILE)
}

fn build_loop_launch_request(
    project_dir: String,
    prompt: String,
    loop_times: Option<u32>,
    loop_interval_minutes: Option<u32>,
    max_iterations: Option<u32>,
) -> Result<LoopLaunchRequest, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Loop launch prompt cannot be empty".to_string());
    }

    let project_dir = validate_workspace(&project_dir)?.display().to_string();
    Ok(LoopLaunchRequest {
        project_dir,
        prompt,
        loop_times: loop_times
            .unwrap_or(DEFAULT_LOOP_TIMES)
            .clamp(1, MAX_LOOP_TIMES),
        loop_interval_minutes: loop_interval_minutes
            .unwrap_or(DEFAULT_LOOP_INTERVAL_MINUTES)
            .clamp(1, MAX_LOOP_INTERVAL_MINUTES),
        max_iterations: max_iterations.map(|value| value.max(1)),
        created_at: Utc::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_loop_launch_request_validates_and_clamps() {
        let request = build_loop_launch_request(
            "/tmp".to_string(),
            "  fix tests  ".to_string(),
            Some(200),
            Some(2000),
            Some(0),
        )
        .unwrap();

        assert_eq!(request.prompt, "fix tests");
        assert_eq!(request.loop_times, MAX_LOOP_TIMES);
        assert_eq!(request.loop_interval_minutes, MAX_LOOP_INTERVAL_MINUTES);
        assert_eq!(request.max_iterations, Some(1));
    }

    #[test]
    fn build_loop_launch_request_rejects_empty_prompt() {
        assert!(
            build_loop_launch_request("/tmp".to_string(), " ".to_string(), None, None, None)
                .unwrap_err()
                .contains("cannot be empty")
        );
    }
}
