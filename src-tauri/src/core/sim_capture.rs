//! S4 — High-Speed Vision Simulator Context
//!
//! Captures a screenshot from an iOS Simulator or Android Emulator, feeds it
//! to a local Ollama vision model (`qwen2.5-vl`), and returns a textual
//! description of the UI that the agent can use to map visual observations to
//! the React Native component tree.
//!
//! Capture targets:
//!   iOS  : `xcrun simctl io booted screenshot <tmp>`  (direct frame buffer)
//!   Android: `adb exec-out screencap -p > <tmp>`      (raw binary stream, <100ms)

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::{fs, process::Command};

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_VISION_MODEL: &str = "qwen2.5-vl:7b";
const CAPTURE_TIMEOUT_SECS: u64 = 10;

// ── Public API ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimCaptureConfig {
    pub ollama_url: Option<String>,
    pub vision_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimCaptureResult {
    pub platform: String,
    pub description: String,
    pub capture_ms: u64,
    pub inference_ms: u64,
}

/// Tauri event emitted after a successful capture + inference pass.
#[derive(Clone, Serialize)]
pub struct SimCaptureEvent {
    pub result: SimCaptureResult,
}

/// Entry point: detect running simulator, capture frame, run vision inference,
/// emit `sim_capture` event on the Tauri app handle, and return the result.
pub async fn capture_and_describe<R: Runtime>(
    app: &AppHandle<R>,
    config: SimCaptureConfig,
) -> Result<SimCaptureResult, String> {
    let ollama_url = config
        .ollama_url
        .as_deref()
        .unwrap_or(DEFAULT_OLLAMA_URL)
        .trim_end_matches('/')
        .to_owned();
    let vision_model = config
        .vision_model
        .clone()
        .unwrap_or_else(|| DEFAULT_VISION_MODEL.to_owned());

    // Try iOS first, fall back to Android.
    let (platform, png_bytes, capture_ms) = capture_frame().await?;

    let image_b64 = BASE64.encode(&png_bytes);

    let t0 = Instant::now();
    let description = run_vision_inference(&ollama_url, &vision_model, &image_b64).await?;
    let inference_ms = t0.elapsed().as_millis() as u64;

    let result = SimCaptureResult {
        platform,
        description,
        capture_ms,
        inference_ms,
    };

    let _ = app.emit(
        "sim_capture",
        SimCaptureEvent {
            result: result.clone(),
        },
    );

    Ok(result)
}

// ── Frame Capture ─────────────────────────────────────────────────────────────

/// Returns `(platform, png_bytes, elapsed_ms)`.
async fn capture_frame() -> Result<(String, Vec<u8>, u64), String> {
    // Prefer iOS if a booted simulator exists.
    if ios_simulator_booted().await {
        capture_ios().await
    } else {
        capture_android().await
    }
}

async fn ios_simulator_booted() -> bool {
    // `xcrun simctl list devices booted` exits 0 and has output when a sim is running.
    let out = Command::new("xcrun")
        .args(["simctl", "list", "devices", "booted", "--json"])
        .output()
        .await;

    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            // JSON contains at least one device entry if booted.
            text.contains("\"state\" : \"Booted\"") || text.contains("\"state\":\"Booted\"")
        }
        _ => false,
    }
}

async fn capture_ios() -> Result<(String, Vec<u8>, u64), String> {
    let tmp = temp_png_path();
    let t0 = Instant::now();

    let status = tokio::time::timeout(
        Duration::from_secs(CAPTURE_TIMEOUT_SECS),
        Command::new("xcrun")
            .args([
                "simctl",
                "io",
                "booted",
                "screenshot",
                tmp.to_str().unwrap(),
            ])
            .status(),
    )
    .await
    .map_err(|_| "iOS screenshot timed out".to_string())?
    .map_err(|e| format!("xcrun simctl failed: {e}"))?;

    if !status.success() {
        return Err("xcrun simctl io booted screenshot returned non-zero".to_string());
    }

    let elapsed = t0.elapsed().as_millis() as u64;
    let bytes = fs::read(&tmp)
        .await
        .map_err(|e| format!("Failed to read iOS screenshot: {e}"))?;
    let _ = fs::remove_file(&tmp).await;

    Ok(("ios".to_owned(), bytes, elapsed))
}

async fn capture_android() -> Result<(String, Vec<u8>, u64), String> {
    let t0 = Instant::now();

    // `adb exec-out screencap -p` streams raw PNG bytes to stdout — no on-device
    // PNG conversion step, which keeps latency well under 100ms on most hosts.
    let out = tokio::time::timeout(
        Duration::from_secs(CAPTURE_TIMEOUT_SECS),
        Command::new("adb")
            .args(["exec-out", "screencap", "-p"])
            .output(),
    )
    .await
    .map_err(|_| "Android screenshot timed out".to_string())?
    .map_err(|e| format!("adb exec-out failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("adb screencap error: {stderr}"));
    }

    let elapsed = t0.elapsed().as_millis() as u64;
    Ok(("android".to_owned(), out.stdout, elapsed))
}

fn temp_png_path() -> PathBuf {
    std::env::temp_dir().join(format!("sim_capture_{}.png", uuid::Uuid::new_v4()))
}

// ── Vision Inference ──────────────────────────────────────────────────────────

async fn run_vision_inference(
    ollama_url: &str,
    model: &str,
    image_b64: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": { "url": format!("data:image/png;base64,{image_b64}") }
                    },
                    {
                        "type": "text",
                        "text": "Describe this mobile app UI screenshot. List every visible screen element, their text content, layout position (top/center/bottom, left/center/right), and visual state (active, disabled, selected, loading). Output as a concise bulleted list. This will be used by a coding agent to map the visual UI to the underlying React Native component tree."
                    }
                ]
            }
        ],
        "stream": false
    });

    let resp = client
        .post(format!("{ollama_url}/v1/chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama {status}: {text}"));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {e}"))?;

    let description = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();

    if description.is_empty() {
        return Err("Vision model returned empty description".to_string());
    }

    Ok(description)
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sim_capture<R: Runtime>(
    app: AppHandle<R>,
    ollama_url: Option<String>,
    vision_model: Option<String>,
) -> Result<SimCaptureResult, String> {
    capture_and_describe(
        &app,
        SimCaptureConfig {
            ollama_url,
            vision_model,
        },
    )
    .await
}
