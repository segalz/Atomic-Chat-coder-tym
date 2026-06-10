//! Optional AI-assisted checkpoint improvement.
//!
//! Reads a deterministic `LoopCheckpoint` and attempts to improve two fields —
//! `next_action` and `known_findings` — by asking a local Ollama model.
//!
//! All other checkpoint fields are left **unchanged**.
//!
//! ## Feature flag
//!
//! The pass is completely inert unless the environment variable
//! `LOOP_CHECKPOINT_AI_ENABLED` is set to `"1"`.  Any network error, invalid
//! JSON, or schema violation causes the function to return the original
//! checkpoint silently.
//!
//! ## Usage
//!
//! ```ignore
//! let improved = maybe_improve_checkpoint(checkpoint, "http://localhost:11434", "llama3").await;
//! ```

use crate::core::loop_checkpoint::LoopCheckpoint;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Try to improve `next_action` and `known_findings` in a checkpoint using a
/// local Ollama model.  Returns the original checkpoint **unchanged** if
/// anything fails (env flag not set, model unavailable, invalid JSON, schema
/// mismatch, timeout).
pub async fn maybe_improve_checkpoint(
    checkpoint: LoopCheckpoint,
    ollama_base_url: &str,
    model: &str,
) -> LoopCheckpoint {
    // ---- Feature flag check ------------------------------------------------
    if std::env::var("LOOP_CHECKPOINT_AI_ENABLED").as_deref() != Ok("1") {
        return checkpoint;
    }

    // ---- Build prompt -------------------------------------------------------
    let prompt = match build_prompt(&checkpoint) {
        Some(p) => p,
        None => return checkpoint,
    };

    // ---- Call Ollama --------------------------------------------------------
    let ai_fields = match call_ollama(ollama_base_url, model, &prompt).await {
        Ok(f) => f,
        Err(_) => return checkpoint,
    };

    // ---- Validate -----------------------------------------------------------
    if !validate_ai_fields(&ai_fields) {
        return checkpoint;
    }

    // ---- Merge the two improved fields -------------------------------------
    LoopCheckpoint {
        next_action: ai_fields.next_action,
        known_findings: ai_fields.known_findings,
        ..checkpoint
    }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/// Maximum characters we allow the checkpoint JSON to occupy inside the prompt.
const MAX_CHECKPOINT_JSON_CHARS: usize = 1200;
/// Hard cap for the entire prompt string.
const MAX_PROMPT_CHARS: usize = 1500;

fn build_prompt(checkpoint: &LoopCheckpoint) -> Option<String> {
    let cp_json = serde_json::to_string_pretty(checkpoint).ok()?;

    // Truncate checkpoint JSON if needed, appending "..." so the model knows.
    let cp_json_truncated = if cp_json.len() > MAX_CHECKPOINT_JSON_CHARS {
        format!("{}...", &cp_json[..MAX_CHECKPOINT_JSON_CHARS])
    } else {
        cp_json
    };

    let instruction = "You are a checkpoint reviewer. Read the checkpoint below and return a \
JSON object with exactly two fields: `next_action` (string) and `known_findings` (array of \
strings). Do not invent new information. Only improve wording or consolidate duplicates. \
Return valid JSON only, no explanation.";

    let prompt = format!("{instruction}\n\nCheckpoint:\n{cp_json_truncated}");

    // Final safety truncation — should not be needed given the above, but be safe.
    if prompt.len() > MAX_PROMPT_CHARS {
        Some(prompt[..MAX_PROMPT_CHARS].to_string())
    } else {
        Some(prompt)
    }
}

// ---------------------------------------------------------------------------
// Ollama client
// ---------------------------------------------------------------------------

/// The minimal subset of the Ollama `/api/generate` response we need.
#[derive(Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

/// Fields extracted from the AI response.
struct AiFields {
    next_action: String,
    known_findings: Vec<String>,
}

async fn call_ollama(base_url: &str, model: &str, prompt: &str) -> Result<AiFields, ()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| ())?;

    let url = format!("{}/api/generate", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
    });

    let resp = client.post(&url).json(&body).send().await.map_err(|_| ())?;

    if !resp.status().is_success() {
        return Err(());
    }

    let ollama_resp: OllamaGenerateResponse = resp.json().await.map_err(|_| ())?;

    parse_ai_response(&ollama_resp.response)
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/// Attempt to parse the model's raw text into the two expected fields.
///
/// We look for a JSON object in the response text.  If the model wraps the
/// JSON in markdown fences or adds prose, we do a best-effort extraction by
/// finding the first `{` and last `}`.
fn parse_ai_response(raw: &str) -> Result<AiFields, ()> {
    // Strip optional markdown code fences.
    let trimmed = raw.trim();

    // Find the outermost JSON object boundaries.
    let start = trimmed.find('{').ok_or(())?;
    let end = trimmed.rfind('}').ok_or(())?;
    if start > end {
        return Err(());
    }

    let json_slice = &trimmed[start..=end];
    let value: serde_json::Value = serde_json::from_str(json_slice).map_err(|_| ())?;

    let obj = value.as_object().ok_or(())?;

    let next_action = obj
        .get("next_action")
        .and_then(|v| v.as_str())
        .ok_or(())?
        .to_string();

    let known_findings = obj
        .get("known_findings")
        .and_then(|v| v.as_array())
        .ok_or(())?
        .iter()
        .map(|v| v.as_str().ok_or(()).map(|s| s.to_string()))
        .collect::<Result<Vec<String>, ()>>()?;

    Ok(AiFields {
        next_action,
        known_findings,
    })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_NEXT_ACTION_CHARS: usize = 500;
const MAX_KNOWN_FINDINGS_COUNT: usize = 20;
const MAX_KNOWN_FINDING_CHARS: usize = 300;

fn validate_ai_fields(fields: &AiFields) -> bool {
    // next_action must be non-empty and within length limit.
    if fields.next_action.is_empty() || fields.next_action.len() > MAX_NEXT_ACTION_CHARS {
        return false;
    }

    // known_findings must not exceed count or per-item length limits.
    if fields.known_findings.len() > MAX_KNOWN_FINDINGS_COUNT {
        return false;
    }
    for finding in &fields.known_findings {
        if finding.len() > MAX_KNOWN_FINDING_CHARS {
            return false;
        }
    }

    true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_checkpoint() -> LoopCheckpoint {
        LoopCheckpoint {
            loop_id: "loop-test".to_string(),
            run_number: 1,
            max_runs: 3,
            project_dir: "/tmp/proj".to_string(),
            current_goal: "fix the bug".to_string(),
            current_stage: "running".to_string(),
            completed_actions: vec!["read_file".to_string()],
            files_seen: vec!["/tmp/proj/main.rs".to_string()],
            files_changed: vec![],
            tool_results: vec![],
            known_findings: vec!["error: permission denied".to_string()],
            verification: vec![],
            next_action: "edit_file".to_string(),
            do_not_repeat: vec![],
            risks: vec![],
        }
    }

    #[test]
    fn returns_unchanged_when_env_flag_not_set() {
        // Ensure the env var is not set.
        std::env::remove_var("LOOP_CHECKPOINT_AI_ENABLED");

        let cp = sample_checkpoint();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(maybe_improve_checkpoint(
            cp.clone(),
            "http://localhost:11434",
            "llama3",
        ));

        assert_eq!(result.loop_id, cp.loop_id);
        assert_eq!(result.next_action, cp.next_action);
        assert_eq!(result.known_findings, cp.known_findings);
    }

    #[test]
    fn prompt_is_within_char_limit() {
        let cp = sample_checkpoint();
        let prompt = build_prompt(&cp).unwrap();
        assert!(
            prompt.len() <= MAX_PROMPT_CHARS,
            "prompt too long: {} chars",
            prompt.len()
        );
    }

    #[test]
    fn prompt_truncates_large_checkpoint() {
        let mut cp = sample_checkpoint();
        // Inflate known_findings to make the JSON large.
        cp.known_findings = (0..100)
            .map(|i| format!("finding number {} with some extra padding text here", i))
            .collect();

        let prompt = build_prompt(&cp).unwrap();
        assert!(prompt.len() <= MAX_PROMPT_CHARS);
    }

    #[test]
    fn parse_ai_response_happy_path() {
        let raw = r#"{"next_action": "run cargo check", "known_findings": ["compilation error in main.rs"]}"#;
        let fields = parse_ai_response(raw).unwrap();
        assert_eq!(fields.next_action, "run cargo check");
        assert_eq!(fields.known_findings, vec!["compilation error in main.rs"]);
    }

    #[test]
    fn parse_ai_response_with_markdown_fences() {
        let raw = "```json\n{\"next_action\": \"build\", \"known_findings\": []}\n```";
        let fields = parse_ai_response(raw).unwrap();
        assert_eq!(fields.next_action, "build");
        assert!(fields.known_findings.is_empty());
    }

    #[test]
    fn parse_ai_response_with_prose_around_json() {
        let raw = "Here is my answer:\n{\"next_action\": \"test\", \"known_findings\": [\"issue A\"]}\nDone.";
        let fields = parse_ai_response(raw).unwrap();
        assert_eq!(fields.next_action, "test");
    }

    #[test]
    fn parse_ai_response_rejects_missing_next_action() {
        let raw = r#"{"known_findings": ["x"]}"#;
        assert!(parse_ai_response(raw).is_err());
    }

    #[test]
    fn parse_ai_response_rejects_missing_known_findings() {
        let raw = r#"{"next_action": "do something"}"#;
        assert!(parse_ai_response(raw).is_err());
    }

    #[test]
    fn validate_rejects_empty_next_action() {
        let fields = AiFields {
            next_action: String::new(),
            known_findings: vec![],
        };
        assert!(!validate_ai_fields(&fields));
    }

    #[test]
    fn validate_rejects_oversized_next_action() {
        let fields = AiFields {
            next_action: "x".repeat(MAX_NEXT_ACTION_CHARS + 1),
            known_findings: vec![],
        };
        assert!(!validate_ai_fields(&fields));
    }

    #[test]
    fn validate_rejects_too_many_findings() {
        let fields = AiFields {
            next_action: "do it".to_string(),
            known_findings: (0..=MAX_KNOWN_FINDINGS_COUNT)
                .map(|i| format!("finding {}", i))
                .collect(),
        };
        assert!(!validate_ai_fields(&fields));
    }

    #[test]
    fn validate_rejects_oversized_finding() {
        let fields = AiFields {
            next_action: "do it".to_string(),
            known_findings: vec!["x".repeat(MAX_KNOWN_FINDING_CHARS + 1)],
        };
        assert!(!validate_ai_fields(&fields));
    }

    #[test]
    fn validate_accepts_valid_fields() {
        let fields = AiFields {
            next_action: "run cargo check".to_string(),
            known_findings: vec!["compilation error".to_string()],
        };
        assert!(validate_ai_fields(&fields));
    }
}
