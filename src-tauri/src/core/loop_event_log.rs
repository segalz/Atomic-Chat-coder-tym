//! Append-only JSONL event log for loop supervision runs.
//!
//! Each run writes to:
//!   `{base_dir}/loops/{loop_id}/run_{run_number}.jsonl`
//!
//! One JSON object per line, each with `ts`, `event`, `loop_id`, `run`, and `payload`.
//! If the file cannot be opened, logging is silently skipped so the agent is never blocked.

use chrono::Utc;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

const SUMMARY_BYTES: usize = 200;
const ERROR_BYTES: usize = 300;

pub struct LoopEventLog {
    loop_id: String,
    run_number: u32,
    file: BufWriter<File>,
}

impl LoopEventLog {
    /// Open (or create) the JSONL log file for a specific run.
    ///
    /// Creates all intermediate directories. Returns `None` (with a warning) if any
    /// IO operation fails so callers can treat the log as optional.
    pub fn open(loop_id: &str, run_number: u32, base_dir: &Path) -> Option<Self> {
        let dir = base_dir.join("loops").join(loop_id);
        if let Err(err) = fs::create_dir_all(&dir) {
            log::warn!("[LoopEventLog] Cannot create log dir {dir:?}: {err}");
            return None;
        }

        let path: PathBuf = dir.join(format!("run_{run_number}.jsonl"));
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => Some(Self {
                loop_id: loop_id.to_string(),
                run_number,
                file: BufWriter::new(file),
            }),
            Err(err) => {
                log::warn!("[LoopEventLog] Cannot open log file {path:?}: {err}");
                None
            }
        }
    }

    /// Append a single JSONL event and flush.
    fn append(&mut self, event_type: &str, payload: serde_json::Value) {
        let entry = serde_json::json!({
            "ts": Utc::now().to_rfc3339(),
            "event": event_type,
            "loop_id": self.loop_id,
            "run": self.run_number,
            "payload": payload,
        });

        let mut line = match serde_json::to_string(&entry) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("[LoopEventLog] Serialize failed for event {event_type}: {err}");
                return;
            }
        };
        line.push('\n');

        if let Err(err) = self.file.write_all(line.as_bytes()) {
            log::warn!("[LoopEventLog] Write failed for event {event_type}: {err}");
            return;
        }
        if let Err(err) = self.file.flush() {
            log::warn!("[LoopEventLog] Flush failed for event {event_type}: {err}");
        }
    }

    pub fn log_run_started(&mut self, project_dir: &str, goal: &str, max_runs: u32) {
        self.append(
            "run_started",
            serde_json::json!({ "project_dir": project_dir, "goal": goal, "max_runs": max_runs }),
        );
    }

    pub fn log_run_completed(&mut self, status: &str) {
        self.append("run_completed", serde_json::json!({ "status": status }));
    }

    pub fn log_run_failed(&mut self, reason: &str) {
        let reason = truncate_str(reason, ERROR_BYTES);
        self.append("run_failed", serde_json::json!({ "reason": reason }));
    }

    pub fn log_tool_call_started(&mut self, tool_name: &str, call_id: &str) {
        self.append(
            "tool_call_started",
            serde_json::json!({ "tool_name": tool_name, "call_id": call_id }),
        );
    }

    pub fn log_tool_call_completed(
        &mut self,
        tool_name: &str,
        call_id: &str,
        duration_ms: u128,
        cache_hit: bool,
        result_summary: &str,
    ) {
        let summary = truncate_str(result_summary, SUMMARY_BYTES);
        self.append(
            "tool_call_completed",
            serde_json::json!({
                "tool_name": tool_name,
                "call_id": call_id,
                "duration_ms": duration_ms,
                "cache_hit": cache_hit,
                "summary": summary,
            }),
        );
    }

    pub fn log_file_changed(&mut self, path: &str, bytes_changed: usize) {
        self.append(
            "file_changed",
            serde_json::json!({ "path": path, "bytes_changed": bytes_changed }),
        );
    }

    pub fn log_error(&mut self, message: &str) {
        let message = truncate_str(message, ERROR_BYTES);
        self.append("error_recorded", serde_json::json!({ "message": message }));
    }

    pub fn log_context_percent(&mut self, percent: u8) {
        self.append(
            "context_percent_updated",
            serde_json::json!({ "percent": percent }),
        );
    }

    pub fn log_verification_completed(&mut self, command: &str, success: bool) {
        self.append(
            "verification_completed",
            serde_json::json!({ "command": command, "success": success }),
        );
    }
}

/// Truncate a string to at most `max_bytes` bytes on a char boundary.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::TempDir;

    fn read_log(dir: &TempDir, loop_id: &str, run: u32) -> String {
        let path = dir
            .path()
            .join("loops")
            .join(loop_id)
            .join(format!("run_{run}.jsonl"));
        let mut content = String::new();
        File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        content
    }

    #[test]
    fn writes_run_started_event() {
        let dir = TempDir::new().unwrap();
        let mut log = LoopEventLog::open("loop-abc", 1, dir.path()).unwrap();
        log.log_run_started("/tmp/proj", "fix the bug", 1);

        let content = read_log(&dir, "loop-abc", 1);
        let line: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(line["event"], "run_started");
        assert_eq!(line["loop_id"], "loop-abc");
        assert_eq!(line["run"], 1);
        assert_eq!(line["payload"]["project_dir"], "/tmp/proj");
        assert_eq!(line["payload"]["goal"], "fix the bug");
    }

    #[test]
    fn truncates_long_error() {
        let dir = TempDir::new().unwrap();
        let mut log = LoopEventLog::open("loop-abc", 2, dir.path()).unwrap();
        let long_msg = "x".repeat(500);
        log.log_error(&long_msg);

        let content = read_log(&dir, "loop-abc", 2);
        let line: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        let msg = line["payload"]["message"].as_str().unwrap();
        assert_eq!(msg.len(), ERROR_BYTES);
    }

    #[test]
    fn appends_multiple_events() {
        let dir = TempDir::new().unwrap();
        let mut log = LoopEventLog::open("loop-def", 3, dir.path()).unwrap();
        log.log_run_started("/tmp/proj", "goal", 1);
        log.log_tool_call_started("edit_file", "call-1");
        log.log_tool_call_completed("edit_file", "call-1", 42, false, "done");
        log.log_run_completed("complete");

        let content = read_log(&dir, "loop-def", 3);
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 4);
        let events: Vec<String> = lines
            .iter()
            .map(|line| {
                let v: serde_json::Value = serde_json::from_str(line).unwrap();
                v["event"].as_str().unwrap().to_owned()
            })
            .collect();
        assert_eq!(
            events,
            [
                "run_started",
                "tool_call_started",
                "tool_call_completed",
                "run_completed"
            ]
        );
    }
}
