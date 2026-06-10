//! Deterministic checkpoint builder for loop supervision runs.
//!
//! Reads a JSONL event log file (written by `LoopEventLog`) and produces a
//! structured `loop_checkpoint.json` that summarises the run state without any
//! LLM involvement.
//!
//! Typical usage:
//! ```ignore
//! let out = build_and_write_checkpoint("loop-abc", 1, Path::new("/data")).unwrap();
//! // out == /data/loops/loop-abc/run_1_checkpoint.json
//! ```

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Public checkpoint schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolResult {
    pub tool: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VerificationResult {
    pub command: String,
    pub success: bool,
}

/// Snapshot of a loop run derived deterministically from its event log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopCheckpoint {
    pub loop_id: String,
    pub run_number: u32,
    pub max_runs: u32,
    pub project_dir: String,
    pub current_goal: String,
    pub current_stage: String,
    pub completed_actions: Vec<String>,
    pub files_seen: Vec<String>,
    pub files_changed: Vec<String>,
    pub tool_results: Vec<ToolResult>,
    pub known_findings: Vec<String>,
    pub verification: Vec<VerificationResult>,
    pub next_action: String,
    pub do_not_repeat: Vec<String>,
    pub risks: Vec<String>,
}

impl Default for LoopCheckpoint {
    fn default() -> Self {
        Self {
            loop_id: String::new(),
            run_number: 1,
            max_runs: 1,
            project_dir: String::new(),
            current_goal: String::new(),
            current_stage: String::new(),
            completed_actions: Vec::new(),
            files_seen: Vec::new(),
            files_changed: Vec::new(),
            tool_results: Vec::new(),
            known_findings: Vec::new(),
            verification: Vec::new(),
            next_action: String::new(),
            do_not_repeat: Vec::new(),
            risks: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Internal event representation (minimal — only the fields we care about)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RawEvent {
    event: String,
    #[serde(default)]
    loop_id: String,
    #[serde(default)]
    run: u32,
    #[serde(default)]
    payload: serde_json::Value,
}

// ---------------------------------------------------------------------------
// CheckpointBuilder
// ---------------------------------------------------------------------------

pub struct CheckpointBuilder;

impl CheckpointBuilder {
    /// Read a JSONL event log and derive a `LoopCheckpoint` deterministically.
    ///
    /// Malformed lines are silently skipped.  If the file does not exist, a
    /// minimal default checkpoint is returned so callers never need to handle
    /// "no checkpoint" as a special case.
    pub fn build_from_log(log_path: &Path) -> io::Result<LoopCheckpoint> {
        let file = match std::fs::File::open(log_path) {
            Ok(f) => f,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Ok(LoopCheckpoint::default());
            }
            Err(err) => return Err(err),
        };

        let reader = io::BufReader::new(file);
        let mut cp = LoopCheckpoint::default();

        // Tracking state for derivation rules.
        let mut last_event = String::new();

        // tool_name -> count of completed calls
        let mut completed_counts: HashMap<String, usize> = HashMap::new();
        // ordered, deduplicated list of completed tool names
        let mut completed_ordered: Vec<String> = Vec::new();
        // call_id -> tool_name for started-but-not-yet-completed calls
        let mut inflight: HashMap<String, String> = HashMap::new();
        // call_ids that were completed (to identify hung/failed ones later)
        let mut completed_call_ids: HashSet<String> = HashSet::new();
        // recent tool results (we keep all, then take last-5 at the end)
        let mut all_tool_results: Vec<ToolResult> = Vec::new();
        // error messages
        let mut error_messages: Vec<String> = Vec::new();
        // files seen (deduplicated, ordered)
        let mut files_seen_set: IndexedSet = IndexedSet::new();
        // files changed (deduplicated, ordered)
        let mut files_changed_set: IndexedSet = IndexedSet::new();
        // verification results
        let mut verification: Vec<VerificationResult> = Vec::new();
        // risk keywords
        const RISK_KEYWORDS: &[&str] = &[
            "permission",
            "denied",
            "failed",
            "panic",
            "timeout",
            "not found",
        ];

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => continue,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let event: RawEvent = match serde_json::from_str(trimmed) {
                Ok(e) => e,
                Err(_) => continue,
            };

            last_event = event.event.clone();

            match event.event.as_str() {
                "run_started" => {
                    if cp.loop_id.is_empty() {
                        cp.loop_id = event.loop_id.clone();
                    }
                    if cp.run_number == 1 && event.run > 0 {
                        cp.run_number = event.run;
                    }
                    if let Some(pd) = event.payload.get("project_dir").and_then(|v| v.as_str()) {
                        cp.project_dir = pd.to_string();
                    }
                    if let Some(goal) = event.payload.get("goal").and_then(|v| v.as_str()) {
                        cp.current_goal = goal.to_string();
                    }
                    if let Some(mr) = event.payload.get("max_runs").and_then(|v| v.as_u64()) {
                        cp.max_runs = mr as u32;
                    }
                }

                "tool_call_started" => {
                    if let (Some(tool), Some(call_id)) = (
                        event.payload.get("tool_name").and_then(|v| v.as_str()),
                        event.payload.get("call_id").and_then(|v| v.as_str()),
                    ) {
                        inflight.insert(call_id.to_string(), tool.to_string());
                    }
                }

                "tool_call_completed" => {
                    if let (Some(tool), Some(call_id)) = (
                        event.payload.get("tool_name").and_then(|v| v.as_str()),
                        event.payload.get("call_id").and_then(|v| v.as_str()),
                    ) {
                        inflight.remove(call_id);
                        completed_call_ids.insert(call_id.to_string());

                        // completed_actions: deduplicated, ordered by first occurrence
                        let count = completed_counts.entry(tool.to_string()).or_insert(0);
                        *count += 1;
                        if *count == 1 {
                            completed_ordered.push(tool.to_string());
                        }

                        // files_seen for read_file / list_dir
                        if matches!(tool, "read_file" | "list_dir") {
                            let summary = event
                                .payload
                                .get("summary")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            for path in extract_paths_from_summary(summary) {
                                files_seen_set.insert(path);
                            }
                        }

                        // tool_results
                        let summary = event
                            .payload
                            .get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        all_tool_results.push(ToolResult {
                            tool: tool.to_string(),
                            summary,
                        });
                    }
                }

                "file_changed" => {
                    if let Some(path) = event.payload.get("path").and_then(|v| v.as_str()) {
                        files_changed_set.insert(path.to_string());
                    }
                }

                "error_recorded" => {
                    if let Some(msg) = event.payload.get("message").and_then(|v| v.as_str()) {
                        let msg = msg.to_string();
                        // dedup errors
                        if !error_messages.iter().any(|e| e == &msg) {
                            if error_messages.len() < 10 {
                                error_messages.push(msg);
                            }
                        }
                    }
                }

                "verification_completed" => {
                    if let (Some(cmd), Some(success)) = (
                        event.payload.get("command").and_then(|v| v.as_str()),
                        event.payload.get("success").and_then(|v| v.as_bool()),
                    ) {
                        verification.push(VerificationResult {
                            command: cmd.to_string(),
                            success,
                        });
                    }
                }

                _ => {}
            }
        }

        // ---- Derive current_stage ----
        cp.current_stage = match last_event.as_str() {
            "run_completed" => "complete".to_string(),
            "run_failed" => "failed".to_string(),
            _ => {
                if last_event.is_empty() {
                    "unknown".to_string()
                } else {
                    "running".to_string()
                }
            }
        };

        // ---- completed_actions: deduplicated, ordered ----
        cp.completed_actions = completed_ordered;

        // ---- files_seen ----
        cp.files_seen = files_seen_set.into_vec();

        // ---- files_changed ----
        cp.files_changed = files_changed_set.into_vec();

        // ---- tool_results: last 5, most recent first ----
        let start = all_tool_results.len().saturating_sub(5);
        cp.tool_results = all_tool_results[start..].iter().cloned().rev().collect();

        // ---- known_findings ----
        cp.known_findings = error_messages;

        // ---- verification ----
        cp.verification = verification;

        // ---- next_action: tool that is in-flight (started but not completed) ----
        // Take the most recently started one (last insertion in inflight).
        // Since HashMap doesn't track order, we use the last tool_call_started
        // that hasn't been completed yet.
        cp.next_action = inflight.values().next().cloned().unwrap_or_default();

        // ---- do_not_repeat ----
        // 1) Tools that were started but never completed with the same call_id.
        let mut hung_tools: Vec<String> = inflight.values().cloned().collect();
        hung_tools.sort();
        hung_tools.dedup();
        // 2) Tools that appear 3+ times in completed_counts.
        let mut repeated_tools: Vec<String> = completed_counts
            .iter()
            .filter(|(_, count)| **count >= 3)
            .map(|(tool, _)| tool.clone())
            .collect();
        repeated_tools.sort();
        let mut do_not_repeat = hung_tools;
        for tool in repeated_tools {
            if !do_not_repeat.contains(&tool) {
                do_not_repeat.push(tool);
            }
        }
        cp.do_not_repeat = do_not_repeat;

        // ---- risks: errors containing risk keywords ----
        let mut risks: Vec<String> = Vec::new();
        for msg in &cp.known_findings {
            let lower = msg.to_ascii_lowercase();
            if RISK_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
                if !risks.iter().any(|r: &String| r == msg) {
                    risks.push(msg.clone());
                }
            }
        }
        cp.risks = risks;

        Ok(cp)
    }
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

/// Write a pretty-printed JSON checkpoint to `out_path`.
pub fn write_checkpoint(checkpoint: &LoopCheckpoint, out_path: &Path) -> io::Result<()> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(checkpoint)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(out_path, json)
}

// ---------------------------------------------------------------------------
// Public convenience function
// ---------------------------------------------------------------------------

/// Build a checkpoint from the JSONL log for a specific run and write it to
/// `{base_dir}/loops/{loop_id}/run_{run_number}_checkpoint.json`.
///
/// Returns the output path on success.
pub fn build_and_write_checkpoint(
    loop_id: &str,
    run_number: u32,
    base_dir: &Path,
) -> io::Result<PathBuf> {
    let log_path = base_dir
        .join("loops")
        .join(loop_id)
        .join(format!("run_{run_number}.jsonl"));
    let out_path = base_dir
        .join("loops")
        .join(loop_id)
        .join(format!("run_{run_number}_checkpoint.json"));

    let checkpoint = CheckpointBuilder::build_from_log(&log_path)?;
    write_checkpoint(&checkpoint, &out_path)?;
    Ok(out_path)
}

/// Build a checkpoint, optionally improve it with a local AI model, write the
/// result to disk, and return the output path.
///
/// The AI improvement step is controlled by the `LOOP_CHECKPOINT_AI_ENABLED`
/// environment variable (must be `"1"` to enable).  If the model is
/// unavailable or produces invalid output the deterministic checkpoint is used
/// unchanged.
pub async fn build_and_write_checkpoint_with_ai(
    loop_id: &str,
    run_number: u32,
    base_dir: &Path,
    ollama_base_url: &str,
    model: &str,
) -> io::Result<PathBuf> {
    use crate::core::loop_checkpoint_ai::maybe_improve_checkpoint;

    let out_path = base_dir
        .join("loops")
        .join(loop_id)
        .join(format!("run_{run_number}_checkpoint.json"));

    // Build the deterministic checkpoint (also writes it to disk).
    build_and_write_checkpoint(loop_id, run_number, base_dir)?;

    // Attempt to read back the checkpoint we just wrote so we can pass it to
    // the AI pass.  If this fails we have already written the deterministic
    // version, so just return the path.
    let json = match std::fs::read_to_string(&out_path) {
        Ok(s) => s,
        Err(_) => return Ok(out_path),
    };
    let checkpoint: LoopCheckpoint = match serde_json::from_str(&json) {
        Ok(cp) => cp,
        Err(_) => return Ok(out_path),
    };

    // Run the optional AI improvement pass.
    let improved = maybe_improve_checkpoint(checkpoint, ollama_base_url, model).await;

    // Overwrite the file with the (possibly improved) checkpoint.
    write_checkpoint(&improved, &out_path)?;

    Ok(out_path)
}

/// Build a short, schema-driven resume prompt from a checkpoint.
///
/// The resulting string replaces the original user prompt so the agent can
/// continue from the exact state described by the checkpoint without replaying
/// the full conversation.
pub fn build_resume_prompt(cp: &LoopCheckpoint) -> String {
    let mut lines = Vec::<String>::new();

    lines.push(format!(
        "[CHECKPOINT RESUME — run {}]\nGoal: {}",
        cp.run_number, cp.current_goal
    ));

    if !cp.completed_actions.is_empty() {
        lines.push(format!("Completed: {}", cp.completed_actions.join(", ")));
    }

    if !cp.files_changed.is_empty() {
        lines.push(format!(
            "Files changed so far: {}",
            cp.files_changed.join(", ")
        ));
    }

    if !cp.next_action.is_empty() {
        lines.push(format!("Next action: {}", cp.next_action));
    }

    if !cp.do_not_repeat.is_empty() {
        lines.push(format!("Do not repeat: {}", cp.do_not_repeat.join(", ")));
    }

    let findings: Vec<&str> = cp
        .known_findings
        .iter()
        .take(3)
        .map(|s| s.as_str())
        .collect();
    if !findings.is_empty() {
        lines.push(format!("Known issues: {}", findings.join("; ")));
    }

    if !cp.risks.is_empty() {
        lines.push(format!("Risks: {}", cp.risks.join(", ")));
    }

    lines.push(
        "Continue from the checkpoint above. Do not re-read files already in files_changed. \
         Do not repeat completed_actions. Proceed directly with next_action."
            .to_string(),
    );

    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Ordered, deduplicated set backed by a `Vec`.
struct IndexedSet {
    seen: HashSet<String>,
    ordered: Vec<String>,
}

impl IndexedSet {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            ordered: Vec::new(),
        }
    }

    fn insert(&mut self, value: String) {
        if self.seen.insert(value.clone()) {
            self.ordered.push(value);
        }
    }

    fn into_vec(self) -> Vec<String> {
        self.ordered
    }
}

/// Best-effort extraction of file paths from a tool result summary string.
///
/// Looks for tokens that look like filesystem paths (contain `/` or `\`, or
/// start with `.`).  This is intentionally loose — false-positives are fine
/// because Stage 4 will use them as hints only.
fn extract_paths_from_summary(summary: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for token in summary.split_whitespace() {
        // Strip common punctuation wrappers.
        let t = token.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ':' | '(' | ')'));
        if t.len() > 2 && (t.contains('/') || t.contains('\\') || t.starts_with('.')) {
            paths.push(t.to_string());
        }
    }
    paths
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Write a multi-line JSONL string to a temp file and return the path.
    fn write_jsonl(dir: &TempDir, content: &str) -> PathBuf {
        let path = dir.path().join("run_1.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    fn make_event(event: &str, loop_id: &str, run: u32, payload: serde_json::Value) -> String {
        serde_json::to_string(&serde_json::json!({
            "ts": "2024-01-01T00:00:00Z",
            "event": event,
            "loop_id": loop_id,
            "run": run,
            "payload": payload,
        }))
        .unwrap()
    }

    fn sample_log(extra_events: &[String]) -> String {
        let mut lines = vec![
            make_event(
                "run_started",
                "loop-test",
                1,
                serde_json::json!({ "project_dir": "/tmp/proj", "goal": "fix the bug", "max_runs": 3 }),
            ),
            make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "read_file", "call_id": "c1" }),
            ),
            make_event(
                "tool_call_completed",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "read_file", "call_id": "c1", "duration_ms": 10, "cache_hit": false, "summary": "read /tmp/proj/src/main.rs" }),
            ),
            make_event(
                "file_changed",
                "loop-test",
                1,
                serde_json::json!({ "path": "/tmp/proj/src/main.rs", "bytes_changed": 42 }),
            ),
            make_event(
                "file_changed",
                "loop-test",
                1,
                serde_json::json!({ "path": "/tmp/proj/src/lib.rs", "bytes_changed": 10 }),
            ),
        ];
        lines.extend_from_slice(extra_events);
        lines.join("\n")
    }

    // -----------------------------------------------------------------------

    #[test]
    fn files_changed_populated_from_file_changed_events() {
        let dir = TempDir::new().unwrap();
        let log = sample_log(&[]);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert_eq!(
            cp.files_changed,
            vec!["/tmp/proj/src/main.rs", "/tmp/proj/src/lib.rs"]
        );
    }

    #[test]
    fn completed_actions_are_deduplicated_in_order() {
        let dir = TempDir::new().unwrap();
        // Add two more read_file completions and one edit_file
        let extra = vec![
            make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "edit_file", "call_id": "c2" }),
            ),
            make_event(
                "tool_call_completed",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "edit_file", "call_id": "c2", "duration_ms": 5, "cache_hit": false, "summary": "edited" }),
            ),
            make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "read_file", "call_id": "c3" }),
            ),
            make_event(
                "tool_call_completed",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "read_file", "call_id": "c3", "duration_ms": 5, "cache_hit": false, "summary": "read again" }),
            ),
        ];
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        // read_file first (appeared first), edit_file second — no duplicates
        assert_eq!(cp.completed_actions, vec!["read_file", "edit_file"]);
    }

    #[test]
    fn next_action_set_when_tool_incomplete() {
        let dir = TempDir::new().unwrap();
        // A tool that was started but never completed
        let extra = vec![make_event(
            "tool_call_started",
            "loop-test",
            1,
            serde_json::json!({ "tool_name": "run_command", "call_id": "c99" }),
        )];
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert_eq!(cp.next_action, "run_command");
    }

    #[test]
    fn next_action_empty_when_all_tools_completed() {
        let dir = TempDir::new().unwrap();
        let log = sample_log(&[make_event(
            "run_completed",
            "loop-test",
            1,
            serde_json::json!({ "status": "complete" }),
        )]);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert_eq!(cp.next_action, "");
        assert_eq!(cp.current_stage, "complete");
    }

    #[test]
    fn do_not_repeat_includes_hung_and_repeated_tools() {
        let dir = TempDir::new().unwrap();
        // run_command started 4 times, never completed => hung
        // edit_file completed 3 times => repeated
        let mut extra = Vec::new();
        for i in 0..4_u32 {
            extra.push(make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "run_command", "call_id": format!("hung-{i}") }),
            ));
        }
        for i in 0..3_u32 {
            let cid = format!("ef-{i}");
            extra.push(make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "edit_file", "call_id": cid }),
            ));
            extra.push(make_event(
                "tool_call_completed",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "edit_file", "call_id": cid, "duration_ms": 1, "cache_hit": false, "summary": "ok" }),
            ));
        }
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert!(cp.do_not_repeat.contains(&"run_command".to_string()));
        assert!(cp.do_not_repeat.contains(&"edit_file".to_string()));
    }

    #[test]
    fn risks_extracted_from_error_keywords() {
        let dir = TempDir::new().unwrap();
        let extra = vec![
            make_event(
                "error_recorded",
                "loop-test",
                1,
                serde_json::json!({ "message": "permission denied writing /etc/hosts" }),
            ),
            make_event(
                "error_recorded",
                "loop-test",
                1,
                serde_json::json!({ "message": "operation timeout after 30s" }),
            ),
            make_event(
                "error_recorded",
                "loop-test",
                1,
                serde_json::json!({ "message": "all good here" }),
            ),
        ];
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        // Both risk errors should appear; benign one should not
        assert!(cp.risks.iter().any(|r| r.contains("permission denied")));
        assert!(cp.risks.iter().any(|r| r.contains("timeout")));
        assert!(!cp.risks.iter().any(|r| r.contains("all good")));
    }

    #[test]
    fn missing_log_returns_default_checkpoint() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.jsonl");

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert!(cp.loop_id.is_empty());
        assert!(cp.files_changed.is_empty());
    }

    #[test]
    fn build_and_write_produces_valid_json_file() {
        let dir = TempDir::new().unwrap();
        // Create the JSONL log manually at the expected path.
        let loops_dir = dir.path().join("loops").join("loop-bw").join("");
        std::fs::create_dir_all(&loops_dir).unwrap();
        let log_path = loops_dir.join("run_2.jsonl");
        let mut f = std::fs::File::create(&log_path).unwrap();
        let line = make_event(
            "run_started",
            "loop-bw",
            2,
            serde_json::json!({ "project_dir": "/proj", "goal": "test", "max_runs": 1 }),
        );
        writeln!(f, "{line}").unwrap();
        let line2 = make_event(
            "run_completed",
            "loop-bw",
            2,
            serde_json::json!({ "status": "complete" }),
        );
        writeln!(f, "{line2}").unwrap();
        drop(f);

        let out = build_and_write_checkpoint("loop-bw", 2, dir.path()).unwrap();

        assert!(out.exists());
        let content = std::fs::read_to_string(&out).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["loop_id"], "loop-bw");
        assert_eq!(parsed["current_stage"], "complete");
        assert_eq!(parsed["project_dir"], "/proj");
    }

    #[test]
    fn verification_results_captured() {
        let dir = TempDir::new().unwrap();
        let extra = vec![make_event(
            "verification_completed",
            "loop-test",
            1,
            serde_json::json!({ "command": "cargo check --lib", "success": true }),
        )];
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert_eq!(cp.verification.len(), 1);
        assert_eq!(cp.verification[0].command, "cargo check --lib");
        assert!(cp.verification[0].success);
    }

    #[test]
    fn tool_results_capped_at_five_most_recent() {
        let dir = TempDir::new().unwrap();
        let mut extra = Vec::new();
        for i in 0..8_u32 {
            let cid = format!("tr-{i}");
            extra.push(make_event(
                "tool_call_started",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "some_tool", "call_id": cid }),
            ));
            extra.push(make_event(
                "tool_call_completed",
                "loop-test",
                1,
                serde_json::json!({ "tool_name": "some_tool", "call_id": cid, "duration_ms": 1, "cache_hit": false, "summary": format!("result-{i}") }),
            ));
        }
        let log = sample_log(&extra);
        let path = write_jsonl(&dir, &log);

        let cp = CheckpointBuilder::build_from_log(&path).unwrap();

        assert_eq!(cp.tool_results.len(), 5);
        // Most recent first → result-7 should be first
        assert_eq!(cp.tool_results[0].summary, "result-7");
    }
}
