use crate::core::loop_checkpoint::{
    build_and_write_checkpoint, build_resume_prompt, LoopCheckpoint,
};
use crate::core::loop_event_log::LoopEventLog;
use crate::core::loop_store::{
    LoopDurableStatus, LoopEventRecord, LoopSessionRecord, LoopStoreState, LoopToolCallRecord,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

const MAX_PROGRESS_EVENTS: usize = 50;
const MAX_TOOL_TRACES: usize = 80;
const MAX_LAST_ERRORS: usize = 10;
const DEFAULT_PROGRESS_LIMIT: usize = 25;
const MAX_PROGRESS_LIMIT: usize = 50;
const DEFAULT_ERROR_LIMIT: usize = 5;
const MAX_ERROR_LIMIT: usize = 10;
const DEFAULT_DIFF_BYTES: usize = 16 * 1024;
const MAX_DIFF_BYTES: usize = 64 * 1024;
const DEFAULT_DIFF_PATHS: usize = 25;
const MAX_DIFF_PATHS: usize = 100;
const PREVIEW_BYTES: usize = 512;
const DEFAULT_EVIDENCE_BYTE_CAP: usize = 24 * 1024;
const MAX_EVIDENCE_BYTE_CAP: usize = 64 * 1024;
const EVIDENCE_PROGRESS_LIMIT: usize = 10;
const EVIDENCE_ERROR_LIMIT: usize = 5;
const EVIDENCE_CHANGED_PATH_LIMIT: usize = 25;
const DEFAULT_AUDIT_MAX_DIFF_BYTES: usize = 32 * 1024;
const DEFAULT_AUDIT_MAX_CHANGED_PATHS: usize = 25;
const REPEATED_ERROR_THRESHOLD: usize = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoopSupervisionStatus {
    Idle,
    Running,
    Checkpointing,
    ResumingSameRun,
    Paused,
    WaitingApproval,
    Failed,
    Complete,
    Stopped,
}

impl Default for LoopSupervisionStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopSupervisionLimits {
    pub max_iterations: u32,
    pub max_diff_bytes: usize,
    pub max_changed_paths: usize,
    pub audit_interval_runs: u32,
}

impl Default for LoopSupervisionLimits {
    fn default() -> Self {
        Self {
            max_iterations: 40,
            max_diff_bytes: DEFAULT_AUDIT_MAX_DIFF_BYTES,
            max_changed_paths: DEFAULT_AUDIT_MAX_CHANGED_PATHS,
            audit_interval_runs: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoopPauseMode {
    AfterCurrentRun,
    Immediate,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopProgressEvent {
    pub step: String,
    pub message: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopDiffEntry {
    pub path: String,
    pub operation: String,
    pub search_preview: Option<String>,
    pub replace_preview: Option<String>,
    pub bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopBuildTestFailure {
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub output_preview: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopToolTrace {
    pub call_id: String,
    pub name: String,
    pub arguments_summary: String,
    pub call_signature: String,
    pub result_signature: Option<String>,
    pub result_bytes: Option<usize>,
    pub elapsed_ms: Option<u128>,
    pub cache_hit: bool,
    pub is_error: bool,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopSupervisionSnapshot {
    pub run_id: Option<String>,
    pub source: String,
    pub project_dir: Option<String>,
    pub status: LoopSupervisionStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub current_run: u32,
    pub max_runs: u32,
    pub last_step: Option<String>,
    pub last_errors: Vec<String>,
    pub changed_paths: Vec<String>,
    pub progress_events: Vec<LoopProgressEvent>,
    pub diff_entries: Vec<LoopDiffEntry>,
    pub build_test_failures: Vec<LoopBuildTestFailure>,
    pub tool_traces: Vec<LoopToolTrace>,
    pub risk_flags: Vec<String>,
    pub pause_requested: bool,
    pub stop_requested: bool,
    pub limits: LoopSupervisionLimits,
}

impl Default for LoopSupervisionSnapshot {
    fn default() -> Self {
        Self {
            run_id: None,
            source: "loop".to_string(),
            project_dir: None,
            status: LoopSupervisionStatus::Idle,
            started_at: None,
            updated_at: None,
            current_run: 0,
            max_runs: 0,
            last_step: None,
            last_errors: Vec::new(),
            changed_paths: Vec::new(),
            progress_events: Vec::new(),
            diff_entries: Vec::new(),
            build_test_failures: Vec::new(),
            tool_traces: Vec::new(),
            risk_flags: Vec::new(),
            pause_requested: false,
            stop_requested: false,
            limits: LoopSupervisionLimits::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopStatusResponse {
    pub run_id: Option<String>,
    pub status: LoopSupervisionStatus,
    pub project_dir: Option<String>,
    pub source: String,
    pub current_run: u32,
    pub max_runs: u32,
    pub last_step: Option<String>,
    pub risk_flags: Vec<String>,
    pub pause_requested: bool,
    pub stop_requested: bool,
    pub next_action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopProgressResponse {
    pub run_id: Option<String>,
    pub status: LoopSupervisionStatus,
    pub current_run: u32,
    pub max_runs: u32,
    pub events: Vec<LoopProgressEvent>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopDiffResponse {
    pub run_id: Option<String>,
    pub changed_paths: Vec<String>,
    pub entries: Vec<LoopDiffEntry>,
    pub total_changed_paths: usize,
    pub total_entries: usize,
    pub truncated: bool,
    pub byte_cap: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopErrorsResponse {
    pub run_id: Option<String>,
    pub errors: Vec<String>,
    pub total_errors: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopAuditResponse {
    pub run_id: Option<String>,
    pub status: LoopSupervisionStatus,
    pub risk_flags: Vec<String>,
    pub findings: Vec<String>,
    pub next_action: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoopEscalationRecommendation {
    Continue,
    Pause,
    Stop,
    ApproveNextStage,
    RequestMoreEvidence,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopDiffStats {
    pub total_changed_paths: usize,
    pub total_entries: usize,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopSupervisorEvidence {
    pub run_id: Option<String>,
    pub status: LoopSupervisionStatus,
    pub project_dir: Option<String>,
    pub current_run: u32,
    pub max_runs: u32,
    pub triggered_guardrails: Vec<String>,
    pub audit_findings: Vec<String>,
    pub last_errors: Vec<String>,
    pub changed_paths: Vec<String>,
    pub diff_stats: LoopDiffStats,
    pub latest_build_test_failure: Option<LoopBuildTestFailure>,
    pub progress_tail: Vec<LoopProgressEvent>,
    pub evidence_preview: String,
    pub byte_cap: usize,
    pub truncated: bool,
    pub recommendation: LoopEscalationRecommendation,
    pub next_action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopControlResponse {
    pub run_id: Option<String>,
    pub status: LoopSupervisionStatus,
    pub pause_requested: bool,
    pub stop_requested: bool,
    pub limits: LoopSupervisionLimits,
    pub next_action: String,
}

#[derive(Clone)]
pub struct LoopSupervisionState {
    snapshot: Arc<Mutex<LoopSupervisionSnapshot>>,
    /// Optional directory under which `loops/{loop_id}/run_{n}.jsonl` files are written.
    base_dir: Option<PathBuf>,
    /// Optional SQLite-backed store for durable loop lifecycle state.
    store: Option<LoopStoreState>,
    /// Active event log for the current run, guarded separately so the snapshot stays Clone.
    event_log: Arc<Mutex<Option<LoopEventLog>>>,
}

impl Default for LoopSupervisionState {
    fn default() -> Self {
        Self {
            snapshot: Arc::new(Mutex::new(LoopSupervisionSnapshot::default())),
            base_dir: None,
            store: None,
            event_log: Arc::new(Mutex::new(None)),
        }
    }
}

impl LoopSupervisionState {
    /// Create a state that will write event logs under `base_dir`.
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        let store = LoopStoreState::new(base_dir.clone());
        Self {
            base_dir: Some(base_dir),
            store: Some(store),
            ..Self::default()
        }
    }

    pub fn base_dir(&self) -> Option<&Path> {
        self.base_dir.as_deref()
    }

    pub fn store(&self) -> Option<&LoopStoreState> {
        self.store.as_ref()
    }

    async fn persist_session(&self, prompt: Option<String>, last_error: Option<String>) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let snapshot = self.snapshot().await;
        let Some(record) = session_record_from_snapshot(&snapshot, prompt, last_error) else {
            return;
        };
        if let Err(err) = store.upsert_session(record).await {
            log::warn!("[LoopSupervision] durable session write failed: {err}");
        }
    }

    async fn persist_event(
        &self,
        event_type: impl Into<String>,
        payload: Value,
        idempotency_key: Option<String>,
    ) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let snapshot = self.snapshot().await;
        let Some(loop_id) = snapshot.run_id.clone() else {
            return;
        };

        if let Some(record) = session_record_from_snapshot(&snapshot, None, None) {
            if let Err(err) = store.upsert_session(record).await {
                log::warn!("[LoopSupervision] durable session refresh failed: {err}");
            }
        }

        let event_type = event_type.into();
        let record = LoopEventRecord {
            loop_id,
            run_number: snapshot.current_run,
            event_type,
            payload,
            idempotency_key,
        };
        if let Err(err) = store.append_event(record).await {
            log::warn!("[LoopSupervision] durable event write failed: {err}");
        }
    }

    async fn persist_tool_call(&self, record: LoopToolCallRecord) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        if let Err(err) = store.upsert_tool_call(record).await {
            log::warn!("[LoopSupervision] durable tool call write failed: {err}");
        }
    }
}

impl LoopSupervisionState {
    /// `loop_id` should be a stable identifier shared across all runs of the same loop session.
    /// If `None`, a fresh UUID is generated (non-loop / standalone runs).
    pub async fn begin_run(
        &self,
        project_dir: String,
        goal: String,
        current_run: u32,
        max_runs: u32,
        loop_id: Option<String>,
    ) {
        let now = Utc::now();
        let run_id = loop_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let goal_for_store = goal.clone();
        let mut snapshot = self.snapshot.lock().await;
        *snapshot = LoopSupervisionSnapshot {
            run_id: Some(run_id.clone()),
            source: "loop".to_string(),
            project_dir: Some(project_dir.clone()),
            status: LoopSupervisionStatus::Running,
            started_at: Some(now),
            updated_at: Some(now),
            current_run,
            max_runs,
            last_step: Some("started".to_string()),
            last_errors: Vec::new(),
            changed_paths: Vec::new(),
            progress_events: vec![LoopProgressEvent {
                step: "started".to_string(),
                message: None,
                timestamp: now,
            }],
            diff_entries: Vec::new(),
            build_test_failures: Vec::new(),
            tool_traces: Vec::new(),
            risk_flags: Vec::new(),
            pause_requested: false,
            stop_requested: false,
            limits: LoopSupervisionLimits::default(),
        };
        drop(snapshot);

        // Open a fresh event log for this run (best-effort; failure is non-fatal).
        let mut event_log = self.event_log.lock().await;
        *event_log = self
            .base_dir
            .as_deref()
            .and_then(|base| LoopEventLog::open(&run_id, current_run, base));
        if let Some(log) = event_log.as_mut() {
            log.log_run_started(&project_dir, &goal, max_runs);
        }

        self.persist_session(Some(goal_for_store.clone()), None)
            .await;
        self.persist_event(
            "run_started",
            serde_json::json!({
                "project_dir": project_dir,
                "goal": goal_for_store,
                "current_run": current_run,
                "max_runs": max_runs
            }),
            Some(format!("{run_id}:{current_run}:run_started")),
        )
        .await;
    }

    pub async fn record_step(&self, step: impl Into<String>) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Running {
            let step = step.into();
            snapshot.last_step = Some(step.clone());
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, step, None, now);
        }
        drop(snapshot);
        self.persist_event(
            "progress_step",
            serde_json::json!({ "step": self.snapshot().await.last_step }),
            None,
        )
        .await;
    }

    pub async fn record_tool_start(
        &self,
        call_id: impl Into<String>,
        name: impl Into<String>,
        arguments_summary: impl Into<String>,
        call_signature: impl Into<String>,
    ) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }

        let now = Utc::now();
        let trace = LoopToolTrace {
            call_id: call_id.into(),
            name: name.into(),
            arguments_summary: arguments_summary.into(),
            call_signature: call_signature.into(),
            result_signature: None,
            result_bytes: None,
            elapsed_ms: None,
            cache_hit: false,
            is_error: false,
            timestamp: now,
        };
        let message = format!("{} {}", trace.name, trace.arguments_summary);
        let step = format!("tool_start:{}", trace.name);
        snapshot.last_step = Some(step.clone());
        snapshot.updated_at = Some(now);
        let tool_name = trace.name.clone();
        let call_id_str = trace.call_id.clone();
        let arguments_summary_str = trace.arguments_summary.clone();
        let call_signature_str = trace.call_signature.clone();
        snapshot.tool_traces.push(trace);
        trim_front(&mut snapshot.tool_traces, MAX_TOOL_TRACES);
        push_progress_event(&mut snapshot, step, Some(message), now);
        drop(snapshot);

        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_tool_call_started(&tool_name, &call_id_str);
        }
        let snapshot = self.snapshot().await;
        if let Some(loop_id) = snapshot.run_id.clone() {
            self.persist_tool_call(LoopToolCallRecord {
                call_id: call_id_str.clone(),
                loop_id: loop_id.clone(),
                run_number: snapshot.current_run,
                tool_name: tool_name.clone(),
                status: "started".to_string(),
                args_summary: Some(arguments_summary_str.clone()),
                result_signature: None,
                elapsed_ms: None,
                is_error: false,
            })
            .await;
            self.persist_event(
                "tool_call_started",
                serde_json::json!({
                    "tool_name": tool_name,
                    "call_id": call_id_str,
                    "arguments_summary": arguments_summary_str,
                    "call_signature": call_signature_str
                }),
                Some(format!(
                    "{loop_id}:{}:{call_id_str}:tool_started",
                    snapshot.current_run
                )),
            )
            .await;
        }
    }

    pub async fn record_tool_result(
        &self,
        call_id: impl AsRef<str>,
        result_signature: impl Into<String>,
        result_bytes: usize,
        elapsed_ms: u128,
        cache_hit: bool,
        is_error: bool,
    ) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }

        let call_id = call_id.as_ref();
        let result_signature = result_signature.into();
        let now = Utc::now();
        let mut tool_name = String::new();
        if let Some(trace) = snapshot
            .tool_traces
            .iter_mut()
            .rev()
            .find(|trace| trace.call_id == call_id)
        {
            tool_name = trace.name.clone();
            trace.result_signature = Some(result_signature.clone());
            trace.result_bytes = Some(result_bytes);
            trace.elapsed_ms = Some(elapsed_ms);
            trace.cache_hit = cache_hit;
            trace.is_error = is_error;
        }
        snapshot.updated_at = Some(now);
        push_progress_event(
            &mut snapshot,
            "tool_result".to_string(),
            Some(format!(
                "call_id={call_id} bytes={result_bytes} elapsed_ms={elapsed_ms} cache_hit={cache_hit} is_error={is_error}"
            )),
            now,
        );
        let call_id_owned = call_id.to_string();
        drop(snapshot);

        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_tool_call_completed(
                &tool_name,
                &call_id_owned,
                elapsed_ms,
                cache_hit,
                &result_signature,
            );
        }
        let snapshot = self.snapshot().await;
        if let Some(loop_id) = snapshot.run_id.clone() {
            self.persist_tool_call(LoopToolCallRecord {
                call_id: call_id_owned.clone(),
                loop_id: loop_id.clone(),
                run_number: snapshot.current_run,
                tool_name: tool_name.clone(),
                status: "completed".to_string(),
                args_summary: None,
                result_signature: Some(result_signature.clone()),
                elapsed_ms: Some(elapsed_ms),
                is_error,
            })
            .await;
            self.persist_event(
                "tool_call_completed",
                serde_json::json!({
                    "tool_name": tool_name,
                    "call_id": call_id_owned,
                    "duration_ms": elapsed_ms,
                    "cache_hit": cache_hit,
                    "is_error": is_error,
                    "result_signature": result_signature,
                    "result_bytes": result_bytes
                }),
                Some(format!(
                    "{loop_id}:{}:{call_id}:tool_completed",
                    snapshot.current_run
                )),
            )
            .await;
        }
    }

    pub async fn record_error(&self, error: impl Into<String>) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }
        let error = error.into();
        snapshot.last_errors.push(error.clone());
        trim_front(&mut snapshot.last_errors, MAX_LAST_ERRORS);
        apply_error_risk_flags(&mut snapshot);
        snapshot.last_step = Some("error".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "error".to_string(), Some(error.clone()), now);
        drop(snapshot);

        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_error(&error);
        }
        self.persist_event(
            "error_recorded",
            serde_json::json!({ "message": error }),
            None,
        )
        .await;
    }

    pub async fn record_changed_path(&self, path: impl Into<String>) {
        let path = path.into();
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }
        if !snapshot
            .changed_paths
            .iter()
            .any(|existing| existing == &path)
        {
            snapshot.changed_paths.push(path.clone());
        }
        snapshot.last_step = Some("file_change".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "file_change".to_string(), None, now);
        drop(snapshot);

        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_file_changed(&path, 0);
        }
        self.persist_event(
            "file_changed",
            serde_json::json!({ "path": path, "bytes_changed": 0 }),
            None,
        )
        .await;
    }

    pub async fn record_diff(
        &self,
        path: impl Into<String>,
        operation: impl Into<String>,
        search: Option<String>,
        replace: Option<String>,
    ) {
        let path = path.into();
        let operation = operation.into();
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }
        if !snapshot
            .changed_paths
            .iter()
            .any(|existing| existing == &path)
        {
            snapshot.changed_paths.push(path.clone());
        }

        snapshot.diff_entries.push(build_diff_entry(
            path.clone(),
            operation.clone(),
            search.as_deref(),
            replace.as_deref(),
        ));
        apply_diff_risk_flags(&mut snapshot);
        snapshot.last_step = Some("file_change".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "file_change".to_string(), None, now);
        drop(snapshot);
        self.persist_event(
            "diff_recorded",
            serde_json::json!({
                "path": path,
                "operation": operation,
                "search_bytes": search.as_ref().map_or(0, |value| value.len()),
                "replace_bytes": replace.as_ref().map_or(0, |value| value.len())
            }),
            None,
        )
        .await;
    }

    pub async fn record_build_test_failure(
        &self,
        command: impl Into<String>,
        cwd: impl Into<String>,
        exit_code: Option<i32>,
        output: impl AsRef<str>,
    ) {
        let command = command.into();
        let cwd = cwd.into();
        let output_preview = preview_text(output.as_ref());
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }

        let now = Utc::now();
        snapshot.risk_flags.push("build_test_failed".to_string());
        dedupe_strings(&mut snapshot.risk_flags);
        snapshot.build_test_failures.push(LoopBuildTestFailure {
            command: command.clone(),
            cwd: cwd.clone(),
            exit_code,
            output_preview: output_preview.clone(),
            timestamp: now,
        });
        trim_front(&mut snapshot.build_test_failures, MAX_LAST_ERRORS);
        snapshot.last_step = Some("build_test_failed".to_string());
        snapshot.updated_at = Some(now);
        push_progress_event(
            &mut snapshot,
            "build_test_failed".to_string(),
            Some(format!("exit_code={:?}", exit_code)),
            now,
        );
        drop(snapshot);
        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_verification_completed(&command, false);
        }
        self.persist_event(
            "verification_completed",
            serde_json::json!({
                "command": command,
                "cwd": cwd,
                "success": false,
                "exit_code": exit_code,
                "output_preview": output_preview
            }),
            None,
        )
        .await;
    }

    pub async fn record_path_rejection(&self, path: impl Into<String>, reason: impl Into<String>) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }

        let path = path.into();
        let reason = reason.into();
        push_unique_string(&mut snapshot.risk_flags, "path_outside_project".to_string());
        let error = format!("Rejected file edit outside project scope: {path} ({reason})");
        snapshot.last_errors.push(error.clone());
        trim_front(&mut snapshot.last_errors, MAX_LAST_ERRORS);
        snapshot.last_step = Some("path_rejected".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "path_rejected".to_string(), Some(error), now);
        drop(snapshot);
        self.persist_event(
            "path_rejected",
            serde_json::json!({ "path": path, "reason": reason }),
            None,
        )
        .await;
    }

    pub async fn finish_run(&self, success: bool, stopped: bool, error: Option<String>) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Idle {
            return;
        }
        let fail_reason = error.clone();
        if let Some(error) = error {
            snapshot.last_errors.push(error);
            trim_front(&mut snapshot.last_errors, MAX_LAST_ERRORS);
        }
        snapshot.status = if stopped || snapshot.stop_requested {
            LoopSupervisionStatus::Stopped
        } else if snapshot.pause_requested {
            LoopSupervisionStatus::Paused
        } else if success {
            LoopSupervisionStatus::Complete
        } else {
            LoopSupervisionStatus::Failed
        };
        let final_status = snapshot.status.clone();
        let run_id = snapshot.run_id.clone();
        let current_run = snapshot.current_run;
        snapshot.last_step = Some("done".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "done".to_string(), None, now);
        drop(snapshot);

        self.persist_session(None, fail_reason.clone()).await;
        let event_type = match &final_status {
            LoopSupervisionStatus::Complete => "run_completed",
            LoopSupervisionStatus::Failed => "run_failed",
            LoopSupervisionStatus::Stopped => "loop_stopped",
            LoopSupervisionStatus::Paused => "suspended",
            _ => "run_finished",
        };
        self.persist_event(
            event_type,
            serde_json::json!({
                "status": status_label(&final_status),
                "success": success,
                "stopped": stopped,
                "error": fail_reason.clone()
            }),
            run_id
                .as_ref()
                .map(|loop_id| format!("{loop_id}:{current_run}:{event_type}")),
        )
        .await;

        if let Some(log) = self.event_log.lock().await.as_mut() {
            let status_str = match &final_status {
                LoopSupervisionStatus::Complete => "complete",
                LoopSupervisionStatus::Failed => "failed",
                LoopSupervisionStatus::Stopped => "stopped",
                LoopSupervisionStatus::Paused => "paused",
                other => {
                    let _ = other;
                    "unknown"
                }
            };
            if matches!(
                final_status,
                LoopSupervisionStatus::Failed | LoopSupervisionStatus::Stopped
            ) {
                log.log_run_failed(fail_reason.as_deref().unwrap_or(status_str));
            } else {
                log.log_run_completed(status_str);
            }
        }

        // Build and write a deterministic checkpoint from the event log (fire-and-forget).
        if let (Some(loop_id), Some(base_dir)) = (run_id, self.base_dir.as_deref()) {
            let base_dir = base_dir.to_path_buf();
            match build_and_write_checkpoint(&loop_id, current_run, &base_dir) {
                Ok(path) => {
                    self.persist_event(
                        "checkpoint_written",
                        serde_json::json!({
                            "path": path.display().to_string(),
                            "run_number": current_run
                        }),
                        Some(format!("{loop_id}:{current_run}:checkpoint_written")),
                    )
                    .await;
                    if let Some(store) = self.store.as_ref() {
                        match std::fs::read_to_string(&path) {
                            Ok(checkpoint_json) => {
                                let resume_prompt = serde_json::from_str::<LoopCheckpoint>(
                                    &checkpoint_json,
                                )
                                .map(|checkpoint| build_resume_prompt(&checkpoint))
                                .unwrap_or_default();
                                if let Err(err) = store
                                    .store_checkpoint(
                                        &loop_id,
                                        current_run,
                                        checkpoint_json,
                                        resume_prompt,
                                        None,
                                    )
                                    .await
                                {
                                    log::warn!(
                                        "[LoopSupervision] durable checkpoint write failed: {err}"
                                    );
                                }
                            }
                            Err(err) => log::warn!(
                                "[LoopSupervision] checkpoint readback failed for {loop_id} run {current_run}: {err}"
                            ),
                        }
                    }
                }
                Err(err) => {
                    log::warn!("[LoopSupervision] checkpoint write failed for {loop_id} run {current_run}: {err}");
                }
            }
        }
    }

    pub async fn request_pause(&self, mode: LoopPauseMode) -> LoopControlResponse {
        let mut snapshot = self.snapshot.lock().await;
        let mode_for_event = mode.clone();
        if snapshot.status != LoopSupervisionStatus::Idle
            && snapshot.status != LoopSupervisionStatus::Stopped
            && snapshot.status != LoopSupervisionStatus::Complete
        {
            snapshot.pause_requested = true;
            if mode == LoopPauseMode::Immediate {
                snapshot.status = LoopSupervisionStatus::Paused;
            }
            snapshot.last_step = Some(match mode {
                LoopPauseMode::AfterCurrentRun => "pause_requested_after_current_run".to_string(),
                LoopPauseMode::Immediate => "pause_requested_immediate".to_string(),
            });
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            let step = snapshot
                .last_step
                .clone()
                .unwrap_or_else(|| "pause_requested".to_string());
            push_progress_event(&mut snapshot, step, None, now);
        }
        let response = build_control_response(&snapshot);
        drop(snapshot);
        self.persist_event(
            "pause_requested",
            serde_json::json!({ "mode": mode_label(&mode_for_event) }),
            None,
        )
        .await;
        response
    }

    pub async fn resume(&self) -> LoopControlResponse {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Paused
            || snapshot.status == LoopSupervisionStatus::WaitingApproval
            || snapshot.pause_requested
        {
            snapshot.pause_requested = false;
            snapshot.stop_requested = false;
            snapshot.status = LoopSupervisionStatus::Running;
            snapshot.last_step = Some("resumed".to_string());
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, "resumed".to_string(), None, now);
        }
        let response = build_control_response(&snapshot);
        drop(snapshot);
        self.persist_event("resume_requested", serde_json::json!({}), None)
            .await;
        response
    }

    pub async fn mark_stop_requested(&self) {
        let mut snapshot = self.snapshot.lock().await;
        if !matches!(
            snapshot.status,
            LoopSupervisionStatus::Running
                | LoopSupervisionStatus::Paused
                | LoopSupervisionStatus::WaitingApproval
        ) {
            return;
        }
        snapshot.stop_requested = true;
        snapshot.last_step = Some("stop_requested".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "stop_requested".to_string(), None, now);
        drop(snapshot);
        self.persist_event("stop_requested", serde_json::json!({}), None)
            .await;
    }

    pub async fn request_stop(&self) -> LoopControlResponse {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status != LoopSupervisionStatus::Idle {
            snapshot.stop_requested = true;
            snapshot.pause_requested = false;
            snapshot.status = LoopSupervisionStatus::Stopped;
            snapshot.last_step = Some("stop_requested".to_string());
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, "stop_requested".to_string(), None, now);
        }
        let response = build_control_response(&snapshot);
        drop(snapshot);
        self.persist_event("loop_stopped", serde_json::json!({}), None)
            .await;
        response
    }

    pub async fn approve_next_stage(&self) -> LoopControlResponse {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::WaitingApproval {
            snapshot.status = LoopSupervisionStatus::Running;
        }
        snapshot.last_step = Some("next_stage_approved".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "next_stage_approved".to_string(), None, now);
        let response = build_control_response(&snapshot);
        drop(snapshot);
        self.persist_event("next_stage_approved", serde_json::json!({}), None)
            .await;
        response
    }

    pub async fn set_limits(
        &self,
        max_iterations: Option<u32>,
        max_diff_bytes: Option<usize>,
        max_changed_paths: Option<usize>,
        audit_interval_runs: Option<u32>,
    ) -> LoopControlResponse {
        let mut snapshot = self.snapshot.lock().await;
        if let Some(max_iterations) = max_iterations {
            snapshot.limits.max_iterations = max_iterations.max(1);
        }
        if let Some(max_diff_bytes) = max_diff_bytes {
            snapshot.limits.max_diff_bytes = max_diff_bytes.max(1);
        }
        if let Some(max_changed_paths) = max_changed_paths {
            snapshot.limits.max_changed_paths = max_changed_paths.max(1);
        }
        if let Some(audit_interval_runs) = audit_interval_runs {
            snapshot.limits.audit_interval_runs = audit_interval_runs;
        }
        apply_diff_risk_flags(&mut snapshot);
        snapshot.last_step = Some("limits_updated".to_string());
        let now = Utc::now();
        snapshot.updated_at = Some(now);
        push_progress_event(&mut snapshot, "limits_updated".to_string(), None, now);
        let response = build_control_response(&snapshot);
        let limits = snapshot.limits.clone();
        drop(snapshot);
        self.persist_event(
            "limits_updated",
            serde_json::json!({
                "max_iterations": limits.max_iterations,
                "max_diff_bytes": limits.max_diff_bytes,
                "max_changed_paths": limits.max_changed_paths,
                "audit_interval_runs": limits.audit_interval_runs
            }),
            None,
        )
        .await;
        response
    }

    /// Record the agent's current context-window usage (0–100 %) to the event log.
    /// This is a pure side-effect — the in-memory snapshot is not changed.
    pub async fn record_context_percent(&self, percent: u8) {
        if let Some(log) = self.event_log.lock().await.as_mut() {
            log.log_context_percent(percent);
        }
        self.persist_event(
            "context_percent_updated",
            serde_json::json!({ "percent": percent }),
            None,
        )
        .await;
    }

    /// Transition to `Checkpointing` state (context budget exceeded, writing checkpoint).
    pub async fn enter_checkpointing(&self) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Running {
            snapshot.status = LoopSupervisionStatus::Checkpointing;
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, "checkpointing".to_string(), None, now);
        }
        drop(snapshot);
        self.persist_event("checkpointing", serde_json::json!({}), None)
            .await;
    }

    /// Transition back to `Running` after a checkpoint resume (same run, no count advance).
    pub async fn enter_resuming_same_run(&self) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::Checkpointing {
            snapshot.status = LoopSupervisionStatus::ResumingSameRun;
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, "resuming_same_run".to_string(), None, now);
        }
        drop(snapshot);
        self.persist_event(
            "resume_started",
            serde_json::json!({ "same_run": true }),
            None,
        )
        .await;
    }

    /// Transition from `ResumingSameRun` back to `Running` once the fresh run begins.
    pub async fn enter_running_after_resume(&self) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot.status == LoopSupervisionStatus::ResumingSameRun {
            snapshot.status = LoopSupervisionStatus::Running;
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(&mut snapshot, "resumed".to_string(), None, now);
        }
        drop(snapshot);
        self.persist_event(
            "resume_completed",
            serde_json::json!({ "same_run": true }),
            None,
        )
        .await;
    }

    /// Write a checkpoint for the current run and return its path.
    /// Returns `None` if no base_dir is configured or if the snapshot has no run_id.
    pub async fn build_current_checkpoint(&self) -> Option<PathBuf> {
        let snapshot = self.snapshot.lock().await;
        let run_id = snapshot.run_id.clone()?;
        let current_run = snapshot.current_run;
        let base_dir = self.base_dir.clone()?;
        drop(snapshot);

        match build_and_write_checkpoint(&run_id, current_run, &base_dir) {
            Ok(path) => {
                self.persist_event(
                    "checkpoint_written",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "run_number": current_run
                    }),
                    Some(format!("{run_id}:{current_run}:checkpoint_written")),
                )
                .await;
                if let Some(store) = self.store.as_ref() {
                    match std::fs::read_to_string(&path) {
                        Ok(checkpoint_json) => {
                            let resume_prompt =
                                serde_json::from_str::<LoopCheckpoint>(&checkpoint_json)
                                    .map(|checkpoint| build_resume_prompt(&checkpoint))
                                    .unwrap_or_default();
                            if let Err(err) = store
                                .store_checkpoint(
                                    &run_id,
                                    current_run,
                                    checkpoint_json,
                                    resume_prompt,
                                    None,
                                )
                                .await
                            {
                                log::warn!(
                                    "[LoopSupervision] durable checkpoint write failed: {err}"
                                );
                            }
                        }
                        Err(err) => log::warn!(
                            "[LoopSupervision] checkpoint readback failed during context reset: {err}"
                        ),
                    }
                }
                Some(path)
            }
            Err(e) => {
                log::warn!("[LoopSupervision] checkpoint write failed during context reset: {e}");
                None
            }
        }
    }

    pub async fn snapshot(&self) -> LoopSupervisionSnapshot {
        self.snapshot.lock().await.clone()
    }

    pub async fn status_response(&self) -> LoopStatusResponse {
        build_status_response(&self.snapshot().await)
    }

    pub async fn progress_response(&self, limit: Option<usize>) -> LoopProgressResponse {
        build_progress_response(&self.snapshot().await, limit)
    }

    pub async fn diff_response(
        &self,
        byte_cap: Option<usize>,
        path_cap: Option<usize>,
    ) -> LoopDiffResponse {
        build_diff_response(&self.snapshot().await, byte_cap, path_cap)
    }

    pub async fn errors_response(&self, limit: Option<usize>) -> LoopErrorsResponse {
        build_errors_response(&self.snapshot().await, limit)
    }

    pub async fn audit_response(&self) -> LoopAuditResponse {
        let snapshot = self.snapshot().await;
        build_audit_response(&snapshot)
    }

    pub async fn supervisor_review_response(
        &self,
        byte_cap: Option<usize>,
    ) -> LoopSupervisorEvidence {
        let mut snapshot = self.snapshot.lock().await;
        let evidence = build_supervisor_evidence(&snapshot, byte_cap);

        if should_pause_for_escalation(&evidence) {
            snapshot.pause_requested = true;
            if snapshot.status == LoopSupervisionStatus::Running {
                snapshot.status = LoopSupervisionStatus::Paused;
            }
            snapshot.last_step = Some("supervisor_review_requested".to_string());
            let now = Utc::now();
            snapshot.updated_at = Some(now);
            push_progress_event(
                &mut snapshot,
                "supervisor_review_requested".to_string(),
                Some(evidence.triggered_guardrails.join(",")),
                now,
            );
        }

        evidence
    }

    pub async fn durable_status_response(
        &self,
        loop_id: Option<String>,
    ) -> Result<LoopDurableStatus, String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(LoopDurableStatus::disabled());
        };
        store.durable_status(loop_id).await
    }
}

/// Read the checkpoint written at the end of `run_number - 1` and return a
/// ready-to-inject resume prompt.  Returns `None` when no checkpoint exists yet
/// (first run, or checkpoint write failed).
#[tauri::command]
pub async fn get_loop_resume_prompt(
    state: State<'_, LoopSupervisionState>,
    loop_id: String,
    run_number: u32,
) -> Result<Option<String>, String> {
    let base_dir = match state.base_dir() {
        Some(dir) => dir.to_path_buf(),
        None => return Ok(None),
    };
    let checkpoint_path = base_dir
        .join("loops")
        .join(&loop_id)
        .join(format!("run_{run_number}_checkpoint.json"));

    if !checkpoint_path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&checkpoint_path)
        .map_err(|e| format!("Failed to read checkpoint: {e}"))?;
    let checkpoint: LoopCheckpoint =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse checkpoint: {e}"))?;

    Ok(Some(build_resume_prompt(&checkpoint)))
}

#[tauri::command]
pub async fn loop_status(
    state: State<'_, LoopSupervisionState>,
) -> Result<LoopStatusResponse, String> {
    Ok(state.status_response().await)
}

#[tauri::command]
pub async fn read_loop_progress(
    state: State<'_, LoopSupervisionState>,
    limit: Option<usize>,
) -> Result<LoopProgressResponse, String> {
    Ok(state.progress_response(limit).await)
}

#[tauri::command]
pub async fn get_loop_diff(
    state: State<'_, LoopSupervisionState>,
    byte_cap: Option<usize>,
    path_cap: Option<usize>,
) -> Result<LoopDiffResponse, String> {
    Ok(state.diff_response(byte_cap, path_cap).await)
}

#[tauri::command]
pub async fn get_last_loop_errors(
    state: State<'_, LoopSupervisionState>,
    limit: Option<usize>,
) -> Result<LoopErrorsResponse, String> {
    Ok(state.errors_response(limit).await)
}

#[tauri::command]
pub async fn run_loop_audit(
    state: State<'_, LoopSupervisionState>,
) -> Result<LoopAuditResponse, String> {
    Ok(state.audit_response().await)
}

#[tauri::command]
pub async fn request_supervisor_review(
    state: State<'_, LoopSupervisionState>,
    byte_cap: Option<usize>,
) -> Result<LoopSupervisorEvidence, String> {
    Ok(state.supervisor_review_response(byte_cap).await)
}

#[tauri::command]
pub async fn loop_durable_status(
    state: State<'_, LoopSupervisionState>,
    loop_id: Option<String>,
) -> Result<LoopDurableStatus, String> {
    state.durable_status_response(loop_id).await
}

#[tauri::command]
pub async fn pause_loop(
    state: State<'_, LoopSupervisionState>,
    mode: Option<LoopPauseMode>,
) -> Result<LoopControlResponse, String> {
    Ok(state
        .request_pause(mode.unwrap_or(LoopPauseMode::AfterCurrentRun))
        .await)
}

#[tauri::command]
pub async fn resume_loop(
    state: State<'_, LoopSupervisionState>,
) -> Result<LoopControlResponse, String> {
    Ok(state.resume().await)
}

#[tauri::command]
pub async fn approve_next_stage(
    state: State<'_, LoopSupervisionState>,
) -> Result<LoopControlResponse, String> {
    Ok(state.approve_next_stage().await)
}

#[tauri::command]
pub async fn set_loop_limits(
    state: State<'_, LoopSupervisionState>,
    max_iterations: Option<u32>,
    max_diff_bytes: Option<usize>,
    max_changed_paths: Option<usize>,
    audit_interval_runs: Option<u32>,
) -> Result<LoopControlResponse, String> {
    Ok(state
        .set_limits(
            max_iterations,
            max_diff_bytes,
            max_changed_paths,
            audit_interval_runs,
        )
        .await)
}

fn build_status_response(snapshot: &LoopSupervisionSnapshot) -> LoopStatusResponse {
    LoopStatusResponse {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        project_dir: snapshot.project_dir.clone(),
        source: snapshot.source.clone(),
        current_run: snapshot.current_run,
        max_runs: snapshot.max_runs,
        last_step: snapshot.last_step.clone(),
        risk_flags: snapshot.risk_flags.clone(),
        pause_requested: snapshot.pause_requested,
        stop_requested: snapshot.stop_requested,
        next_action: next_action(snapshot).to_string(),
    }
}

fn session_record_from_snapshot(
    snapshot: &LoopSupervisionSnapshot,
    prompt: Option<String>,
    last_error: Option<String>,
) -> Option<LoopSessionRecord> {
    Some(LoopSessionRecord {
        id: snapshot.run_id.clone()?,
        project_dir: snapshot.project_dir.clone(),
        prompt,
        status: status_label(&snapshot.status).to_string(),
        current_run: snapshot.current_run,
        max_runs: snapshot.max_runs,
        interval_seconds: None,
        backend: None,
        model: None,
        last_step: snapshot.last_step.clone(),
        last_error,
    })
}

fn status_label(status: &LoopSupervisionStatus) -> &'static str {
    match status {
        LoopSupervisionStatus::Idle => "idle",
        LoopSupervisionStatus::Running => "running",
        LoopSupervisionStatus::Checkpointing => "checkpointing",
        LoopSupervisionStatus::ResumingSameRun => "resuming_same_run",
        LoopSupervisionStatus::Paused => "paused",
        LoopSupervisionStatus::WaitingApproval => "waiting_approval",
        LoopSupervisionStatus::Failed => "failed",
        LoopSupervisionStatus::Complete => "complete",
        LoopSupervisionStatus::Stopped => "stopped",
    }
}

fn mode_label(mode: &LoopPauseMode) -> &'static str {
    match mode {
        LoopPauseMode::AfterCurrentRun => "after_current_run",
        LoopPauseMode::Immediate => "immediate",
    }
}

fn build_control_response(snapshot: &LoopSupervisionSnapshot) -> LoopControlResponse {
    LoopControlResponse {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        pause_requested: snapshot.pause_requested,
        stop_requested: snapshot.stop_requested,
        limits: snapshot.limits.clone(),
        next_action: next_action(snapshot).to_string(),
    }
}

fn build_progress_response(
    snapshot: &LoopSupervisionSnapshot,
    limit: Option<usize>,
) -> LoopProgressResponse {
    let limit = limit
        .unwrap_or(DEFAULT_PROGRESS_LIMIT)
        .clamp(1, MAX_PROGRESS_LIMIT);
    let total = snapshot.progress_events.len();
    let start = total.saturating_sub(limit);

    LoopProgressResponse {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        current_run: snapshot.current_run,
        max_runs: snapshot.max_runs,
        events: snapshot.progress_events[start..].to_vec(),
        truncated: start > 0,
    }
}

fn build_diff_response(
    snapshot: &LoopSupervisionSnapshot,
    byte_cap: Option<usize>,
    path_cap: Option<usize>,
) -> LoopDiffResponse {
    let byte_cap = byte_cap
        .unwrap_or(DEFAULT_DIFF_BYTES)
        .clamp(1, MAX_DIFF_BYTES);
    let path_cap = path_cap
        .unwrap_or(DEFAULT_DIFF_PATHS)
        .clamp(1, MAX_DIFF_PATHS);
    let mut used_bytes = 0usize;
    let mut entries = Vec::new();
    let mut truncated = snapshot.changed_paths.len() > path_cap;

    for entry in &snapshot.diff_entries {
        if entries.len() >= path_cap {
            truncated = true;
            break;
        }
        if used_bytes.saturating_add(entry.bytes) > byte_cap {
            truncated = true;
            break;
        }
        used_bytes += entry.bytes;
        entries.push(entry.clone());
    }

    LoopDiffResponse {
        run_id: snapshot.run_id.clone(),
        changed_paths: snapshot
            .changed_paths
            .iter()
            .take(path_cap)
            .cloned()
            .collect(),
        entries,
        total_changed_paths: snapshot.changed_paths.len(),
        total_entries: snapshot.diff_entries.len(),
        truncated,
        byte_cap,
    }
}

fn build_errors_response(
    snapshot: &LoopSupervisionSnapshot,
    limit: Option<usize>,
) -> LoopErrorsResponse {
    let limit = limit
        .unwrap_or(DEFAULT_ERROR_LIMIT)
        .clamp(1, MAX_ERROR_LIMIT);
    let total = snapshot.last_errors.len();
    let start = total.saturating_sub(limit);

    LoopErrorsResponse {
        run_id: snapshot.run_id.clone(),
        errors: snapshot.last_errors[start..].to_vec(),
        total_errors: total,
        truncated: start > 0,
    }
}

fn build_audit_response(snapshot: &LoopSupervisionSnapshot) -> LoopAuditResponse {
    let mut findings = Vec::new();
    if snapshot.stop_requested {
        findings.push("stop_requested".to_string());
    }
    if snapshot.pause_requested {
        findings.push("pause_requested".to_string());
    }
    if snapshot.status == LoopSupervisionStatus::Failed {
        findings.push("loop_failed".to_string());
    }
    if !snapshot.last_errors.is_empty() {
        findings.push("recent_errors_present".to_string());
    }
    if repeated_error_signature(snapshot).is_some() {
        findings.push("repeated_error_signature".to_string());
    }
    if diff_bytes(snapshot) > snapshot.limits.max_diff_bytes {
        findings.push("diff_too_large".to_string());
    }
    if snapshot.changed_paths.len() > snapshot.limits.max_changed_paths {
        findings.push("too_many_changed_paths".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| is_route_or_navigation_path(path))
    {
        findings.push("route_or_navigation_changed".to_string());
    }
    if snapshot
        .diff_entries
        .iter()
        .any(diff_entry_has_legacy_navigation)
    {
        findings.push("legacy_navigation_pattern".to_string());
    }
    if !snapshot.build_test_failures.is_empty() {
        findings.push("build_test_failed".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| !Path::new(path).exists())
    {
        findings.push("changed_path_missing".to_string());
    }
    if audit_interval_triggered(snapshot) {
        findings.push("audit_interval_reached".to_string());
    }
    findings.extend(snapshot.risk_flags.iter().cloned());
    dedupe_strings(&mut findings);

    LoopAuditResponse {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        risk_flags: audit_risk_flags(snapshot),
        findings,
        next_action: next_action(snapshot).to_string(),
    }
}

fn next_action(snapshot: &LoopSupervisionSnapshot) -> &'static str {
    if snapshot.stop_requested {
        "stop"
    } else if snapshot.pause_requested || snapshot.status == LoopSupervisionStatus::Paused {
        "pause"
    } else if snapshot.status == LoopSupervisionStatus::Failed
        || !audit_risk_flags(snapshot).is_empty()
    {
        "audit"
    } else {
        "none"
    }
}

fn build_supervisor_evidence(
    snapshot: &LoopSupervisionSnapshot,
    byte_cap: Option<usize>,
) -> LoopSupervisorEvidence {
    let byte_cap = byte_cap
        .unwrap_or(DEFAULT_EVIDENCE_BYTE_CAP)
        .clamp(1, MAX_EVIDENCE_BYTE_CAP);
    let audit = build_audit_response(snapshot);
    let triggered_guardrails = escalation_triggers(snapshot);
    let mut evidence_preview = serde_json::to_string(&serde_json::json!({
        "status": snapshot.status,
        "last_step": snapshot.last_step,
        "risk_flags": audit.risk_flags,
        "findings": audit.findings,
        "last_errors": tail(&snapshot.last_errors, EVIDENCE_ERROR_LIMIT),
        "changed_paths": snapshot.changed_paths.iter().take(EVIDENCE_CHANGED_PATH_LIMIT).cloned().collect::<Vec<_>>(),
        "build_test_failures": snapshot.build_test_failures,
        "recent_tool_traces": tail(&snapshot.tool_traces, EVIDENCE_PROGRESS_LIMIT),
    }))
    .unwrap_or_default();

    let mut truncated = false;
    if evidence_preview.len() > byte_cap {
        evidence_preview = capped_text(&evidence_preview, byte_cap);
        truncated = true;
    }

    LoopSupervisorEvidence {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        project_dir: snapshot.project_dir.clone(),
        current_run: snapshot.current_run,
        max_runs: snapshot.max_runs,
        triggered_guardrails: triggered_guardrails.clone(),
        audit_findings: audit.findings,
        last_errors: tail(&snapshot.last_errors, EVIDENCE_ERROR_LIMIT),
        changed_paths: snapshot
            .changed_paths
            .iter()
            .take(EVIDENCE_CHANGED_PATH_LIMIT)
            .cloned()
            .collect(),
        diff_stats: LoopDiffStats {
            total_changed_paths: snapshot.changed_paths.len(),
            total_entries: snapshot.diff_entries.len(),
            total_bytes: diff_bytes(snapshot),
        },
        latest_build_test_failure: snapshot.build_test_failures.last().cloned(),
        progress_tail: tail(&snapshot.progress_events, EVIDENCE_PROGRESS_LIMIT),
        evidence_preview,
        byte_cap,
        truncated,
        recommendation: escalation_recommendation(snapshot, &triggered_guardrails),
        next_action: next_action(snapshot).to_string(),
    }
}

fn escalation_triggers(snapshot: &LoopSupervisionSnapshot) -> Vec<String> {
    let mut triggers = Vec::new();
    if !snapshot.build_test_failures.is_empty() {
        triggers.push("build_test_failed".to_string());
    }
    if repeated_error_signature(snapshot).is_some() {
        triggers.push("repeated_error_signature".to_string());
    }
    if snapshot
        .risk_flags
        .iter()
        .any(|flag| flag == "path_outside_project")
    {
        triggers.push("path_outside_project".to_string());
    }
    if diff_bytes(snapshot) > snapshot.limits.max_diff_bytes {
        triggers.push("diff_too_large".to_string());
    }
    if snapshot.changed_paths.len() > snapshot.limits.max_changed_paths {
        triggers.push("too_many_changed_paths".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| is_route_or_navigation_path(path))
    {
        triggers.push("route_or_navigation_changed".to_string());
    }
    if snapshot
        .diff_entries
        .iter()
        .any(diff_entry_has_legacy_navigation)
    {
        triggers.push("legacy_navigation_pattern".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| !Path::new(path).exists())
    {
        triggers.push("changed_path_missing".to_string());
    }
    if audit_interval_triggered(snapshot) {
        triggers.push("audit_interval_reached".to_string());
    }
    dedupe_strings(&mut triggers);
    triggers
}

fn escalation_recommendation(
    snapshot: &LoopSupervisionSnapshot,
    triggers: &[String],
) -> LoopEscalationRecommendation {
    if snapshot.stop_requested || snapshot.status == LoopSupervisionStatus::Stopped {
        return LoopEscalationRecommendation::Stop;
    }
    if triggers.is_empty() {
        return LoopEscalationRecommendation::Continue;
    }
    if triggers.iter().any(|trigger| {
        matches!(
            trigger.as_str(),
            "path_outside_project"
                | "build_test_failed"
                | "diff_too_large"
                | "too_many_changed_paths"
                | "route_or_navigation_changed"
                | "legacy_navigation_pattern"
                | "changed_path_missing"
        )
    }) {
        LoopEscalationRecommendation::Pause
    } else {
        LoopEscalationRecommendation::RequestMoreEvidence
    }
}

fn should_pause_for_escalation(evidence: &LoopSupervisorEvidence) -> bool {
    matches!(
        evidence.recommendation,
        LoopEscalationRecommendation::Pause | LoopEscalationRecommendation::Stop
    )
}

fn audit_interval_triggered(snapshot: &LoopSupervisionSnapshot) -> bool {
    snapshot.limits.audit_interval_runs > 0
        && snapshot.current_run > 0
        && snapshot.current_run % snapshot.limits.audit_interval_runs == 0
}

fn apply_error_risk_flags(snapshot: &mut LoopSupervisionSnapshot) {
    if repeated_error_signature(snapshot).is_some() {
        push_unique_string(
            &mut snapshot.risk_flags,
            "repeated_error_signature".to_string(),
        );
    }
}

fn apply_diff_risk_flags(snapshot: &mut LoopSupervisionSnapshot) {
    if diff_bytes(snapshot) > snapshot.limits.max_diff_bytes {
        push_unique_string(&mut snapshot.risk_flags, "diff_too_large".to_string());
    }
    if snapshot.changed_paths.len() > snapshot.limits.max_changed_paths {
        push_unique_string(
            &mut snapshot.risk_flags,
            "too_many_changed_paths".to_string(),
        );
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| is_route_or_navigation_path(path))
    {
        push_unique_string(
            &mut snapshot.risk_flags,
            "route_or_navigation_changed".to_string(),
        );
    }
    if snapshot
        .diff_entries
        .iter()
        .any(diff_entry_has_legacy_navigation)
    {
        push_unique_string(
            &mut snapshot.risk_flags,
            "legacy_navigation_pattern".to_string(),
        );
    }
}

fn audit_risk_flags(snapshot: &LoopSupervisionSnapshot) -> Vec<String> {
    let mut flags = snapshot.risk_flags.clone();
    if repeated_error_signature(snapshot).is_some() {
        push_unique_string(&mut flags, "repeated_error_signature".to_string());
    }
    if diff_bytes(snapshot) > snapshot.limits.max_diff_bytes {
        push_unique_string(&mut flags, "diff_too_large".to_string());
    }
    if snapshot.changed_paths.len() > snapshot.limits.max_changed_paths {
        push_unique_string(&mut flags, "too_many_changed_paths".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| is_route_or_navigation_path(path))
    {
        push_unique_string(&mut flags, "route_or_navigation_changed".to_string());
    }
    if snapshot
        .diff_entries
        .iter()
        .any(diff_entry_has_legacy_navigation)
    {
        push_unique_string(&mut flags, "legacy_navigation_pattern".to_string());
    }
    if !snapshot.build_test_failures.is_empty() {
        push_unique_string(&mut flags, "build_test_failed".to_string());
    }
    if snapshot
        .changed_paths
        .iter()
        .any(|path| !Path::new(path).exists())
    {
        push_unique_string(&mut flags, "changed_path_missing".to_string());
    }
    if audit_interval_triggered(snapshot) {
        push_unique_string(&mut flags, "audit_interval_reached".to_string());
    }
    flags
}

fn repeated_error_signature(snapshot: &LoopSupervisionSnapshot) -> Option<String> {
    let mut counts = HashMap::<String, usize>::new();
    for error in &snapshot.last_errors {
        let signature = error_signature(error);
        let count = counts.entry(signature.clone()).or_insert(0);
        *count += 1;
        if *count >= REPEATED_ERROR_THRESHOLD {
            return Some(signature);
        }
    }
    None
}

fn error_signature(error: &str) -> String {
    error
        .lines()
        .next()
        .unwrap_or(error)
        .split_whitespace()
        .map(normalize_error_token)
        .take(12)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn normalize_error_token(token: &str) -> String {
    let trimmed = token.trim_matches(|value: char| {
        matches!(
            value,
            '\'' | '"' | '`' | ',' | ':' | ';' | '(' | ')' | '[' | ']'
        )
    });
    if looks_like_path_token(trimmed) {
        "<path>".to_string()
    } else {
        trimmed.to_string()
    }
}

fn looks_like_path_token(token: &str) -> bool {
    token.contains('/')
        || token.contains('\\')
        || token.starts_with('.')
        || token.rsplit_once('.').is_some_and(|(_, ext)| {
            matches!(
                ext,
                "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "md" | "toml" | "css"
            )
        })
}

fn diff_bytes(snapshot: &LoopSupervisionSnapshot) -> usize {
    snapshot.diff_entries.iter().map(|entry| entry.bytes).sum()
}

fn is_route_or_navigation_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/navigation/")
        || normalized.contains("/router/")
        || normalized.contains("/routes/")
        || normalized.ends_with("/routes.ts")
        || normalized.ends_with("/router.ts")
        || normalized.ends_with("/navigation.ts")
        || normalized.ends_with("/app.tsx")
        || normalized.ends_with("/main.tsx")
}

fn diff_entry_has_legacy_navigation(entry: &LoopDiffEntry) -> bool {
    entry
        .replace_preview
        .as_deref()
        .is_some_and(contains_legacy_navigation_pattern)
        || entry
            .search_preview
            .as_deref()
            .is_some_and(contains_legacy_navigation_pattern)
}

fn contains_legacy_navigation_pattern(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("window.location")
        || lower.contains("location.href")
        || lower.contains("document.location")
        || lower.contains("history.pushstate")
        || lower.contains("history.replacestate")
}

pub fn command_looks_like_build_or_test(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let tokens = lower.split_whitespace().collect::<Vec<_>>();

    matches!(
        tokens.as_slice(),
        ["build", ..] | ["test", ..] | ["check", ..]
    ) || lower.contains("cargo check")
        || lower.contains("cargo test")
        || lower.contains("cargo build")
        || lower.contains("npm run build")
        || lower.contains("npm test")
        || lower.contains("npm run test")
        || lower.contains("yarn build")
        || lower.contains("yarn test")
        || lower.contains("yarn check")
        || lower.contains("pnpm build")
        || lower.contains("pnpm test")
        || lower.contains("pnpm check")
        || tokens
            .windows(2)
            .any(|window| window[0] == "npm" && matches!(window[1], "test" | "build"))
        || tokens.first().is_some_and(|first| {
            matches!(*first, "yarn" | "pnpm")
                && tokens
                    .iter()
                    .any(|token| matches!(*token, "build" | "test" | "check"))
        })
}

fn push_unique_string(items: &mut Vec<String>, item: String) {
    if !items.iter().any(|existing| existing == &item) {
        items.push(item);
    }
}

fn dedupe_strings(items: &mut Vec<String>) {
    let mut deduped = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        push_unique_string(&mut deduped, item);
    }
    *items = deduped;
}

fn build_diff_entry(
    path: String,
    operation: String,
    search: Option<&str>,
    replace: Option<&str>,
) -> LoopDiffEntry {
    let search_preview = search.map(preview_text);
    let replace_preview = replace.map(preview_text);
    let bytes = search.map_or(0, str::len) + replace.map_or(0, str::len);
    let truncated = search.is_some_and(|value| value.len() > PREVIEW_BYTES)
        || replace.is_some_and(|value| value.len() > PREVIEW_BYTES);

    LoopDiffEntry {
        path,
        operation,
        search_preview,
        replace_preview,
        bytes,
        truncated,
    }
}

fn preview_text(value: &str) -> String {
    if value.len() <= PREVIEW_BYTES {
        return value.to_string();
    }

    let mut end = PREVIEW_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn capped_text(value: &str, cap: usize) -> String {
    if value.len() <= cap {
        return value.to_string();
    }

    let mut end = cap;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn tail<T: Clone>(items: &[T], limit: usize) -> Vec<T> {
    let start = items.len().saturating_sub(limit);
    items[start..].to_vec()
}

fn push_progress_event(
    snapshot: &mut LoopSupervisionSnapshot,
    step: String,
    message: Option<String>,
    timestamp: DateTime<Utc>,
) {
    snapshot.progress_events.push(LoopProgressEvent {
        step,
        message,
        timestamp,
    });
    trim_front(&mut snapshot.progress_events, MAX_PROGRESS_EVENTS);
}

fn trim_front<T>(items: &mut Vec<T>, max_len: usize) {
    if items.len() > max_len {
        let excess = items.len() - max_len;
        items.drain(0..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_response_serializes_snake_case_status() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                2,
                4,
                None,
            )
            .await;

        let value = serde_json::to_value(state.status_response().await).unwrap();

        assert_eq!(value["status"], "running");
        assert_eq!(value["source"], "loop");
        assert_eq!(value["current_run"], 2);
        assert_eq!(value["max_runs"], 4);
        assert_eq!(value["next_action"], "none");
    }

    #[tokio::test]
    async fn progress_response_caps_tail_without_mutating_state() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        for index in 0..60 {
            state.record_step(format!("step_{index}")).await;
        }

        let before = state.snapshot().await.progress_events.len();
        let response = state.progress_response(Some(5)).await;
        let after = state.snapshot().await.progress_events.len();

        assert_eq!(before, MAX_PROGRESS_EVENTS);
        assert_eq!(after, before);
        assert_eq!(response.events.len(), 5);
        assert!(response.truncated);
        assert_eq!(response.events[0].step, "step_55");
    }

    #[tokio::test]
    async fn diff_response_applies_path_and_byte_caps() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .record_diff(
                "/tmp/project/a.ts",
                "edit_file",
                Some("a".repeat(10)),
                Some("b".repeat(10)),
            )
            .await;
        state
            .record_diff(
                "/tmp/project/b.ts",
                "write_file",
                None,
                Some("c".repeat(200)),
            )
            .await;

        let response = state.diff_response(Some(30), Some(1)).await;

        assert_eq!(response.changed_paths.len(), 1);
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.total_changed_paths, 2);
        assert_eq!(response.total_entries, 2);
        assert!(response.truncated);
    }

    #[tokio::test]
    async fn errors_response_returns_recent_tail() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        for index in 0..12 {
            state.record_error(format!("error_{index}")).await;
        }

        let response = state.errors_response(Some(3)).await;

        assert_eq!(response.errors, vec!["error_9", "error_10", "error_11"]);
        assert_eq!(response.total_errors, MAX_LAST_ERRORS);
        assert!(response.truncated);
    }

    #[tokio::test]
    async fn audit_response_is_read_only_and_flags_failed_state() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .finish_run(false, false, Some("build failed".to_string()))
            .await;

        let before = state.snapshot().await.updated_at;
        let response = state.audit_response().await;
        let after = state.snapshot().await.updated_at;

        assert_eq!(before, after);
        assert_eq!(response.status, LoopSupervisionStatus::Failed);
        assert!(response.findings.contains(&"loop_failed".to_string()));
        assert_eq!(response.next_action, "audit");
    }

    #[tokio::test]
    async fn pause_after_current_run_marks_request_without_stopping_active_run() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;

        let response = state.request_pause(LoopPauseMode::AfterCurrentRun).await;

        assert_eq!(response.status, LoopSupervisionStatus::Running);
        assert!(response.pause_requested);
        assert_eq!(response.next_action, "pause");

        state.finish_run(true, false, None).await;
        let snapshot = state.snapshot().await;
        assert_eq!(snapshot.status, LoopSupervisionStatus::Paused);
        assert!(snapshot.pause_requested);
    }

    #[tokio::test]
    async fn immediate_pause_and_resume_only_change_loop_state() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;

        let paused = state.request_pause(LoopPauseMode::Immediate).await;
        assert_eq!(paused.status, LoopSupervisionStatus::Paused);
        assert!(paused.pause_requested);

        let resumed = state.resume().await;
        assert_eq!(resumed.status, LoopSupervisionStatus::Running);
        assert!(!resumed.pause_requested);
        assert!(!resumed.stop_requested);
    }

    #[tokio::test]
    async fn stop_request_sets_terminal_control_state() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;
        state.request_pause(LoopPauseMode::AfterCurrentRun).await;

        let response = state.request_stop().await;

        assert_eq!(response.status, LoopSupervisionStatus::Stopped);
        assert!(!response.pause_requested);
        assert!(response.stop_requested);
        assert_eq!(response.next_action, "stop");
    }

    #[tokio::test]
    async fn set_limits_updates_limits_without_prompt_state() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;

        let response = state
            .set_limits(Some(12), Some(2048), Some(7), Some(3))
            .await;

        assert_eq!(response.limits.max_iterations, 12);
        assert_eq!(response.limits.max_diff_bytes, 2048);
        assert_eq!(response.limits.max_changed_paths, 7);
        assert_eq!(response.limits.audit_interval_runs, 3);
        assert_eq!(
            state.snapshot().await.last_step.as_deref(),
            Some("limits_updated")
        );
    }

    #[tokio::test]
    async fn audit_flags_repeated_error_signature() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .record_error("edit_file: search text not found in src/a.ts")
            .await;
        state
            .record_error("edit_file: search text not found in src/b.ts")
            .await;

        let response = state.audit_response().await;

        assert!(response
            .risk_flags
            .contains(&"repeated_error_signature".to_string()));
        assert!(response
            .findings
            .contains(&"repeated_error_signature".to_string()));
        assert_eq!(response.next_action, "audit");
    }

    #[tokio::test]
    async fn audit_flags_diff_thresholds() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;

        for index in 0..30 {
            state
                .record_diff(
                    format!("/tmp/project/src/file_{index}.ts"),
                    "write_file",
                    None,
                    Some("x".repeat(2 * 1024)),
                )
                .await;
        }

        let response = state.audit_response().await;

        assert!(response.risk_flags.contains(&"diff_too_large".to_string()));
        assert!(response
            .risk_flags
            .contains(&"too_many_changed_paths".to_string()));
    }

    #[tokio::test]
    async fn audit_flags_route_and_legacy_navigation_changes() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .record_diff(
                "/tmp/project/web-app/src/routes/index.tsx",
                "edit_file",
                Some("router.navigate('/home')".to_string()),
                Some("window.location.href = '/home'".to_string()),
            )
            .await;

        let response = state.audit_response().await;

        assert!(response
            .risk_flags
            .contains(&"route_or_navigation_changed".to_string()));
        assert!(response
            .risk_flags
            .contains(&"legacy_navigation_pattern".to_string()));
    }

    #[tokio::test]
    async fn audit_flags_failed_build_or_test() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .record_build_test_failure(
                "cargo check --lib",
                "/tmp/project",
                Some(101),
                "error: build failed",
            )
            .await;

        let response = state.audit_response().await;

        assert!(response
            .risk_flags
            .contains(&"build_test_failed".to_string()));
        assert!(response.findings.contains(&"build_test_failed".to_string()));
    }

    #[tokio::test]
    async fn audit_flags_missing_changed_path() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                1,
                None,
            )
            .await;
        state
            .record_diff(
                "/tmp/project/definitely-missing-file.ts",
                "edit_file",
                Some("old".to_string()),
                Some("new".to_string()),
            )
            .await;

        let response = state.audit_response().await;

        assert!(response
            .risk_flags
            .contains(&"changed_path_missing".to_string()));
    }

    #[test]
    fn build_and_test_command_detection_is_targeted() {
        assert!(command_looks_like_build_or_test("cargo check --lib"));
        assert!(command_looks_like_build_or_test("yarn workspace app build"));
        assert!(command_looks_like_build_or_test("npm test"));
        assert!(!command_looks_like_build_or_test("rg build src"));
    }

    #[tokio::test]
    async fn supervisor_review_pauses_on_build_failure_with_compact_evidence() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;
        state
            .record_build_test_failure(
                "cargo check --lib",
                "/tmp/project",
                Some(101),
                "error: build failed".repeat(200),
            )
            .await;

        let response = state.supervisor_review_response(Some(512)).await;
        let snapshot = state.snapshot().await;

        assert!(response
            .triggered_guardrails
            .contains(&"build_test_failed".to_string()));
        assert_eq!(response.recommendation, LoopEscalationRecommendation::Pause);
        assert!(response.evidence_preview.len() <= 512);
        assert!(snapshot.pause_requested);
        assert_eq!(snapshot.status, LoopSupervisionStatus::Paused);
    }

    #[tokio::test]
    async fn supervisor_review_recommends_more_evidence_for_interval_audit() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                4,
                8,
                None,
            )
            .await;
        state.set_limits(None, None, None, Some(2)).await;

        let response = state.supervisor_review_response(None).await;

        assert!(response
            .triggered_guardrails
            .contains(&"audit_interval_reached".to_string()));
        assert_eq!(
            response.recommendation,
            LoopEscalationRecommendation::RequestMoreEvidence
        );
    }

    #[tokio::test]
    async fn supervisor_review_continue_when_no_trigger_is_present() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                3,
                None,
            )
            .await;

        let response = state.supervisor_review_response(None).await;

        assert!(response.triggered_guardrails.is_empty());
        assert_eq!(
            response.recommendation,
            LoopEscalationRecommendation::Continue
        );
        assert!(!state.snapshot().await.pause_requested);
    }
}
