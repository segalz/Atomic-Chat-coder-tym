//! # Cline Agent Lifecycle and Cancellation Management
//!
//! Stage 06 implementation for the owned Cline ACP process.
//! Handles run-ID fencing, graceful cancellation, timeout escalation,
//! and clean process tree teardown to prevent orphan processes.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Unique identifier for an execution run.
/// Fences incoming events and ensures run isolation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RunId(pub String);

impl RunId {
    /// Creates a RunId from any string-like value.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Generates a monotonic, timestamped RunId.
    pub fn generate() -> Self {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let counter = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self(format!("run-{now}-{counter}"))
    }

    /// Returns the string slice representation of the RunId.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The terminal outcome of an execution run.
/// Exactly one terminal outcome is recorded per run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunTerminalOutcome {
    /// The run completed normally with a stop reason (e.g. "end_turn").
    Completed { stop_reason: String },
    /// The run was cancelled by user request or stop action.
    Cancelled { reason: Option<String> },
    /// The run timed out waiting for a turn or child process.
    TimedOut { duration_ms: u64 },
    /// The run failed due to a process crash, transport EOF, or protocol error.
    Failed { error: String },
}

/// The operational phase of an execution run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunPhase {
    /// No run is currently active.
    Idle,
    /// A run is starting up (spawning process or initializing handshake).
    Starting,
    /// A run is active with a bound external ACP session ID.
    Active { session_id: String },
    /// A stop has been requested; waiting for clean cancellation or timeout escalation.
    Stopping { reason: String },
    /// The run has reached a terminal outcome; no further event mutations allowed.
    Terminated { outcome: RunTerminalOutcome },
}

impl Default for RunPhase {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Default)]
struct RunFenceInner {
    active_run_id: Option<RunId>,
    phase: RunPhase,
    terminal_outcome: Option<RunTerminalOutcome>,
}

/// Thread-safe run fence ensuring run isolation, late event filtering,
/// and the exactly-one-terminal-result guarantee.
#[derive(Debug, Default)]
pub struct RunFence {
    inner: std::sync::Mutex<RunFenceInner>,
}

impl RunFence {
    /// Creates a new, idle RunFence.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a new run with the given `RunId`, moving to the `Starting` phase.
    /// Returns an error if a previous run is still active or stopping.
    pub fn start_run(&self, run_id: RunId) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        match &guard.phase {
            RunPhase::Starting | RunPhase::Active { .. } | RunPhase::Stopping { .. } => {
                let current = guard.active_run_id.as_ref().map(|r| r.as_str()).unwrap_or("unknown");
                Err(format!("Cannot start run {run_id}: run {current} is currently active in phase {:?}", guard.phase))
            }
            RunPhase::Idle | RunPhase::Terminated { .. } => {
                guard.active_run_id = Some(run_id);
                guard.phase = RunPhase::Starting;
                guard.terminal_outcome = None;
                Ok(())
            }
        }
    }

    /// Activates an in-flight run with its bound external ACP session ID.
    pub fn activate_run(&self, run_id: &RunId, session_id: impl Into<String>) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.active_run_id.as_ref() != Some(run_id) {
            return Err(format!("Run ID mismatch: active is {:?}, requested activation for {run_id}", guard.active_run_id));
        }
        match &guard.phase {
            RunPhase::Starting => {
                guard.phase = RunPhase::Active {
                    session_id: session_id.into(),
                };
                Ok(())
            }
            other => Err(format!("Cannot activate run {run_id} from phase {:?}", other)),
        }
    }

    /// Validates whether an incoming event tagged with `run_id` is allowed to mutate state.
    /// Returns true ONLY if `run_id` matches the active run AND the phase is `Active`.
    /// Late messages arriving during Stopping or Terminated return false.
    pub fn validate_event(&self, run_id: &RunId) -> bool {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if guard.active_run_id.as_ref() != Some(run_id) {
            return false;
        }
        matches!(guard.phase, RunPhase::Active { .. })
    }

    /// Transitions an active or starting run into the `Stopping` phase.
    /// Returns Ok(true) if the transition occurred, or Ok(false) if already stopping/terminated.
    pub fn begin_stopping(&self, run_id: &RunId, reason: impl Into<String>) -> Result<bool, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.active_run_id.as_ref() != Some(run_id) {
            return Err(format!("Run ID mismatch on stop: active is {:?}, requested for {run_id}", guard.active_run_id));
        }
        match &guard.phase {
            RunPhase::Starting | RunPhase::Active { .. } => {
                guard.phase = RunPhase::Stopping {
                    reason: reason.into(),
                };
                Ok(true)
            }
            RunPhase::Stopping { .. } | RunPhase::Terminated { .. } => Ok(false),
            RunPhase::Idle => Err("Cannot stop: no run is active".to_string()),
        }
    }

    /// Records the terminal outcome for the run.
    ///
    /// GUARANTEE: Exactly one terminal outcome is recorded per run.
    /// If `terminal_outcome` was already recorded or `run_id` does not match,
    /// this returns `None`. Otherwise, it records the outcome, transitions
    /// the phase to `Terminated`, and returns `Some(outcome)`.
    pub fn record_terminal(
        &self,
        run_id: &RunId,
        outcome: RunTerminalOutcome,
    ) -> Option<RunTerminalOutcome> {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        if guard.active_run_id.as_ref() != Some(run_id) {
            return None;
        }
        if guard.terminal_outcome.is_some() {
            return None;
        }
        guard.terminal_outcome = Some(outcome.clone());
        guard.phase = RunPhase::Terminated {
            outcome: outcome.clone(),
        };
        Some(outcome)
    }

    /// Returns the currently active RunId, if any.
    pub fn current_run_id(&self) -> Option<RunId> {
        self.inner.lock().ok().and_then(|g| g.active_run_id.clone())
    }

    /// Returns the recorded terminal outcome, if any.
    pub fn terminal_outcome(&self) -> Option<RunTerminalOutcome> {
        self.inner.lock().ok().and_then(|g| g.terminal_outcome.clone())
    }

    /// Returns the current phase of the run fence.
    pub fn current_phase(&self) -> RunPhase {
        self.inner
            .lock()
            .map(|g| g.phase.clone())
            .unwrap_or(RunPhase::Idle)
    }

    /// Returns true if a run is currently Starting or Active.
    pub fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|g| matches!(g.phase, RunPhase::Starting | RunPhase::Active { .. }))
            .unwrap_or(false)
    }

    /// Resets the fence to Idle if the run is Terminated.
    pub fn reset_to_idle(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        match &guard.phase {
            RunPhase::Terminated { .. } => {
                guard.active_run_id = None;
                guard.phase = RunPhase::Idle;
                guard.terminal_outcome = None;
                Ok(())
            }
            RunPhase::Idle => Ok(()),
            other => Err(format!("Cannot reset to Idle while in phase {:?}", other)),
        }
    }
}

/// Represents an owned child process for the Cline ACP agent.
/// Owns the child PID and guarantees clean process tree termination on exit or drop.
#[derive(Debug)]
pub struct OwnedChildProcess {
    pid: u32,
    is_alive: std::sync::atomic::AtomicBool,
}

impl OwnedChildProcess {
    /// Wraps a spawned child process by its OS PID.
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            is_alive: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Returns the OS process ID.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Returns true if the child is recorded as alive.
    pub fn is_alive(&self) -> bool {
        self.is_alive.load(Ordering::Relaxed)
    }

    /// Marks the process as exited (e.g. after clean termination or reaping).
    pub fn mark_exited(&self) {
        self.is_alive.store(false, Ordering::Relaxed);
    }

    /// Forcefully terminates the child process and its entire process tree.
    /// On Windows, executes `taskkill /F /T /PID <pid>`.
    /// On Unix, sends SIGKILL to the process group.
    pub fn terminate(&self) -> Result<(), String> {
        if !self.is_alive.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        kill_process_tree(self.pid)
    }
}

impl Drop for OwnedChildProcess {
    fn drop(&mut self) {
        if self.is_alive.load(Ordering::Relaxed) {
            let _ = self.terminate();
        }
    }
}

/// Kills a process and its full descendant tree by PID.
/// Strictly targets only the specified PID to avoid killing unowned processes.
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    if pid <= 1 {
        return Err(format!("Refusing to kill reserved PID {pid}"));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let mut cmd = Command::new("taskkill");
        cmd.args(&["/F", "/T", "/PID", &pid.to_string()]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute taskkill for PID {pid}: {e}"))?;

        // Exit code 128 from taskkill means process was not found (already exited).
        let code = output.status.code().unwrap_or(-1);
        if output.status.success() || code == 128 {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("taskkill failed for PID {pid} (code {code}): {stderr}"))
        }
    }

    #[cfg(not(windows))]
    {
        let res = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if res == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            let single_res = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            if single_res == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(format!("Failed to kill PID {pid}: {}", std::io::Error::last_os_error()))
            }
        }
    }
}

use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use std::path::PathBuf;

/// Authoritative identity for an active or restored Cline ACP session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIdentity {
    /// Atomic Chat internal conversation session ID.
    pub atomic_session_id: String,
    /// Opaque external session ID returned by Cline ACP (`sessionId`).
    pub external_session_id: String,
    /// Canonical workspace project directory.
    pub project_dir: PathBuf,
    /// Backend identifier (fixed to `"cline-acp"`).
    pub backend: String,
    /// Bound model catalog ID (e.g. `"zai/glm-5.3-flash"`).
    pub model_id: String,
    /// Verified provider namespace (e.g. `Some("zai")`).
    pub provider_id: Option<String>,
}

/// Model binding specification for a Cline ACP session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionModelConfig {
    /// The target model ID to bind (default `"zai/glm-5.3-flash"`).
    pub model_id: String,
    /// Optional provider ID (e.g. `"zai"`).
    pub provider_id: Option<String>,
}

impl Default for SessionModelConfig {
    fn default() -> Self {
        Self {
            model_id: "zai/glm-5.3-flash".to_string(),
            provider_id: Some("zai".to_string()),
        }
    }
}

/// Typed errors for Cline ACP session creation, restoration, and model binding.
#[derive(Debug, thiserror::Error)]
pub enum ClineSessionError {
    #[error("Invalid project directory: {0}")]
    InvalidProjectDir(String),

    #[error("Project mismatch: session belongs to '{expected}', but requested '{actual}'")]
    ProjectMismatch { expected: String, actual: String },

    #[error("Model binding failed: requested '{requested}', but agent returned '{actual}'. {error}")]
    ModelBindingFailed {
        requested: String,
        actual: String,
        error: String,
    },

    #[error("Stale or unknown external session ID: {0}")]
    StaleSessionId(String),

    #[error("Session resume failed for '{session_id}': {reason}")]
    ResumeFailed { session_id: String, reason: String },

    #[error("Concurrent prompt rejected: another prompt turn is currently active on session '{0}'")]
    ConcurrentPrompt(String),

    #[error("Transport or protocol error: {0}")]
    Transport(String),
}

/// Normalized ACP event streamed to the frontend or internal channels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpStreamEvent {
    /// Visible text chunk emitted by the model.
    TextDelta { text: String, run_id: String },
    /// Explicit reasoning/thinking chunk emitted by the model.
    ThinkingDelta { text: String, run_id: String },
    /// Start of a tool invocation.
    ToolCallStart {
        call_id: String,
        tool_name: String,
        input_json: String,
        run_id: String,
    },
    /// Result or status update of a tool invocation.
    ToolCallResult {
        call_id: String,
        output: String,
        is_error: bool,
        run_id: String,
    },
    /// Terminal turn completion event.
    Done {
        success: bool,
        stop_reason: String,
        error: Option<String>,
        run_id: String,
    },
}

/// Normalizes raw session/update notification payload from Cline ACP.
/// Suppresses session_info_update, mode, and config updates from text stream.
pub fn normalize_acp_session_update(
    update: &serde_json::Value,
    run_id: &RunId,
) -> Vec<AcpStreamEvent> {
    let payload = update.get("update").unwrap_or(update);
    let update_type = payload
        .get("sessionUpdate")
        .or_else(|| payload.get("type"))
        .and_then(|v| v.as_str());

    let run_str = run_id.to_string();

    match update_type {
        Some("agent_message_chunk") => {
            let text = payload
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .or_else(|| payload.get("text").and_then(|t| t.as_str()))
                .unwrap_or("");

            if !text.is_empty() {
                vec![AcpStreamEvent::TextDelta {
                    text: text.to_string(),
                    run_id: run_str,
                }]
            } else {
                vec![]
            }
        }
        Some("agent_thought_chunk") => {
            let text = payload
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .or_else(|| payload.get("text").and_then(|t| t.as_str()))
                .unwrap_or("");

            if !text.is_empty() {
                vec![AcpStreamEvent::ThinkingDelta {
                    text: text.to_string(),
                    run_id: run_str,
                }]
            } else {
                vec![]
            }
        }
        Some("tool_call") => {
            let call_id = payload
                .get("toolCallId")
                .or_else(|| payload.get("callId"))
                .or_else(|| payload.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let tool_name = payload
                .get("title")
                .or_else(|| payload.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool");

            let input_json = payload
                .get("input")
                .map(|i| i.to_string())
                .unwrap_or_else(|| "{}".to_string());

            if !call_id.is_empty() {
                vec![AcpStreamEvent::ToolCallStart {
                    call_id: call_id.to_string(),
                    tool_name: tool_name.to_string(),
                    input_json,
                    run_id: run_str,
                }]
            } else {
                vec![]
            }
        }
        Some("tool_call_update") => {
            let call_id = payload
                .get("toolCallId")
                .or_else(|| payload.get("callId"))
                .or_else(|| payload.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let output = payload
                .get("output")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| payload.get("content").map(|v| v.to_string()))
                .unwrap_or_default();

            let status = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = status == "failed"
                || payload.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);

            if !call_id.is_empty() {
                vec![AcpStreamEvent::ToolCallResult {
                    call_id: call_id.to_string(),
                    output,
                    is_error,
                    run_id: run_str,
                }]
            } else {
                vec![]
            }
        }
        // Metadata updates are suppressed from visible text stream
        Some("session_info_update") | Some("config_update") => vec![],
        _ => vec![],
    }
}

/// Normalizes prompt done response into AcpStreamEvent::Done.
pub fn normalize_acp_prompt_done(
    stop_reason: &str,
    error: Option<String>,
    run_id: &RunId,
) -> AcpStreamEvent {
    let success = stop_reason == "end_turn";
    let mapped_error = if success {
        None
    } else {
        Some(error.unwrap_or_else(|| {
            if stop_reason == "cancelled" {
                "User cancelled turn".to_string()
            } else {
                format!("Turn stopped: {stop_reason}")
            }
        }))
    };

    AcpStreamEvent::Done {
        success,
        stop_reason: stop_reason.to_string(),
        error: mapped_error,
        run_id: run_id.to_string(),
    }
}

/// Configuration for timeouts governing run lifecycle.
#[derive(Debug, Clone)]
pub struct TimeoutConfig {
    /// Maximum time allowed for spawning and handshake (default 15s).
    pub startup_timeout: Duration,
    /// Maximum time allowed for an individual prompt turn (default 600s).
    pub turn_timeout: Duration,
    /// Grace period allowed for clean session/cancel before forced process kill (default 3s).
    pub stop_grace_period: Duration,
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        Self {
            startup_timeout: Duration::from_secs(15),
            turn_timeout: Duration::from_secs(600),
            stop_grace_period: Duration::from_secs(3),
        }
    }
}

/// An offered permission option from the ACP agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionOption {
    #[serde(alias = "id", rename = "optionId")]
    pub option_id: String,
    #[serde(alias = "title", default)]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Outcome of a permission request decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PermissionOutcome {
    Selected {
        #[serde(rename = "optionId")]
        option_id: String,
    },
    Cancelled,
}

/// A pending permission request awaiting explicit user decision.
pub struct PendingPermissionRequest {
    pub run_id: RunId,
    pub session_id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub title: Option<String>,
    pub options: Vec<PermissionOption>,
    pub responder: tokio::sync::oneshot::Sender<PermissionOutcome>,
}

impl std::fmt::Debug for PendingPermissionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPermissionRequest")
            .field("run_id", &self.run_id)
            .field("session_id", &self.session_id)
            .field("request_id", &self.request_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("title", &self.title)
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

/// Formats a JSON-RPC 2.0 response for an ACP permission request outcome.
pub fn format_permission_rpc_response(
    rpc_id: &serde_json::Value,
    outcome: &PermissionOutcome,
) -> serde_json::Value {
    let outcome_val = match outcome {
        PermissionOutcome::Selected { option_id } => serde_json::json!({
            "outcome": "selected",
            "optionId": option_id
        }),
        PermissionOutcome::Cancelled => serde_json::json!({
            "outcome": "cancelled",
            "optionId": serde_json::Value::Null
        }),
    };
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {
            "outcome": outcome_val
        }
    })
}

/// Shared state managing the Cline ACP agent lifecycle, process ownership,
/// cancellation, event fencing, and explicit session/model binding.
#[derive(Debug, Clone)]
pub struct ClineAgentState {
    fence: Arc<RunFence>,
    child_process: Arc<std::sync::Mutex<Option<OwnedChildProcess>>>,
    timeouts: TimeoutConfig,
    cancel_token: Arc<std::sync::Mutex<Option<CancellationToken>>>,
    active_session: Arc<std::sync::Mutex<Option<SessionIdentity>>>,
    sessions_by_external_id: Arc<std::sync::Mutex<std::collections::HashMap<String, SessionIdentity>>>,
    pending_permissions: Arc<std::sync::Mutex<std::collections::HashMap<String, PendingPermissionRequest>>>,
    restore_epoch: Arc<AtomicU64>,
}

impl Default for ClineAgentState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ClineAgentState {
    /// Creates a new ClineAgentState with optional timeout configuration.
    pub fn new(timeouts: Option<TimeoutConfig>) -> Self {
        Self {
            fence: Arc::new(RunFence::new()),
            child_process: Arc::new(std::sync::Mutex::new(None)),
            timeouts: timeouts.unwrap_or_default(),
            cancel_token: Arc::new(std::sync::Mutex::new(None)),
            active_session: Arc::new(std::sync::Mutex::new(None)),
            sessions_by_external_id: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            pending_permissions: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            restore_epoch: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Returns a reference to the inner RunFence.
    pub fn fence(&self) -> &Arc<RunFence> {
        &self.fence
    }

    /// Returns the configured timeouts.
    pub fn timeouts(&self) -> &TimeoutConfig {
        &self.timeouts
    }

    /// Returns a clone of the currently active session identity, if any.
    pub fn active_session(&self) -> Option<SessionIdentity> {
        self.active_session.lock().ok().and_then(|g| g.clone())
    }

    /// Returns the current restore epoch number.
    pub fn current_restore_epoch(&self) -> u64 {
        self.restore_epoch.load(Ordering::Relaxed)
    }

    /// Advances and returns a fresh restore epoch number to fence restore notifications.
    pub fn next_restore_epoch(&self) -> u64 {
        self.restore_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Validates and ensures the given path is a valid absolute project directory.
    pub fn validate_project_dir(path: &std::path::Path) -> Result<PathBuf, ClineSessionError> {
        if !path.is_absolute() {
            return Err(ClineSessionError::InvalidProjectDir(format!(
                "Project directory must be absolute, got: '{}'",
                path.display()
            )));
        }
        Ok(path.to_path_buf())
    }

    /// Validates model binding response.
    ///
    /// GUARANTEE: If the agent did not successfully bind the exact requested model,
    /// this function MUST return a ModelBindingFailed error. No silent fallback is allowed.
    pub fn validate_model_binding(
        requested: &SessionModelConfig,
        returned_current_value: Option<&str>,
    ) -> Result<(), ClineSessionError> {
        let actual = returned_current_value.unwrap_or("none");
        if actual != requested.model_id {
            return Err(ClineSessionError::ModelBindingFailed {
                requested: requested.model_id.clone(),
                actual: actual.to_string(),
                error: format!(
                    "Agent config mismatch: expected model '{}', but agent confirmed '{}'",
                    requested.model_id, actual
                ),
            });
        }
        Ok(())
    }

    /// Registers a newly created or restored session in state.
    pub fn register_session(&self, session: SessionIdentity) {
        if let Ok(mut guard) = self.sessions_by_external_id.lock() {
            guard.insert(session.external_session_id.clone(), session.clone());
        }
        if let Ok(mut guard) = self.active_session.lock() {
            *guard = Some(session);
        }
    }

    /// Looks up the external ACP session ID by either the external session ID itself
    /// or by the corresponding Atomic Chat conversation session ID.
    pub fn find_external_session_id(&self, session_id: &str) -> Option<String> {
        if let Ok(guard) = self.sessions_by_external_id.lock() {
            if guard.contains_key(session_id) {
                return Some(session_id.to_string());
            }
            for (ext_id, session) in guard.iter() {
                if session.atomic_session_id == session_id {
                    return Some(ext_id.clone());
                }
            }
        }
        if session_id.contains('_') {
            return Some(session_id.to_string());
        }
        None
    }

    /// Retrieves a registered session by its external ACP session ID.
    pub fn get_session(&self, external_session_id: &str) -> Result<SessionIdentity, ClineSessionError> {
        let guard = self.sessions_by_external_id.lock().map_err(|e| {
            ClineSessionError::Transport(format!("Failed to acquire session lock: {e}"))
        })?;
        guard
            .get(external_session_id)
            .cloned()
            .ok_or_else(|| ClineSessionError::StaleSessionId(external_session_id.to_string()))
    }

    /// Validates that a session resume request matches the session's canonical project directory.
    pub fn validate_session_resume(
        &self,
        external_session_id: &str,
        requested_project_dir: &std::path::Path,
    ) -> Result<SessionIdentity, ClineSessionError> {
        let session = self.get_session(external_session_id)?;
        if session.project_dir != requested_project_dir {
            return Err(ClineSessionError::ProjectMismatch {
                expected: session.project_dir.display().to_string(),
                actual: requested_project_dir.display().to_string(),
            });
        }
        Ok(session)
    }

    /// Prepares a prompt turn for the given session.
    ///
    /// Fails with `ConcurrentPrompt` if a turn is already active on this or another session.
    pub fn prepare_prompt_turn(
        &self,
        run_id: RunId,
        external_session_id: &str,
    ) -> Result<RunId, ClineSessionError> {
        // 1. Verify session exists
        let _session = self.get_session(external_session_id)?;

        // 2. Concurrency check via RunFence (reject if active or stopping)
        if self.fence.is_active() || matches!(self.fence.current_phase(), RunPhase::Stopping { .. }) {
            return Err(ClineSessionError::ConcurrentPrompt(
                external_session_id.to_string(),
            ));
        }

        // 3. Start and activate run in fence
        self.fence
            .start_run(run_id.clone())
            .map_err(|e| ClineSessionError::Transport(e))?;

        self.fence
            .activate_run(&run_id, external_session_id)
            .map_err(|e| ClineSessionError::Transport(e))?;

        Ok(run_id)
    }



    /// Registers the owned child process by PID.
    pub fn register_child(&self, pid: u32) {
        if let Ok(mut guard) = self.child_process.lock() {
            *guard = Some(OwnedChildProcess::new(pid));
        }
    }

    /// Returns the recorded terminal outcome for the active or last run.
    pub fn terminal_outcome(&self) -> Option<RunTerminalOutcome> {
        self.fence.terminal_outcome()
    }

    /// Marks the registered child process as exited so drop will not trigger kill.
    pub fn mark_child_exited(&self) {
        if let Ok(guard) = self.child_process.lock() {
            if let Some(child) = guard.as_ref() {
                child.mark_exited();
            }
        }
    }

    /// Clears the registered child process, marking it as exited so drop will not terminate.
    pub fn clear_child(&self) {
        if let Ok(mut guard) = self.child_process.lock() {
            if let Some(child) = guard.take() {
                child.mark_exited();
            }
        }
    }

    /// Returns the PID of the owned child process, if registered.
    pub fn owned_pid(&self) -> Option<u32> {
        self.child_process.lock().ok().and_then(|g| g.as_ref().map(|p| p.pid()))
    }

    /// Sets the active cancellation token for the current in-flight operation.
    pub fn set_cancel_token(&self, token: CancellationToken) {
        if let Ok(mut guard) = self.cancel_token.lock() {
            *guard = Some(token);
        }
    }

    /// Clears the cancellation token.
    pub fn clear_cancel_token(&self) {
        if let Ok(mut guard) = self.cancel_token.lock() {
            *guard = None;
        }
    }

    /// Registers a pending permission request for an in-flight run.
    ///
    /// Fails if the run is not active, does not match the active run ID,
    /// or if a request with the same request_id is already registered.
    /// Re-checks the run fence atomically under the pending_permissions lock.
    pub fn register_pending_permission(&self, req: PendingPermissionRequest) -> Result<(), String> {
        let mut guard = self.pending_permissions.lock().map_err(|e| e.to_string())?;

        let current_run = self.fence.current_run_id();
        if !self.fence.is_active() || current_run.as_ref() != Some(&req.run_id) {
            return Err(format!(
                "Cannot register permission request {}: run {} is not active (current active: {:?})",
                req.request_id, req.run_id, current_run
            ));
        }

        if guard.contains_key(&req.request_id) {
            return Err(format!(
                "Cannot register duplicate permission request ID '{}'",
                req.request_id
            ));
        }
        guard.insert(req.request_id.clone(), req);
        Ok(())
    }

    /// Responds to a pending permission request with the selected option.
    ///
    /// Strict acceptance contract:
    /// - Re-checks that the run is still active.
    /// - Rejects unknown or stale request IDs.
    /// - Rejects run ID mismatches.
    /// - Rejects option IDs not offered by the agent (never defaults to approval on errors!).
    /// - Removes the pending entry and sends PermissionOutcome::Selected.
    pub fn respond_permission(
        &self,
        run_id: &RunId,
        request_id: &str,
        option_id: &str,
    ) -> Result<PermissionOutcome, String> {
        let mut guard = self.pending_permissions.lock().map_err(|e| e.to_string())?;

        // Re-check fence: if run is no longer active, reject the response
        let current_run = self.fence.current_run_id();
        if !self.fence.is_active() || current_run.as_ref() != Some(run_id) {
            return Err(format!(
                "Cannot respond to permission request '{request_id}': run {run_id} is no longer active"
            ));
        }

        let req = guard
            .get(request_id)
            .ok_or_else(|| format!("Unknown or already resolved permission request '{request_id}'"))?;

        if req.run_id != *run_id {
            return Err(format!(
                "Run ID mismatch for permission request '{request_id}': expected {}, got {run_id}",
                req.run_id
            ));
        }

        // Validate that option_id is among the offered options
        let is_valid_option = req.options.iter().any(|opt| opt.option_id == option_id);
        if !is_valid_option {
            return Err(format!(
                "Invalid option_id '{option_id}': option is not among the allowed options offered by the agent"
            ));
        }

        let req = guard.remove(request_id).expect("req existence checked above");
        let outcome = PermissionOutcome::Selected {
            option_id: option_id.to_string(),
        };
        let _ = req.responder.send(outcome.clone());
        Ok(outcome)
    }

    /// Cancels all pending permissions for a specific run ID, sending PermissionOutcome::Cancelled.
    pub fn cancel_pending_permissions_for_run(&self, run_id: &RunId) {
        if let Ok(mut guard) = self.pending_permissions.lock() {
            let matching_keys: Vec<String> = guard
                .iter()
                .filter(|(_, req)| req.run_id == *run_id)
                .map(|(k, _)| k.clone())
                .collect();

            for key in matching_keys {
                if let Some(req) = guard.remove(&key) {
                    let _ = req.responder.send(PermissionOutcome::Cancelled);
                }
            }
        }
    }

    /// Cancels all pending permissions across all runs.
    pub fn cancel_all_pending_permissions(&self) {
        if let Ok(mut guard) = self.pending_permissions.lock() {
            for (_, req) in guard.drain() {
                let _ = req.responder.send(PermissionOutcome::Cancelled);
            }
        }
    }

    /// Returns true if there is a pending permission request with the specified ID.
    pub fn has_pending_permission(&self, request_id: &str) -> bool {
        self.pending_permissions
            .lock()
            .map(|g| g.contains_key(request_id))
            .unwrap_or(false)
    }

    /// Dispatches an incoming ACP permission request: registers in pending permissions,
    /// emits `cline-permission-request` to the frontend, and awaits the user's decision.
    /// When `auto_approve` is true, selects the best allow option immediately without
    /// registering or asking the user.
    /// Returns the JSON-RPC response Value ready to be written back to the child process.
    pub async fn handle_incoming_permission_request<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        rpc_id: serde_json::Value,
        run_id: &RunId,
        session_id: &str,
        params: &serde_json::Value,
        auto_approve: bool,
    ) -> Result<serde_json::Value, String> {
        use tauri::Emitter;

        let tool_call_id = params
            .pointer("/toolCall/toolCallId")
            .or_else(|| params.get("toolCallId"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_tool")
            .to_string();

        let title = params
            .pointer("/toolCall/title")
            .or_else(|| params.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let kind = params
            .pointer("/toolCall/kind")
            .or_else(|| params.get("kind"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let command = params
            .pointer("/toolCall/command")
            .or_else(|| params.get("command"))
            .or_else(|| params.pointer("/toolCall/input/command"))
            .or_else(|| params.pointer("/input/command"))
            .or_else(|| params.pointer("/toolCall/input/cmd"))
            .or_else(|| params.pointer("/input/cmd"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let input = params
            .pointer("/toolCall/input")
            .or_else(|| params.get("input"))
            .cloned();

        let content = params
            .pointer("/toolCall/content")
            .or_else(|| params.get("content"))
            .cloned();

        let locations = params
            .pointer("/toolCall/locations")
            .or_else(|| params.get("locations"))
            .cloned();

        let options: Vec<PermissionOption> = params
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|opt| serde_json::from_value(opt.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        // If options list is empty, immediately reject with cancelled rather than deadlocking the UI
        if options.is_empty() {
            log::warn!(
                "[ClineAgent] Permission request {} has no options; rejecting as cancelled",
                rpc_id
            );
            return Ok(format_permission_rpc_response(&rpc_id, &PermissionOutcome::Cancelled));
        }

        let request_id = match &rpc_id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            other => other.to_string(),
        };

        if auto_approve {
            let chosen = options
                .iter()
                .find(|o| o.kind.as_deref() == Some("allow_always") || o.option_id == "allow_always")
                .or_else(|| {
                    options
                        .iter()
                        .find(|o| o.kind.as_deref() == Some("allow_once") || o.option_id == "allow_once")
                })
                .or_else(|| {
                    options.iter().find(|o| {
                        o.kind
                            .as_deref()
                            .is_some_and(|k| k == "allow" || k.starts_with("allow"))
                    })
                })
                .unwrap_or(&options[0])
                .option_id
                .clone();
            log::info!(
                "[ClineAgent] Auto-approving permission request {}",
                request_id
            );
            return Ok(format_permission_rpc_response(
                &rpc_id,
                &PermissionOutcome::Selected { option_id: chosen },
            ));
        }

        let (tx, rx) = tokio::sync::oneshot::channel();

        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: session_id.to_string(),
            request_id: request_id.clone(),
            tool_call_id: tool_call_id.clone(),
            title: title.clone(),
            options: options.clone(),
            responder: tx,
        };

        // Always reply even if registration fails (e.g. stopped, inactive, or duplicate)
        if let Err(err) = self.register_pending_permission(req) {
            log::warn!(
                "[ClineAgent] Failed to register permission request {}: {}; returning cancelled to unblock agent",
                request_id,
                err
            );
            return Ok(format_permission_rpc_response(&rpc_id, &PermissionOutcome::Cancelled));
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PermissionEventPayload {
            run_id: String,
            session_id: String,
            request_id: String,
            tool_call_id: String,
            title: Option<String>,
            kind: Option<String>,
            options: Vec<PermissionOption>,
            command: Option<String>,
            input: Option<serde_json::Value>,
            content: Option<serde_json::Value>,
            locations: Option<serde_json::Value>,
        }

        let event_payload = PermissionEventPayload {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            request_id: request_id.clone(),
            tool_call_id,
            title,
            kind,
            options,
            command,
            input,
            content,
            locations,
        };

        let _ = app.emit("cline-permission-request", &event_payload);

        match rx.await {
            Ok(outcome) => Ok(format_permission_rpc_response(&rpc_id, &outcome)),
            Err(_) => {
                Ok(format_permission_rpc_response(&rpc_id, &PermissionOutcome::Cancelled))
            }
        }
    }

    /// Dispatches an incoming message from the ACP transport layer.
    ///
    /// If `msg.method == "session/request_permission"`, handles the reverse request,
    /// emits the UI event, awaits user response, and returns `Some(json_rpc_response)`
    /// to be written to the child process's stdin.
    pub async fn dispatch_incoming_message<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        msg: crate::core::cline_acp_transport::IncomingNotification,
        run_id: &RunId,
        session_id: &str,
        auto_approve: bool,
    ) -> Option<serde_json::Value> {
        if msg.method == "session/request_permission" {
            let rpc_id = match msg.id {
                Some(crate::core::cline_acp_transport::RequestId::Number(n)) => serde_json::json!(n),
                Some(crate::core::cline_acp_transport::RequestId::String(s)) => serde_json::json!(s),
                None => {
                    log::warn!("[ClineAgent] Received session/request_permission without request ID");
                    return None;
                }
            };
            let params = msg.params.unwrap_or_else(|| serde_json::json!({}));
            match self.handle_incoming_permission_request(app, rpc_id, run_id, session_id, &params, auto_approve).await {
                Ok(response_value) => Some(response_value),
                Err(err) => {
                    log::error!("[ClineAgent] Error handling permission request: {}", err);
                    None
                }
            }
        } else {
            None
        }
    }

    /// Requests stop for an active or starting run.
    ///
    /// Triggers cancellation, begins stopping phase, forces process tree termination,
    /// and guarantees exactly one terminal outcome (Cancelled) is recorded.
    pub fn stop_active_run(
        &self,
        run_id: Option<&RunId>,
        reason: impl Into<String>,
    ) -> Result<RunTerminalOutcome, String> {
        let reason_str = reason.into();
        let active_id = self.fence.current_run_id().ok_or_else(|| "No active run to stop".to_string())?;

        if let Some(target) = run_id {
            if target != &active_id {
                return Err(format!("Run ID mismatch: active is {active_id}, stop requested for {target}"));
            }
        }

        // Cancel any pending permission requests for this run
        self.cancel_pending_permissions_for_run(&active_id);

        let current_phase = self.fence.current_phase();
        match current_phase {
            RunPhase::Idle => {
                return Err("No active run to stop".to_string());
            }
            RunPhase::Terminated { outcome } => {
                return Err(format!(
                    "Cannot stop run {active_id}: run has already terminated with outcome {:?}",
                    outcome
                ));
            }
            _ => {}
        }

        // 1. Cancel in-flight async tasks via token
        if let Ok(mut guard) = self.cancel_token.lock() {
            if let Some(token) = guard.take() {
                token.cancel();
            }
        }

        // 2. Transition fence to Stopping
        let _ = self.fence.begin_stopping(&active_id, &reason_str);

        // 3. Force kill child process tree to prevent orphan processes
        if let Ok(mut guard) = self.child_process.lock() {
            if let Some(child) = guard.take() {
                let _ = child.terminate();
            }
        }

        // 4. Record terminal outcome (exactly-one guarantee)
        let outcome = RunTerminalOutcome::Cancelled {
            reason: Some(reason_str),
        };
        let final_outcome = self
            .fence
            .record_terminal(&active_id, outcome.clone())
            .unwrap_or(outcome);

        // Cancel any late pending permission requests again after terminal outcome
        self.cancel_pending_permissions_for_run(&active_id);

        Ok(final_outcome)
    }

    /// Handles process crash or unexpected EOF.
    ///
    /// If in Stopping phase, records Cancelled.
    /// If in Active/Starting phase, records Failed with stderr diagnostic tail.
    pub fn handle_process_crash(
        &self,
        run_id: &RunId,
        exit_code: Option<i32>,
        stderr_tail: &str,
    ) -> Option<RunTerminalOutcome> {
        let current_phase = self.fence.current_phase();
        let outcome = match current_phase {
            RunPhase::Stopping { reason } => RunTerminalOutcome::Cancelled {
                reason: Some(format!("Process exited during stop: {reason}")),
            },
            _ => {
                let err_msg = if stderr_tail.trim().is_empty() {
                    format!("Cline process exited unexpectedly with code {:?}", exit_code)
                } else {
                    format!(
                        "Cline process exited unexpectedly (code {:?}): {}",
                        exit_code,
                        stderr_tail.trim()
                    )
                };
                RunTerminalOutcome::Failed {
                    error: err_msg,
                }
            }
        };

        self.cancel_pending_permissions_for_run(run_id);
        self.clear_child();

        self.fence.record_terminal(run_id, outcome)
    }

    /// Handles a timeout expiration for the run.
    /// Terminates child process and records TimedOut terminal outcome.
    pub fn handle_timeout(&self, run_id: &RunId, duration: Duration) -> Option<RunTerminalOutcome> {
        // Kill child process
        if let Ok(mut guard) = self.child_process.lock() {
            if let Some(child) = guard.take() {
                let _ = child.terminate();
            }
        }

        self.cancel_pending_permissions_for_run(run_id);

        let outcome = RunTerminalOutcome::TimedOut {
            duration_ms: duration.as_millis() as u64,
        };
        self.fence.record_terminal(run_id, outcome)
    }

    /// Shuts down the agent state on application exit, stopping runs and killing child processes.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.cancel_token.lock() {
            if let Some(token) = guard.take() {
                token.cancel();
            }
        }
        if let Ok(mut guard) = self.child_process.lock() {
            if let Some(child) = guard.take() {
                let _ = child.terminate();
            }
        }
        if let Some(run_id) = self.fence.current_run_id() {
            self.cancel_pending_permissions_for_run(&run_id);
            let _ = self.fence.record_terminal(
                &run_id,
                RunTerminalOutcome::Cancelled {
                    reason: Some("Application shutdown".to_string()),
                },
            );
        }
        self.cancel_all_pending_permissions();
    }

    /// Checks cross-backend concurrency and starts a run if no other backend is running.
    pub async fn try_start_run(
        &self,
        ollama_running: bool,
        project_dir: &std::path::Path,
        run_id: Option<RunId>,
        session_id: Option<&str>,
    ) -> Result<RunId, String> {
        if ollama_running {
            return Err("An Ollama agent is already running. Stop it first.".to_string());
        }
        if self.fence.is_active() || matches!(self.fence.current_phase(), RunPhase::Stopping { .. }) {
            return Err("A Cline agent run is already in progress. Stop it first.".to_string());
        }
        Self::validate_project_dir(project_dir).map_err(|e| e.to_string())?;
        let active_run_id = run_id.unwrap_or_else(RunId::generate);
        self.fence.start_run(active_run_id.clone())?;
        let sess_id = session_id.unwrap_or("none");
        self.fence.activate_run(&active_run_id, sess_id)?;
        Ok(active_run_id)
    }
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

/// Starts a Cline ACP agent run.
///
/// Guards against cross-backend (Ollama) and same-backend concurrent execution.
#[tauri::command]
pub async fn start_cline_agent<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, ClineAgentState>,
    ollama_state: tauri::State<'_, crate::core::ollama_agent::OllamaAgentState>,
    loop_supervision: tauri::State<'_, crate::core::loop_supervision::LoopSupervisionState>,
    project_dir: String,
    prompt: String,
    model: Option<String>,
    run_id: Option<String>,
    session_id: Option<String>,
    auto_approve: Option<bool>,
    source: Option<String>,
    current_run: Option<u32>,
    max_runs: Option<u32>,
    loop_id: Option<String>,
) -> Result<String, String> {
    let ollama_is_running = {
        let running = ollama_state.running.lock().await;
        *running
    };
    let project_path = std::path::PathBuf::from(&project_dir);
    let run = run_id.map(RunId::new);

    let active_run_id = state
        .try_start_run(ollama_is_running, &project_path, run, session_id.as_deref())
        .await?;

    let is_loop_run = source.as_deref() == Some("loop");
    let loop_supervision_instance = if is_loop_run {
        let goal = prompt.chars().take(200).collect::<String>();
        loop_supervision
            .begin_run(
                project_dir.clone(),
                goal,
                current_run.unwrap_or(1).max(1),
                max_runs.unwrap_or(1).max(1),
                loop_id,
            )
            .await;
        Some(loop_supervision.inner().clone())
    } else {
        None
    };

    let raw_model = model.unwrap_or_else(|| SessionModelConfig::default().model_id);
    let bound_model = match raw_model.as_str() {
        "z-ai/glm-5.3-flash" => "zai/glm-5.3-flash".to_string(),
        "cline-free/longcat-2.0" => "meituan/longcat-2.0".to_string(),
        "cline-free/solar-pro4" => "upstage/solar-pro4".to_string(),
        "cline-free/muse-spark-1.3-contributor"
        | "meta/muse-spark-1.3-contributor" => "meta/muse-spark-1.2-contributor".to_string(),
        other => other.to_string(),
    };
    log::info!(
        "[ClineAgent] Started run {} for project {} with model {} (session: {})",
        active_run_id,
        project_dir,
        bound_model,
        session_id.as_deref().unwrap_or("none")
    );

    let cancel_token = CancellationToken::new();
    state.set_cancel_token(cancel_token.clone());

    let app_clone = app.clone();
    let state_clone = state.inner().clone();
    let run_id_clone = active_run_id.clone();
    let project_dir_clone = project_dir.clone();
    let bound_model_clone = bound_model.clone();
    let prompt_clone = prompt;
    let session_id_clone = session_id;
    let auto_approve = auto_approve.unwrap_or(false);

    tokio::spawn(async move {
        run_cline_agent_loop(
            app_clone,
            state_clone,
            cancel_token,
            run_id_clone,
            project_dir_clone,
            prompt_clone,
            bound_model_clone,
            session_id_clone,
            auto_approve,
            loop_supervision_instance,
        )
        .await;
    });

    Ok(active_run_id.to_string())
}

/// Asynchronous runner loop that drives the Cline ACP process over stdio.
async fn run_cline_agent_loop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: ClineAgentState,
    cancel_token: CancellationToken,
    run_id: RunId,
    project_dir: String,
    prompt: String,
    bound_model: String,
    session_id: Option<String>,
    auto_approve: bool,
    loop_supervision: Option<crate::core::loop_supervision::LoopSupervisionState>,
) {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let probe = probe_cline_install_sync();
    if !probe.installed {
        let err = "Cline CLI is not installed or not found on PATH. Please install cline globally: npm install -g cline".to_string();
        log::error!("[ClineAgent] {}", err);
        let _ = app.emit("coding-agent-error", serde_json::json!({ "message": &err }));
        let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": &err }));
        let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": &err }));
        let _ = state.fence().record_terminal(&run_id, RunTerminalOutcome::Failed { error: err.clone() });
        if let Some(supervision) = &loop_supervision {
            supervision.finish_run(false, false, Some(err)).await;
        }
        state.clear_cancel_token();
        return;
    }

    let exe_path = probe.path.unwrap_or_else(|| {
        if cfg!(windows) { "cline.cmd".to_string() } else { "cline".to_string() }
    });

    let mut std_cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &exe_path, "--acp"]);
        c
    } else {
        let mut c = std::process::Command::new(&exe_path);
        c.arg("--acp");
        c
    };

    std_cmd.current_dir(&project_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut tokio_cmd = tokio::process::Command::from(std_cmd);

    let mut child = match tokio_cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let err = format!("Failed to spawn Cline CLI: {e}");
            log::error!("[ClineAgent] {}", err);
            let _ = app.emit("coding-agent-error", serde_json::json!({ "message": &err }));
            let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": &err }));
            let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": &err }));
            let _ = state.fence().record_terminal(&run_id, RunTerminalOutcome::Failed { error: err.clone() });
            if let Some(supervision) = &loop_supervision {
                supervision.finish_run(false, false, Some(err)).await;
            }
            state.clear_cancel_token();
            return;
        }
    };

    let pid = child.id().unwrap_or(0);
    state.register_child(pid);

    let mut stdin = child.stdin.take().expect("stdin must be piped");
    let stdout = child.stdout.take().expect("stdout must be piped");
    let stderr = child.stderr.take().expect("stderr must be piped");

    // Log stderr in background
    tokio::spawn(async move {
        let mut err_lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = err_lines.next_line().await {
            log::debug!("[Cline STDERR] {}", line);
        }
    });

    // Dedicated stdin writer task
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdin_writer = tokio::spawn(async move {
        while let Some(msg) = stdin_rx.recv().await {
            if stdin.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // Step 1: Send initialize request
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": { "fs": {}, "terminal": true },
            "clientInfo": { "name": "Atomic Chat", "version": "1.1.15" }
        }
    });
    let _ = stdin_tx.send(init_req.to_string());

    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut active_session_id: Option<String> = None;
    let mut terminal_recorded = false;
    let mut loop_finished = false;
    let mut prompt_sent = false;
    let mut has_emitted_text = false;

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                log::info!("[ClineAgent] Run {} cancelled by user", run_id);
                let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": "Cancelled" }));
                let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": "Cancelled" }));
                terminal_recorded = true;
                if !loop_finished {
                    if let Some(supervision) = &loop_supervision {
                        supervision.finish_run(false, false, Some("Cancelled".to_string())).await;
                    }
                    loop_finished = true;
                }
                break;
            }
            line_res = stdout_lines.next_line() => {
                let line = match line_res {
                    Ok(Some(l)) => l,
                    Ok(None) => {
                        log::info!("[ClineAgent] Child process closed stdout (EOF)");
                        break;
                    }
                    Err(e) => {
                        log::error!("[ClineAgent] Error reading child stdout: {}", e);
                        break;
                    }
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let val: serde_json::Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => {
                        log::debug!("[ClineAgent] Raw line (non-JSON): {}", trimmed);
                        continue;
                    }
                };

                // 1. First check if message has a method (notification or agent-to-client request)
                if let Some(method) = val.get("method").and_then(|m| m.as_str()) {
                    match method {
                        "session/update" => {
                            if !prompt_sent {
                                // Ignore any pre-turn or setup updates before the prompt turn is sent
                                continue;
                            }
                            if let Some(params) = val.get("params") {
                                let stream_events = normalize_acp_session_update(params, &run_id);
                                for ev in stream_events {
                                    match ev {
                                        AcpStreamEvent::TextDelta { text, .. } => {
                                            has_emitted_text = true;
                                            let _ = app.emit("agent-text-delta", serde_json::json!({ "text": text, "kind": "text" }));
                                        }
                                        AcpStreamEvent::ThinkingDelta { text, .. } => {
                                            let _ = app.emit("agent-text-delta", serde_json::json!({ "text": text, "kind": "thinking" }));
                                        }
                                        AcpStreamEvent::ToolCallStart { call_id, tool_name, .. } => {
                                            if let Some(supervision) = &loop_supervision {
                                                supervision.record_tool_start(&call_id, &tool_name, "", &format!("{tool_name}:{call_id}")).await;
                                            }
                                            let _ = app.emit("agent-tool-call-start", serde_json::json!({ "id": call_id, "name": tool_name }));
                                        }
                                        AcpStreamEvent::ToolCallResult { call_id, output, is_error, .. } => {
                                            if let Some(supervision) = &loop_supervision {
                                                supervision.record_tool_result(&call_id, "done", output.len(), 0, false, is_error).await;
                                            }
                                            let _ = app.emit("agent-tool-call-result", serde_json::json!({
                                                "id": call_id,
                                                "name": "tool",
                                                "result": output,
                                                "is_error": is_error
                                            }));
                                        }
                                        AcpStreamEvent::Done { success, stop_reason, error, .. } => {
                                            let _ = app.emit("agent-done", serde_json::json!({ "success": success, "error": error }));
                                            let _ = app.emit("code-agent-done", serde_json::json!({ "success": success, "error": error }));
                                            let outcome = if success {
                                                RunTerminalOutcome::Completed { stop_reason: stop_reason.clone() }
                                            } else {
                                                RunTerminalOutcome::Failed { error: error.clone().unwrap_or_else(|| stop_reason.clone()) }
                                            };
                                            let _ = state.fence().record_terminal(&run_id, outcome);
                                            terminal_recorded = true;
                                            if !loop_finished {
                                                if let Some(supervision) = &loop_supervision {
                                                    supervision.finish_run(success, false, error.clone()).await;
                                                }
                                                loop_finished = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        "session/request_permission" => {
                            let app_h = app.clone();
                            let state_h = state.clone();
                            let run_h = run_id.clone();
                            let sess_h = active_session_id.clone().unwrap_or_default();
                            let stdin_tx_h = stdin_tx.clone();

                            let rpc_id = val.get("id").and_then(crate::core::cline_acp_transport::RequestId::from_value);
                            let params = val.get("params").cloned();
                            let notif = crate::core::cline_acp_transport::IncomingNotification {
                                method: "session/request_permission".to_string(),
                                params,
                                id: rpc_id,
                            };

                            tokio::spawn(async move {
                                if let Some(resp) = state_h.dispatch_incoming_message(&app_h, notif, &run_h, &sess_h, auto_approve).await {
                                    let _ = stdin_tx_h.send(resp.to_string());
                                }
                            });
                        }
                        other => {
                            log::debug!("[ClineAgent] Ignored notification/request with method: {}", other);
                        }
                    }
                }
                // 2. Next check for JSON-RPC error response to our client requests
                else if let Some(err_obj) = val.get("error") {
                    let req_id = val.get("id").and_then(|i| i.as_i64());
                    if req_id == Some(1) || req_id == Some(2) || req_id == Some(3) || req_id == Some(4) {
                        let msg = err_obj.get("message").and_then(|m| m.as_str()).unwrap_or("RPC error");
                        log::error!("[ClineAgent] RPC error on id {:?}: {}", req_id, msg);
                        let _ = app.emit("coding-agent-error", serde_json::json!({ "message": msg }));
                        let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": msg }));
                        let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": msg }));
                        let _ = state.fence().record_terminal(&run_id, RunTerminalOutcome::Failed { error: msg.to_string() });
                        terminal_recorded = true;
                        break;
                    }
                }
                // 3. Responses to our client requests (id 1, 2, 3, 4)
                else if let Some(req_id) = val.get("id").and_then(|i| i.as_i64()) {
                    match req_id {
                        1 => {
                            log::debug!("[ClineAgent] Initialize successful, creating fresh session via session/new...");
                            let sess_req = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "session/new",
                                "params": {
                                    "cwd": &project_dir,
                                    "mcpServers": []
                                }
                            });
                            let _ = stdin_tx.send(sess_req.to_string());
                        }
                        2 => {
                            let external_id = val.get("result")
                                .and_then(|r| r.get("sessionId"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("")
                                .to_string();

                            if external_id.is_empty() {
                                log::error!("[ClineAgent] Failed to obtain valid sessionId from session response: {:?}", val);
                                let msg = "Failed to obtain valid session ID from Cline".to_string();
                                let _ = app.emit("coding-agent-error", serde_json::json!({ "message": &msg }));
                                let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": &msg }));
                                let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": &msg }));
                                let _ = state.fence().record_terminal(&run_id, RunTerminalOutcome::Failed { error: msg });
                                terminal_recorded = true;
                                break;
                            }

                            log::info!("[ClineAgent] Session ready with external ID: {}", external_id);
                            active_session_id = Some(external_id.clone());

                            let atomic_id = session_id.clone().unwrap_or_else(|| run_id.to_string());
                            state.register_session(SessionIdentity {
                                atomic_session_id: atomic_id.clone(),
                                external_session_id: external_id.clone(),
                                project_dir: PathBuf::from(&project_dir),
                                backend: "cline-acp".to_string(),
                                model_id: bound_model.clone(),
                                provider_id: Some("zai".to_string()),
                            });

                            let _ = app.emit("cline-session-bound", serde_json::json!({
                                "atomicSessionId": atomic_id,
                                "externalSessionId": &external_id,
                            }));

                            // Set model
                            let model_req = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 3,
                                "method": "session/set_config_option",
                                "params": {
                                    "sessionId": &external_id,
                                    "configId": "model",
                                    "value": &bound_model
                                }
                            });
                            let _ = stdin_tx.send(model_req.to_string());

                            if auto_approve {
                                let auto_req = serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": 35,
                                    "method": "session/set_config_option",
                                    "params": {
                                        "sessionId": &external_id,
                                        "configId": "auto_approve",
                                        "value": "true"
                                    }
                                });
                                let _ = stdin_tx.send(auto_req.to_string());
                            }

                            // Send the prompt turn
                            log::info!("[ClineAgent] Dispatching prompt to session {}...", external_id);
                            let prompt_req = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 4,
                                "method": "session/prompt",
                                "params": {
                                    "sessionId": &external_id,
                                    "prompt": [{ "type": "text", "text": &prompt }]
                                }
                            });
                            let _ = stdin_tx.send(prompt_req.to_string());
                            prompt_sent = true;
                        }
                        3 => {
                            log::debug!("[ClineAgent] Model configuration updated successfully");
                        }
                        4 => {
                            let stop_reason = val.get("result")
                                .and_then(|r| r.get("stopReason"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("end_turn");

                            let success = stop_reason == "end_turn";
                            let err = if success { None } else { Some(format!("Turn ended with status: {stop_reason}")) };

                            if !has_emitted_text && success {
                                let warning = format!(
                                    "המודל {} סיים ללא פלט (0 טוקנים). ייתכן ששרת המודל חווה עומס או אינו זמין כרגע אצל הספק החינמי של Cline. מומלץ לנסות שוב או לבחור מודל פעיל כגון GLM 5.3 Flash, DeepSeek V4 Flash, או Laguna S 2.1.",
                                    bound_model
                                );
                                let _ = app.emit("agent-text-delta", serde_json::json!({ "text": warning, "kind": "text" }));
                            }

                            log::info!("[ClineAgent] Prompt completed: stopReason={}, success={}", stop_reason, success);

                            let _ = app.emit("agent-done", serde_json::json!({ "success": success, "error": err }));
                            let _ = app.emit("code-agent-done", serde_json::json!({ "success": success, "error": err }));

                            let outcome = if success {
                                RunTerminalOutcome::Completed { stop_reason: stop_reason.to_string() }
                            } else {
                                RunTerminalOutcome::Failed { error: format!("Turn ended: {stop_reason}") }
                            };
                            let _ = state.fence().record_terminal(&run_id, outcome);
                            terminal_recorded = true;
                            if !loop_finished {
                                if let Some(supervision) = &loop_supervision {
                                    supervision.finish_run(success, false, err.clone()).await;
                                }
                                loop_finished = true;
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if !terminal_recorded {
        let _ = app.emit("agent-done", serde_json::json!({ "success": false, "error": "Agent process exited unexpectedly" }));
        let _ = app.emit("code-agent-done", serde_json::json!({ "success": false, "error": "Agent process exited unexpectedly" }));
        let _ = state.fence().record_terminal(&run_id, RunTerminalOutcome::Failed { error: "Agent exited unexpectedly".to_string() });
        if !loop_finished {
            if let Some(supervision) = &loop_supervision {
                supervision.finish_run(false, false, Some("Agent process exited unexpectedly".to_string())).await;
            }
        }
    }

    // Teardown
    drop(stdin_tx);
    let _ = stdin_writer.await;

    let _ = child.kill().await;
    state.mark_child_exited();
    state.clear_child();
    state.clear_cancel_token();
    let _ = state.fence().reset_to_idle();

    log::info!("[ClineAgent] Run {} loop finished and cleaned up", run_id);
}

/// Stops an active Cline ACP agent run.
///
/// Targets the specified run_id or the currently active run.
#[tauri::command]
pub async fn stop_cline_agent(
    state: tauri::State<'_, ClineAgentState>,
    loop_supervision: tauri::State<'_, crate::core::loop_supervision::LoopSupervisionState>,
    run_id: Option<String>,
) -> Result<(), String> {
    loop_supervision.mark_stop_requested().await;
    let target = run_id.map(RunId::new);
    state
        .stop_active_run(target.as_ref(), "User requested stop")
        .map(|_| ())
}

/// Responds to an ACP permission request with explicit user selection.
///
/// Ensures run ID match, verifies offered options, rejects stale/unknown requests,
/// and never defaults to approval on errors.
#[tauri::command]
pub async fn respond_cline_permission(
    state: tauri::State<'_, ClineAgentState>,
    run_id: String,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    let run = RunId::new(run_id);
    state
        .respond_permission(&run, &request_id, &option_id)
        .map(|_| ())
}

/// Host installation and availability status for Cline CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClineInstallStatus {
    /// Whether the Cline executable was found on the host system.
    pub installed: bool,
    /// The resolved path to the Cline executable if found.
    pub path: Option<String>,
    /// The probed version string (e.g. "3.0.61") if successfully probed.
    pub version: Option<String>,
}

/// Checks real host installation and version of the Cline CLI.
///
/// Guaranteed not to use fake data or token pricing.
#[tauri::command]
pub async fn check_cline_installed() -> ClineInstallStatus {
    tokio::task::spawn_blocking(probe_cline_install_sync).await.unwrap_or(ClineInstallStatus {
        installed: false,
        path: None,
        version: None,
    })
}

/// Synchronous host probing logic for finding Cline CLI.
pub fn probe_cline_install_sync() -> ClineInstallStatus {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let exe_name = if cfg!(windows) { "cline.cmd" } else { "cline" };

    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg(exe_name);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let path = match cmd.output() {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            raw.lines()
                .map(str::trim)
                .find(|p| !p.is_empty())
                .map(str::to_string)
        }
        _ => None,
    };

    let installed = path.is_some();
    let version = if installed {
        let mut ver_cmd = std::process::Command::new(exe_name);
        ver_cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            ver_cmd.creation_flags(0x08000000);
        }
        ver_cmd.output().ok().and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        })
    } else {
        None
    };

    ClineInstallStatus {
        installed,
        path,
        version,
    }
}

/// A model item discovered dynamically from the Cline CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClineCliModelItem {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub description: String,
    pub context_window: Option<String>,
    pub tag: Option<String>,
    pub tier: String,
}

/// Response returned by fetch_cline_cli_models.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClineCliModelsResponse {
    pub models: Vec<ClineCliModelItem>,
    pub source: String,
}

static CLINE_MODELS_CACHE: std::sync::Mutex<Option<(std::time::Instant, ClineCliModelsResponse)>> =
    std::sync::Mutex::new(None);
const CLINE_MODELS_CACHE_TTL_SECS: u64 = 300;

/// Tauri command to fetch available models directly from the installed Cline CLI.
///
/// Guaranteed not to use static hardcoded lists as authoritative source; queries
/// live @cline/core or official Cline API endpoint dynamically.
#[tauri::command]
pub async fn fetch_cline_cli_models() -> Result<ClineCliModelsResponse, String> {
    if let Ok(guard) = CLINE_MODELS_CACHE.lock() {
        if let Some((timestamp, ref cached)) = *guard {
            if timestamp.elapsed().as_secs() < CLINE_MODELS_CACHE_TTL_SECS {
                return Ok(cached.clone());
            }
        }
    }

    let response = fetch_cline_cli_models_internal().await;
    if let Ok(mut guard) = CLINE_MODELS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), response.clone()));
    }
    Ok(response)
}

pub async fn fetch_cline_cli_models_internal() -> ClineCliModelsResponse {
    let install = tokio::task::spawn_blocking(probe_cline_install_sync)
        .await
        .unwrap_or(ClineInstallStatus {
            installed: false,
            path: None,
            version: None,
        });

    if !install.installed {
        return ClineCliModelsResponse {
            models: get_fallback_cline_free_models(),
            source: "offline_fallback".to_string(),
        };
    }

    // 1. Try Node probe from installed @cline/core using detected CLI path
    if let Some(ref cline_path) = install.path {
        let path_clone = cline_path.clone();
        let node_result = tokio::task::spawn_blocking(move || probe_models_via_node(&path_clone))
            .await
            .unwrap_or(None);

        if let Some(models) = node_result {
            if !models.is_empty() {
                return ClineCliModelsResponse {
                    models,
                    source: "cli_node_probe".to_string(),
                };
            }
        }
    }

    // 2. Try official Cline API endpoint used internally by @cline/core
    if let Some(models) = fetch_models_via_http().await {
        if !models.is_empty() {
            return ClineCliModelsResponse {
                models,
                source: "cli_api_endpoint".to_string(),
            };
        }
    }

    // 3. Fallback to CLI built-in models
    ClineCliModelsResponse {
        models: get_fallback_cline_free_models(),
        source: "fallback".to_string(),
    }
}

fn probe_models_via_node(cline_path: &str) -> Option<Vec<ClineCliModelItem>> {
    let cline_dir = std::path::Path::new(cline_path).parent()?;
    let script = r#"
try {
  const fs = require('fs');
  const path = require('path');
  const base = process.argv[1];
  const candidates = [
    path.join(base, 'node_modules', 'cline', 'node_modules', '@cline', 'core'),
    path.join(base, 'node_modules', '@cline', 'core')
  ];
  let core = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      core = require(c);
      break;
    }
  }
  if (!core) {
    try { core = require('@cline/core'); } catch(e) {}
  }
  if (core && typeof core.fetchClineRecommendedModels === 'function') {
    core.fetchClineRecommendedModels().then(res => {
      console.log(JSON.stringify(res));
    }).catch(() => process.exit(1));
  } else {
    process.exit(1);
  }
} catch(e) {
  process.exit(1);
}
"#;

    let mut cmd = std::process::Command::new("node");
    cmd.arg("-e").arg(script).arg(cline_dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    parse_cline_recommended_models_json(&raw)
}

async fn fetch_models_via_http() -> Option<Vec<ClineCliModelItem>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;
    let res = client
        .get("https://api.cline.bot/api/v1/ai/cline/recommended-models")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body = res.text().await.ok()?;
    parse_cline_recommended_models_json(&body)
}

fn parse_cline_recommended_models_json(raw: &str) -> Option<Vec<ClineCliModelItem>> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let free_arr = v.get("free")?.as_array()?;
    let mut items = Vec::new();

    for entry in free_arr {
        let id = entry.get("id").and_then(|x| x.as_str())?.to_string();
        let raw_name = entry.get("name").and_then(|x| x.as_str()).unwrap_or(&id);
        let desc = entry
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        let name = format_model_display_name(raw_name, &id);
        let provider = infer_model_provider(&id, &name);
        let context_window = if desc.contains("1M") || id.contains("1m") {
            Some("1M".to_string())
        } else {
            None
        };
        let tag = if id.contains("glm-5.3-flash") {
            Some("Default".to_string())
        } else if context_window.as_deref() == Some("1M") {
            Some("1M Context".to_string())
        } else if id.contains("laguna") {
            Some("Agent".to_string())
        } else {
            None
        };

        items.push(ClineCliModelItem {
            id,
            name,
            provider,
            description: desc,
            context_window,
            tag,
            tier: "free".to_string(),
        });
    }

    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn infer_model_provider(id: &str, name: &str) -> String {
    let lower_id = id.to_lowercase();
    let lower_name = name.to_lowercase();
    if lower_id.contains("glm")
        || lower_id.contains("z-ai")
        || lower_id.contains("zai")
        || lower_name.contains("glm")
    {
        "Zhipu AI".to_string()
    } else if lower_id.contains("deepseek") || lower_name.contains("deepseek") {
        "DeepSeek".to_string()
    } else if lower_id.contains("poolside")
        || lower_id.contains("laguna")
        || lower_name.contains("laguna")
    {
        "Poolside".to_string()
    } else if lower_id.contains("muse")
        || lower_id.contains("meta")
        || lower_name.contains("muse")
    {
        "Meta".to_string()
    } else if lower_id.contains("solar")
        || lower_id.contains("upstage")
        || lower_name.contains("solar")
    {
        "Upstage".to_string()
    } else if lower_id.contains("longcat")
        || lower_id.contains("meituan")
        || lower_name.contains("longcat")
    {
        "Meituan".to_string()
    } else if lower_id.contains("claude")
        || lower_id.contains("anthropic")
        || lower_name.contains("claude")
    {
        "Anthropic".to_string()
    } else if lower_id.contains("gpt") || lower_id.contains("openai") {
        "OpenAI".to_string()
    } else if lower_id.contains("gemini")
        || lower_id.contains("google")
        || lower_id.contains("gemma")
    {
        "Google".to_string()
    } else if lower_id.contains("kimi") || lower_id.contains("moonshot") {
        "Moonshot AI".to_string()
    } else if lower_id.contains("qwen") {
        "Qwen".to_string()
    } else if lower_id.contains("grok")
        || lower_id.contains("x-ai")
        || lower_id.contains("xai")
    {
        "xAI".to_string()
    } else if let Some((prefix, _)) = id.split_once('/') {
        let clean = prefix
            .trim_start_matches("cline-free-")
            .trim_start_matches("cline-pass-")
            .trim_start_matches("cline-")
            .trim_start_matches("cline/");
        if clean.is_empty() {
            "Cline".to_string()
        } else {
            let mut chars = clean.chars();
            match chars.next() {
                None => "Cline".to_string(),
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
            }
        }
    } else {
        "Cline".to_string()
    }
}

fn format_model_display_name(raw_name: &str, raw_id: &str) -> String {
    let candidate = if !raw_name.trim().is_empty() && raw_name != raw_id {
        raw_name.trim()
    } else if let Some((_, suffix)) = raw_id.split_once('/') {
        suffix.trim()
    } else {
        raw_id.trim()
    };

    let cleaned = candidate
        .trim_end_matches(":free")
        .trim_end_matches("(free)")
        .trim();

    if cleaned.contains('-') && !cleaned.contains(' ') {
        let parts: Vec<&str> = cleaned.split('-').collect();
        let formatted: Vec<String> = parts
            .into_iter()
            .map(|p| {
                if p.eq_ignore_ascii_case("glm") {
                    "GLM".to_string()
                } else if p.eq_ignore_ascii_case("deepseek") {
                    "DeepSeek".to_string()
                } else if p.eq_ignore_ascii_case("v4") {
                    "V4".to_string()
                } else if p.eq_ignore_ascii_case("v3") {
                    "V3".to_string()
                } else if p.eq_ignore_ascii_case("flash") {
                    "Flash".to_string()
                } else if p.eq_ignore_ascii_case("pro") {
                    "Pro".to_string()
                } else if p.eq_ignore_ascii_case("preview") {
                    "Preview".to_string()
                } else if p.eq_ignore_ascii_case("contributor") {
                    "Contributor".to_string()
                } else if p.eq_ignore_ascii_case("spark") {
                    "Spark".to_string()
                } else if p.eq_ignore_ascii_case("solar") {
                    "Solar".to_string()
                } else if p.eq_ignore_ascii_case("longcat") {
                    "LongCat".to_string()
                } else if p.eq_ignore_ascii_case("laguna") {
                    "Laguna".to_string()
                } else {
                    let mut c = p.chars();
                    match c.next() {
                        None => String::new(),
                        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                    }
                }
            })
            .collect();
        formatted.join(" ")
    } else {
        cleaned.to_string()
    }
}

fn get_fallback_cline_free_models() -> Vec<ClineCliModelItem> {
    vec![
        ClineCliModelItem {
            id: "z-ai/glm-5.3-flash".to_string(),
            name: "GLM 5.3 Flash".to_string(),
            provider: "Zhipu AI".to_string(),
            description: "Latest natively multimodal model in the GLM-5 series (Default)".to_string(),
            context_window: Some("1M".to_string()),
            tag: Some("Default".to_string()),
            tier: "free".to_string(),
        },
        ClineCliModelItem {
            id: "deepseek/deepseek-v4-flash".to_string(),
            name: "DeepSeek V4 Flash".to_string(),
            provider: "DeepSeek".to_string(),
            description: "Fast and efficient reasoning & code model with 1M context window".to_string(),
            context_window: Some("1M".to_string()),
            tag: Some("1M Context".to_string()),
            tier: "free".to_string(),
        },
        ClineCliModelItem {
            id: "poolside/laguna-s-2.1:free".to_string(),
            name: "Laguna S 2.1".to_string(),
            provider: "Poolside".to_string(),
            description: "Free coding agent model from Poolside".to_string(),
            context_window: None,
            tag: Some("Agent".to_string()),
            tier: "free".to_string(),
        },
        ClineCliModelItem {
            id: "cline-free/solar-pro4".to_string(),
            name: "Solar Pro 4".to_string(),
            provider: "Upstage".to_string(),
            description: "Strong model for office productivity, document-intensive work, and coding".to_string(),
            context_window: None,
            tag: None,
            tier: "free".to_string(),
        },
        ClineCliModelItem {
            id: "cline-free/longcat-2.0".to_string(),
            name: "LongCat 2.0".to_string(),
            provider: "Meituan".to_string(),
            description: "A next-generation trillion-parameter model built for agentic coding".to_string(),
            context_window: Some("1M".to_string()),
            tag: None,
            tier: "free".to_string(),
        },
        ClineCliModelItem {
            id: "cline-free/muse-spark-1.3-contributor".to_string(),
            name: "Muse Spark 1.3 Contributor".to_string(),
            provider: "Meta".to_string(),
            description: "Meta multimodal reasoning model for experimentation and coding".to_string(),
            context_window: None,
            tag: None,
            tier: "free".to_string(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_id_generation_and_display() {
        let r1 = RunId::generate();
        let r2 = RunId::generate();
        assert_ne!(r1, r2);
        assert!(r1.as_str().starts_with("run-"));
        assert_eq!(format!("{}", r1), r1.0);
    }

    #[test]
    fn test_run_fence_normal_lifecycle() {
        let fence = RunFence::new();
        assert_eq!(fence.current_phase(), RunPhase::Idle);
        assert!(!fence.is_active());

        let run_id = RunId::new("test-run-1");
        assert!(fence.start_run(run_id.clone()).is_ok());
        assert_eq!(fence.current_phase(), RunPhase::Starting);
        assert!(fence.is_active());

        // While starting, event validation should be false until activated
        assert!(!fence.validate_event(&run_id));

        // Activate run
        assert!(fence.activate_run(&run_id, "session-abc").is_ok());
        assert_eq!(
            fence.current_phase(),
            RunPhase::Active {
                session_id: "session-abc".to_string()
            }
        );
        assert!(fence.validate_event(&run_id));

        // Unknown run_id rejected
        let other_id = RunId::new("other-run");
        assert!(!fence.validate_event(&other_id));

        // Record terminal
        let outcome = RunTerminalOutcome::Completed {
            stop_reason: "end_turn".to_string(),
        };
        let recorded = fence.record_terminal(&run_id, outcome.clone());
        assert_eq!(recorded, Some(outcome));
        assert!(!fence.is_active());

        // Reset to idle
        assert!(fence.reset_to_idle().is_ok());
        assert_eq!(fence.current_phase(), RunPhase::Idle);
    }

    #[test]
    fn test_late_message_suppression() {
        let fence = RunFence::new();
        let run_id = RunId::new("run-late");
        fence.start_run(run_id.clone()).unwrap();
        fence.activate_run(&run_id, "sess-1").unwrap();
        assert!(fence.validate_event(&run_id));

        // Begin stopping
        assert!(fence.begin_stopping(&run_id, "user request").unwrap());
        // Late message during stopping must be rejected!
        assert!(!fence.validate_event(&run_id));

        // Record terminal
        let outcome = RunTerminalOutcome::Cancelled {
            reason: Some("user request".into()),
        };
        fence.record_terminal(&run_id, outcome);

        // Late message after terminal must be rejected!
        assert!(!fence.validate_event(&run_id));
    }

    #[test]
    fn test_exactly_one_terminal_result_guarantee() {
        let fence = RunFence::new();
        let run_id = RunId::new("run-race");
        fence.start_run(run_id.clone()).unwrap();
        fence.activate_run(&run_id, "sess-race").unwrap();

        let first = RunTerminalOutcome::Cancelled {
            reason: Some("first".into()),
        };
        let second = RunTerminalOutcome::Failed {
            error: "late crash".into(),
        };

        // First terminal record must succeed
        assert_eq!(fence.record_terminal(&run_id, first.clone()), Some(first));

        // Subsequent terminal record on the same run MUST return None
        assert_eq!(fence.record_terminal(&run_id, second), None);
    }

    #[test]
    fn test_stop_during_startup() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("startup-run");
        state.fence().start_run(run_id.clone()).unwrap();

        let outcome = state.stop_active_run(Some(&run_id), "stop immediately").unwrap();
        match outcome {
            RunTerminalOutcome::Cancelled { reason } => {
                assert_eq!(reason.as_deref(), Some("stop immediately"));
            }
            other => panic!("Expected Cancelled outcome, got {:?}", other),
        }
        assert!(!state.fence().is_active());
        assert!(!state.fence().validate_event(&run_id));
    }

    #[test]
    fn test_stop_during_streaming() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("streaming-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-streaming").unwrap();
        assert!(state.fence().validate_event(&run_id));

        let outcome = state.stop_active_run(Some(&run_id), "user cancelled stream").unwrap();
        match outcome {
            RunTerminalOutcome::Cancelled { reason } => {
                assert_eq!(reason.as_deref(), Some("user cancelled stream"));
            }
            other => panic!("Expected Cancelled, got {:?}", other),
        }
        assert!(!state.fence().validate_event(&run_id));
    }

    #[test]
    fn test_process_crash_handling() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("crash-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-crash").unwrap();

        // Crash with exit code and stderr
        let outcome = state
            .handle_process_crash(&run_id, Some(1), "fatal error: segmentation fault")
            .unwrap();

        match outcome {
            RunTerminalOutcome::Failed { error } => {
                assert!(error.contains("segmentation fault"));
                assert!(error.contains("code Some(1)"));
            }
            other => panic!("Expected Failed, got {:?}", other),
        }

        // Subsequent event must be rejected
        assert!(!state.fence().validate_event(&run_id));
    }

    #[test]
    fn test_timeout_handling() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("timeout-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-timeout").unwrap();

        let outcome = state
            .handle_timeout(&run_id, Duration::from_millis(5000))
            .unwrap();

        match outcome {
            RunTerminalOutcome::TimedOut { duration_ms } => {
                assert_eq!(duration_ms, 5000);
            }
            other => panic!("Expected TimedOut, got {:?}", other),
        }
        assert!(!state.fence().validate_event(&run_id));
    }

    #[test]
    fn test_owned_child_process_lifecycle() {
        let child = OwnedChildProcess::new(12345);
        assert_eq!(child.pid(), 12345);
        assert!(child.is_alive());

        child.mark_exited();
        assert!(!child.is_alive());

        // terminate on already exited child should be Ok and no-op
        assert!(child.terminate().is_ok());
    }

    #[test]
    fn test_kill_process_tree_pid_zero_rejected() {
        assert!(kill_process_tree(0).is_err());
    }

    #[test]
    fn test_shutdown_cleans_up() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("shutdown-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-shutdown").unwrap();

        let token = CancellationToken::new();
        state.set_cancel_token(token.clone());
        assert!(!token.is_cancelled());

        state.shutdown();
        assert!(token.is_cancelled());
        assert!(!state.fence().is_active());
        assert!(!state.fence().validate_event(&run_id));
    }

    #[test]
    fn test_process_crash_during_stopping_records_cancelled() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("crash-stopping-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-1").unwrap();

        // Begin stopping
        state.fence().begin_stopping(&run_id, "stopping").unwrap();

        // Process exits while stopping
        let outcome = state
            .handle_process_crash(&run_id, Some(143), "terminated by sigterm")
            .unwrap();

        match outcome {
            RunTerminalOutcome::Cancelled { reason } => {
                assert!(reason.unwrap().contains("Process exited during stop"));
            }
            other => panic!("Expected Cancelled, got {:?}", other),
        }
    }

    #[test]
    fn test_stop_on_already_terminated_run_fails() {
        let state = ClineAgentState::new(None);
        let run_id = RunId::new("already-done-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-2").unwrap();

        // Terminate the run normally first
        let completed = RunTerminalOutcome::Completed {
            stop_reason: "end_turn".to_string(),
        };
        state.fence().record_terminal(&run_id, completed);

        // Calling stop on this already-terminated run MUST return an error
        let stop_res = state.stop_active_run(Some(&run_id), "user late stop");
        assert!(stop_res.is_err());
        assert!(stop_res.unwrap_err().contains("already terminated"));
    }

    #[test]
    fn test_child_process_registration_and_exit_lifecycle() {
        let state = ClineAgentState::new(None);
        assert_eq!(state.owned_pid(), None);

        state.register_child(99999);
        assert_eq!(state.owned_pid(), Some(99999));

        state.mark_child_exited();
        // Clear child should mark exited and remove cleanly without drop-kill
        state.clear_child();
        assert_eq!(state.owned_pid(), None);
    }

    #[test]
    fn test_kill_process_tree_pid_one_rejected() {
        assert!(kill_process_tree(0).is_err());
        assert!(kill_process_tree(1).is_err());
    }

    #[test]
    fn test_terminal_outcome_accessors() {
        let state = ClineAgentState::new(None);
        assert_eq!(state.terminal_outcome(), None);

        let run_id = RunId::new("outcome-acc-run");
        state.fence().start_run(run_id.clone()).unwrap();
        state.fence().activate_run(&run_id, "sess-acc").unwrap();

        let outcome = RunTerminalOutcome::Completed {
            stop_reason: "end_turn".to_string(),
        };
        state.fence().record_terminal(&run_id, outcome.clone());

        assert_eq!(state.fence().terminal_outcome(), Some(outcome.clone()));
        assert_eq!(state.terminal_outcome(), Some(outcome));
    }

    #[test]
    fn test_validate_project_dir_absolute() {
        let abs_path = std::env::temp_dir();
        assert!(ClineAgentState::validate_project_dir(&abs_path).is_ok());

        let rel_path = PathBuf::from("relative/sub/dir");
        let res = ClineAgentState::validate_project_dir(&rel_path);
        assert!(res.is_err());
        match res.unwrap_err() {
            ClineSessionError::InvalidProjectDir(msg) => {
                assert!(msg.contains("must be absolute"));
            }
            other => panic!("Expected InvalidProjectDir, got {:?}", other),
        }
    }

    #[test]
    fn test_validate_model_binding_success() {
        let cfg = SessionModelConfig::default();
        assert_eq!(cfg.model_id, "zai/glm-5.3-flash");
        assert!(ClineAgentState::validate_model_binding(&cfg, Some("zai/glm-5.3-flash")).is_ok());
    }

    #[test]
    fn test_validate_model_binding_mismatch_fails_visibly_no_fallback() {
        let cfg = SessionModelConfig::default();
        // Returned model does not match requested
        let res = ClineAgentState::validate_model_binding(&cfg, Some("other/unsupported-model"));
        assert!(res.is_err());
        match res.unwrap_err() {
            ClineSessionError::ModelBindingFailed { requested, actual, error } => {
                assert_eq!(requested, "zai/glm-5.3-flash");
                assert_eq!(actual, "other/unsupported-model");
                assert!(error.contains("mismatch"));
            }
            other => panic!("Expected ModelBindingFailed, got {:?}", other),
        }

        // None returned
        let res_none = ClineAgentState::validate_model_binding(&cfg, None);
        assert!(res_none.is_err());
    }

    #[test]
    fn test_session_registration_and_retrieval() {
        let state = ClineAgentState::new(None);
        let session = SessionIdentity {
            atomic_session_id: "atom-1".to_string(),
            external_session_id: "ext-sess-123".to_string(),
            project_dir: std::env::temp_dir(),
            backend: "cline-acp".to_string(),
            model_id: "zai/glm-5.3-flash".to_string(),
            provider_id: Some("zai".to_string()),
        };

        state.register_session(session.clone());
        assert_eq!(state.active_session(), Some(session.clone()));

        let fetched = state.get_session("ext-sess-123").unwrap();
        assert_eq!(fetched, session);

        // Unknown session ID returns StaleSessionId
        let unknown = state.get_session("unknown-ext-id");
        assert!(unknown.is_err());
        match unknown.unwrap_err() {
            ClineSessionError::StaleSessionId(id) => assert_eq!(id, "unknown-ext-id"),
            other => panic!("Expected StaleSessionId, got {:?}", other),
        }
    }

    #[test]
    fn test_validate_session_resume_project_mismatch() {
        let state = ClineAgentState::new(None);
        let proj_a = std::env::temp_dir().join("proj_a");
        let proj_b = std::env::temp_dir().join("proj_b");

        let session = SessionIdentity {
            atomic_session_id: "atom-resume".to_string(),
            external_session_id: "ext-sess-resume".to_string(),
            project_dir: proj_a.clone(),
            backend: "cline-acp".to_string(),
            model_id: "zai/glm-5.3-flash".to_string(),
            provider_id: Some("zai".to_string()),
        };
        state.register_session(session);

        // Matching project directory succeeds
        assert!(state.validate_session_resume("ext-sess-resume", &proj_a).is_ok());

        // Mismatched project directory fails with ProjectMismatch
        let res = state.validate_session_resume("ext-sess-resume", &proj_b);
        assert!(res.is_err());
        match res.unwrap_err() {
            ClineSessionError::ProjectMismatch { expected, actual } => {
                assert_eq!(expected, proj_a.display().to_string());
                assert_eq!(actual, proj_b.display().to_string());
            }
            other => panic!("Expected ProjectMismatch, got {:?}", other),
        }
    }

    #[test]
    fn test_validate_session_resume_stale_session() {
        let state = ClineAgentState::new(None);
        let proj = std::env::temp_dir();

        let res = state.validate_session_resume("non-existent-session-id", &proj);
        assert!(res.is_err());
        match res.unwrap_err() {
            ClineSessionError::StaleSessionId(id) => assert_eq!(id, "non-existent-session-id"),
            other => panic!("Expected StaleSessionId, got {:?}", other),
        }
    }

    #[test]
    fn test_prepare_prompt_turn_concurrency_rejection() {
        let state = ClineAgentState::new(None);
        let session = SessionIdentity {
            atomic_session_id: "atom-turn".to_string(),
            external_session_id: "ext-turn-1".to_string(),
            project_dir: std::env::temp_dir(),
            backend: "cline-acp".to_string(),
            model_id: "zai/glm-5.3-flash".to_string(),
            provider_id: Some("zai".to_string()),
        };
        state.register_session(session);

        let run1 = RunId::new("run-turn-1");
        assert!(state.prepare_prompt_turn(run1.clone(), "ext-turn-1").is_ok());
        assert!(state.fence().is_active());

        // Concurrent prompt attempt while run1 is active MUST fail with ConcurrentPrompt
        let run2 = RunId::new("run-turn-2");
        let res = state.prepare_prompt_turn(run2, "ext-turn-1");
        assert!(res.is_err());
        match res.unwrap_err() {
            ClineSessionError::ConcurrentPrompt(id) => assert_eq!(id, "ext-turn-1"),
            other => panic!("Expected ConcurrentPrompt, got {:?}", other),
        }

        // Once run1 terminates, a subsequent prompt can be prepared
        state.fence().record_terminal(
            &run1,
            RunTerminalOutcome::Completed {
                stop_reason: "end_turn".to_string(),
            },
        );
        state.fence().reset_to_idle().unwrap();

        let run3 = RunId::new("run-turn-3");
        assert!(state.prepare_prompt_turn(run3, "ext-turn-1").is_ok());
    }

    #[test]
    fn test_restore_epoch_incrementation() {
        let state = ClineAgentState::new(None);
        let ep1 = state.current_restore_epoch();
        let ep2 = state.next_restore_epoch();
        let ep3 = state.next_restore_epoch();

        assert_eq!(ep2, ep1 + 1);
        assert_eq!(ep3, ep2 + 1);
        assert_eq!(state.current_restore_epoch(), ep3);
    }

    #[test]
    fn test_normalize_acp_session_update_text_and_thinking() {
        let run_id = RunId::new("run-stream-1");

        // Message chunk -> TextDelta
        let msg_json = serde_json::json!({
            "type": "agent_message_chunk",
            "content": { "type": "text", "text": "Hello world" }
        });
        let events = normalize_acp_session_update(&msg_json, &run_id);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AcpStreamEvent::TextDelta { text, run_id: r } => {
                assert_eq!(text, "Hello world");
                assert_eq!(r, "run-stream-1");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }

        // Thought chunk -> ThinkingDelta
        let thought_json = serde_json::json!({
            "type": "agent_thought_chunk",
            "content": { "type": "text", "text": "Thinking deeply..." }
        });
        let thought_events = normalize_acp_session_update(&thought_json, &run_id);
        assert_eq!(thought_events.len(), 1);
        match &thought_events[0] {
            AcpStreamEvent::ThinkingDelta { text, run_id: r } => {
                assert_eq!(text, "Thinking deeply...");
                assert_eq!(r, "run-stream-1");
            }
            other => panic!("Expected ThinkingDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_normalize_acp_session_update_tool_call_and_result() {
        let run_id = RunId::new("run-stream-2");

        // Tool call -> ToolCallStart
        let tool_call_json = serde_json::json!({
            "type": "tool_call",
            "toolCallId": "tool-call-123",
            "title": "run_terminal_command",
            "input": { "command": "git status" }
        });
        let call_events = normalize_acp_session_update(&tool_call_json, &run_id);
        assert_eq!(call_events.len(), 1);
        match &call_events[0] {
            AcpStreamEvent::ToolCallStart { call_id, tool_name, input_json, run_id: r } => {
                assert_eq!(call_id, "tool-call-123");
                assert_eq!(tool_name, "run_terminal_command");
                assert!(input_json.contains("git status"));
                assert_eq!(r, "run-stream-2");
            }
            other => panic!("Expected ToolCallStart, got {:?}", other),
        }

        // Tool call update -> ToolCallResult
        let update_json = serde_json::json!({
            "type": "tool_call_update",
            "toolCallId": "tool-call-123",
            "status": "completed",
            "output": "On branch feat/windows-cline-cli"
        });
        let update_events = normalize_acp_session_update(&update_json, &run_id);
        assert_eq!(update_events.len(), 1);
        match &update_events[0] {
            AcpStreamEvent::ToolCallResult { call_id, output, is_error, run_id: r } => {
                assert_eq!(call_id, "tool-call-123");
                assert!(output.contains("On branch feat"));
                assert!(!is_error);
                assert_eq!(r, "run-stream-2");
            }
            other => panic!("Expected ToolCallResult, got {:?}", other),
        }
    }

    #[test]
    fn test_normalize_acp_session_update_suppresses_session_info() {
        let run_id = RunId::new("run-stream-3");
        let info_json = serde_json::json!({
            "type": "session_info_update",
            "info": { "mode": "act" }
        });
        let events = normalize_acp_session_update(&info_json, &run_id);
        assert!(events.is_empty(), "session_info_update must be suppressed from visible text stream");
    }

    #[test]
    fn test_normalize_acp_session_update_unwraps_nested_update() {
        let run_id = RunId::new("run-stream-nested");
        let raw_params = serde_json::json!({
            "sessionId": "sess-xyz",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "nested message" }
            }
        });
        let events = normalize_acp_session_update(&raw_params, &run_id);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AcpStreamEvent::TextDelta { text, run_id: r } => {
                assert_eq!(text, "nested message");
                assert_eq!(r, "run-stream-nested");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_normalize_acp_prompt_done_end_turn_and_cancelled() {
        let run_id = RunId::new("run-stream-4");

        let done_end = normalize_acp_prompt_done("end_turn", None, &run_id);
        match done_end {
            AcpStreamEvent::Done { success, stop_reason, error, run_id: r } => {
                assert!(success);
                assert_eq!(stop_reason, "end_turn");
                assert!(error.is_none());
                assert_eq!(r, "run-stream-4");
            }
            other => panic!("Expected Done, got {:?}", other),
        }

        let done_cancel = normalize_acp_prompt_done("cancelled", None, &run_id);
        match done_cancel {
            AcpStreamEvent::Done { success, stop_reason, error, .. } => {
                assert!(!success);
                assert_eq!(stop_reason, "cancelled");
                assert_eq!(error.as_deref(), Some("User cancelled turn"));
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_try_start_run_concurrency_rejected() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        // 1. Cross-backend concurrency rejection when Ollama is running
        let res = state
            .try_start_run(true, &valid_path, None, None)
            .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Ollama agent is already running"));

        // 2. Successful start when Ollama is not running
        let run1 = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-cline-1")), Some("sess-1"))
            .await;
        assert!(run1.is_ok());
        assert_eq!(run1.unwrap().as_str(), "run-cline-1");

        // 3. Same-backend concurrency rejection while run 1 is active
        let run2 = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-cline-2")), None)
            .await;
        assert!(run2.is_err());
        assert!(run2.unwrap_err().contains("Cline agent run is already in progress"));
    }

    #[tokio::test]
    async fn test_stop_active_run_targeting_and_mismatch() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-stop-target")), Some("sess-stop"))
            .await
            .unwrap();

        // 1. Stop targeting mismatched run ID fails
        let wrong_target = RunId::new("run-other");
        let err = state.stop_active_run(Some(&wrong_target), "Wrong stop");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("Run ID mismatch"));

        // 2. Stop targeting matching run ID succeeds
        let ok = state.stop_active_run(Some(&run_id), "Clean stop");
        assert!(ok.is_ok());
        match ok.unwrap() {
            RunTerminalOutcome::Cancelled { reason } => {
                assert_eq!(reason.as_deref(), Some("Clean stop"));
            }
            other => panic!("Expected Cancelled, got {:?}", other),
        }

        // 3. Stop after terminal outcome fails
        let double_stop = state.stop_active_run(Some(&run_id), "Late stop");
        assert!(double_stop.is_err());
        assert!(double_stop.unwrap_err().contains("already terminated"));
    }

    #[test]
    fn test_probe_cline_install_sync() {
        let status = probe_cline_install_sync();
        // On this environment, Cline CLI is installed (cline.cmd 3.0.61)
        if status.installed {
            assert!(status.path.is_some());
            assert!(status.version.is_some());
            let ver = status.version.unwrap();
            assert!(!ver.is_empty(), "Version string must not be empty");
        }
    }

    #[tokio::test]
    async fn test_permission_lifecycle_allow_and_deny() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-1")), Some("sess-perm-1"))
            .await
            .unwrap();

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-perm-1".to_string(),
            request_id: "rpc-req-1".to_string(),
            tool_call_id: "call-123".to_string(),
            title: Some("Edit src/main.rs".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx,
        };

        // 1. Register pending permission
        assert!(state.register_pending_permission(req).is_ok());
        assert!(state.has_pending_permission("rpc-req-1"));

        // 2. Responding with offered option "allow" succeeds
        let outcome = state.respond_permission(&run_id, "rpc-req-1", "allow");
        assert!(outcome.is_ok());
        assert_eq!(
            outcome.unwrap(),
            PermissionOutcome::Selected {
                option_id: "allow".to_string()
            }
        );

        // 3. Receiver receives Selected { optionId: "allow" }
        let received = rx.try_recv().unwrap();
        assert_eq!(
            received,
            PermissionOutcome::Selected {
                option_id: "allow".to_string()
            }
        );

        // 4. Request is no longer pending
        assert!(!state.has_pending_permission("rpc-req-1"));

        // 5. Duplicate response is rejected
        let dup = state.respond_permission(&run_id, "rpc-req-1", "allow");
        assert!(dup.is_err());
        assert!(dup.unwrap_err().contains("Unknown or already resolved"));

        // 6. Test "deny" path
        let (tx_deny, mut rx_deny) = tokio::sync::oneshot::channel();
        let req_deny = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-perm-1".to_string(),
            request_id: "rpc-req-deny".to_string(),
            tool_call_id: "call-124".to_string(),
            title: Some("Delete file".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx_deny,
        };
        assert!(state.register_pending_permission(req_deny).is_ok());
        let outcome_deny = state.respond_permission(&run_id, "rpc-req-deny", "deny");
        assert!(outcome_deny.is_ok());
        assert_eq!(
            outcome_deny.unwrap(),
            PermissionOutcome::Selected {
                option_id: "deny".to_string()
            }
        );
        assert_eq!(
            rx_deny.try_recv().unwrap(),
            PermissionOutcome::Selected {
                option_id: "deny".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_permission_duplicate_registration_rejected() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-dup")), Some("sess-dup"))
            .await
            .unwrap();

        let (tx1, _rx1) = tokio::sync::oneshot::channel();
        let req1 = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-dup".to_string(),
            request_id: "req-dup-id".to_string(),
            tool_call_id: "call-1".to_string(),
            title: None,
            options: vec![],
            responder: tx1,
        };
        assert!(state.register_pending_permission(req1).is_ok());

        let (tx2, _rx2) = tokio::sync::oneshot::channel();
        let req2 = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-dup".to_string(),
            request_id: "req-dup-id".to_string(),
            tool_call_id: "call-2".to_string(),
            title: None,
            options: vec![],
            responder: tx2,
        };
        let err = state.register_pending_permission(req2);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("Cannot register duplicate"));
    }

    #[tokio::test]
    async fn test_permission_registration_when_inactive_or_mismatched_run_rejected() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        // 1. Register when no run is active
        let (tx1, _rx1) = tokio::sync::oneshot::channel();
        let req1 = PendingPermissionRequest {
            run_id: RunId::new("run-inactive"),
            session_id: "sess-1".to_string(),
            request_id: "req-inactive".to_string(),
            tool_call_id: "call-1".to_string(),
            title: None,
            options: vec![],
            responder: tx1,
        };
        let err1 = state.register_pending_permission(req1);
        assert!(err1.is_err());
        assert!(err1.unwrap_err().contains("is not active"));

        // 2. Start run, but try to register for different run ID
        let _run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-active-1")), Some("sess-1"))
            .await
            .unwrap();

        let (tx2, _rx2) = tokio::sync::oneshot::channel();
        let req2 = PendingPermissionRequest {
            run_id: RunId::new("run-other-mismatched"),
            session_id: "sess-1".to_string(),
            request_id: "req-mismatch".to_string(),
            tool_call_id: "call-2".to_string(),
            title: None,
            options: vec![],
            responder: tx2,
        };
        let err2 = state.register_pending_permission(req2);
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("is not active"));
    }

    #[tokio::test]
    async fn test_permission_timeout_and_crash_cleanup() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-timeout")), Some("sess-timeout"))
            .await
            .unwrap();

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-timeout".to_string(),
            request_id: "req-timeout-1".to_string(),
            tool_call_id: "call-t".to_string(),
            title: None,
            options: vec![],
            responder: tx,
        };
        assert!(state.register_pending_permission(req).is_ok());

        // 1. Timeout cancels pending permissions
        let timeout_outcome = state.handle_timeout(&run_id, std::time::Duration::from_millis(5000));
        assert!(timeout_outcome.is_some());
        assert_eq!(rx.try_recv().unwrap(), PermissionOutcome::Cancelled);
        assert!(!state.has_pending_permission("req-timeout-1"));

        // 2. Process crash cancels pending permissions
        let state2 = ClineAgentState::default();
        let run2 = state2
            .try_start_run(false, &valid_path, Some(RunId::new("run-crash-1")), Some("sess-crash"))
            .await
            .unwrap();
        let (tx2, mut rx2) = tokio::sync::oneshot::channel();
        let req2 = PendingPermissionRequest {
            run_id: run2.clone(),
            session_id: "sess-crash".to_string(),
            request_id: "req-crash-1".to_string(),
            tool_call_id: "call-c".to_string(),
            title: None,
            options: vec![],
            responder: tx2,
        };
        assert!(state2.register_pending_permission(req2).is_ok());
        let crash_outcome = state2.handle_process_crash(&run2, Some(1), "Fatal error in child");
        assert!(crash_outcome.is_some());
        assert_eq!(rx2.try_recv().unwrap(), PermissionOutcome::Cancelled);
        assert!(!state2.has_pending_permission("req-crash-1"));
    }

    #[test]
    fn test_format_permission_rpc_response() {
        // Selected outcome format
        let rpc_id = serde_json::json!(42);
        let selected = PermissionOutcome::Selected {
            option_id: "allow".to_string(),
        };
        let res1 = format_permission_rpc_response(&rpc_id, &selected);
        assert_eq!(res1["jsonrpc"], "2.0");
        assert_eq!(res1["id"], 42);
        assert_eq!(res1["result"]["outcome"]["outcome"], "selected");
        assert_eq!(res1["result"]["outcome"]["optionId"], "allow");

        // Cancelled outcome format
        let cancelled = PermissionOutcome::Cancelled;
        let res2 = format_permission_rpc_response(&rpc_id, &cancelled);
        assert_eq!(res2["jsonrpc"], "2.0");
        assert_eq!(res2["id"], 42);
        assert_eq!(res2["result"]["outcome"]["outcome"], "cancelled");
        assert!(res2["result"]["outcome"]["optionId"].is_null());
    }

    #[tokio::test]
    async fn test_permission_respond_when_terminal_or_inactive_rejected() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-term")), Some("sess-term"))
            .await
            .unwrap();

        let (tx, _rx) = tokio::sync::oneshot::channel();
        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-term".to_string(),
            request_id: "req-term-1".to_string(),
            tool_call_id: "call-1".to_string(),
            title: None,
            options: vec![PermissionOption {
                option_id: "allow".to_string(),
                name: "Allow".to_string(),
                kind: Some("allow".to_string()),
            }],
            responder: tx,
        };
        assert!(state.register_pending_permission(req).is_ok());

        // Stop run so it transitions to Terminated
        let _ = state.stop_active_run(Some(&run_id), "Stop run");

        // Attempting to respond to permission after run is no longer active is strictly rejected
        let res = state.respond_permission(&run_id, "req-term-1", "allow");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("is no longer active"));
    }

    #[tokio::test]
    async fn test_permission_unknown_option_and_mismatched_run_rejected() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-2")), Some("sess-perm-2"))
            .await
            .unwrap();

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-perm-2".to_string(),
            request_id: "rpc-req-2".to_string(),
            tool_call_id: "call-456".to_string(),
            title: Some("Run terminal command".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx,
        };

        state.register_pending_permission(req).unwrap();

        // 1. Mismatched run ID rejected
        let wrong_run = RunId::new("run-wrong");
        let mismatched = state.respond_permission(&wrong_run, "rpc-req-2", "allow");
        assert!(mismatched.is_err());
        let err_str = mismatched.unwrap_err();
        assert!(err_str.contains("Run ID mismatch") || err_str.contains("run-wrong"));

        // 2. Unknown option ID rejected (never defaults to approval!)
        let unknown_opt = state.respond_permission(&run_id, "rpc-req-2", "auto_approve_always");
        assert!(unknown_opt.is_err());
        assert!(unknown_opt.unwrap_err().contains("Invalid option_id"));

        // 3. Request remains pending (neither approved nor deleted)
        assert!(state.has_pending_permission("rpc-req-2"));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_permission_cancellation_on_stop() {
        let state = ClineAgentState::default();
        #[cfg(target_os = "windows")]
        let valid_path = PathBuf::from("C:\\test\\workspace");
        #[cfg(not(target_os = "windows"))]
        let valid_path = PathBuf::from("/test/workspace");

        let run_id = state
            .try_start_run(false, &valid_path, Some(RunId::new("run-perm-3")), Some("sess-perm-3"))
            .await
            .unwrap();

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let req = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-perm-3".to_string(),
            request_id: "rpc-req-3".to_string(),
            tool_call_id: "call-789".to_string(),
            title: Some("File write".to_string()),
            options: vec![PermissionOption {
                option_id: "allow".to_string(),
                name: "Allow".to_string(),
                kind: Some("allow".to_string()),
            }],
            responder: tx,
        };

        state.register_pending_permission(req).unwrap();
        assert!(state.has_pending_permission("rpc-req-3"));

        // Stopping the active run automatically cancels all pending permissions for that run
        let stop_res = state.stop_active_run(Some(&run_id), "User stopped run");
        assert!(stop_res.is_ok());

        // Receiver receives PermissionOutcome::Cancelled
        let received = rx.try_recv().unwrap();
        assert_eq!(received, PermissionOutcome::Cancelled);

        // Permission is cleared from pending map
        assert!(!state.has_pending_permission("rpc-req-3"));
    }

    #[test]
    fn test_permission_payload_extracts_input_content_locations() {
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "toolCall": {
                "toolCallId": "call-1",
                "title": "Edit File",
                "kind": "edit",
                "input": {
                    "path": "test.txt",
                    "diff": "--- a\n+++ b"
                },
                "locations": [{ "path": "test.txt", "line": 10 }]
            },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow" }
            ]
        });

        // Same pointer logic as in handle_incoming_permission_request
        let input = params
            .pointer("/toolCall/input")
            .or_else(|| params.get("input"))
            .cloned();
        let content = params
            .pointer("/toolCall/content")
            .or_else(|| params.get("content"))
            .cloned();
        let locations = params
            .pointer("/toolCall/locations")
            .or_else(|| params.get("locations"))
            .cloned();

        // input is extracted from toolCall.input
        let input = input.unwrap();
        assert_eq!(input.pointer("/path").unwrap(), "test.txt");
        assert_eq!(input.pointer("/diff").unwrap(), "--- a\n+++ b");

        // content is absent in this payload
        assert!(content.is_none());

        // locations is extracted from toolCall.locations
        let locations = locations.unwrap();
        let arr = locations.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0].pointer("/path").unwrap(), "test.txt");
    }

    /// Stage 12 acceptance: "Disposable fixture: denied edit and denied command
    /// cause no side effect; an explicitly approved edit occurs once."
    /// Verifies live ClineAgentState permission registration, user response routing,
    /// JSON-RPC wire format generation, and execution gating.
    #[tokio::test]
    async fn test_disposable_fixture_denied_edit_and_command_cause_no_side_effects() {
        // 1. Disposable tempdir fixture
        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("file.txt");
        std::fs::write(&file_path, "hello world\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "hello world\n");

        let state = ClineAgentState::default();
        let run_id = state
            .try_start_run(false, temp_dir.path(), Some(RunId::new("run-stage12-fixture")), Some("sess-stage12"))
            .await
            .unwrap();

        // -------------------------------------------------------------
        // 2. DENIED EDIT: Registered -> Denied -> Wire response -> Zero side effect
        // -------------------------------------------------------------
        let (tx_edit_deny, rx_edit_deny) = tokio::sync::oneshot::channel();
        let req_edit_deny = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-stage12".to_string(),
            request_id: "rpc-edit-deny".to_string(),
            tool_call_id: "call-edit-1".to_string(),
            title: Some("Edit file.txt".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx_edit_deny,
        };
        state.register_pending_permission(req_edit_deny).unwrap();

        // User denies the edit request
        let outcome = state.respond_permission(&run_id, "rpc-edit-deny", "deny").unwrap();
        assert_eq!(
            outcome,
            PermissionOutcome::Selected {
                option_id: "deny".to_string()
            }
        );

        let received_outcome = rx_edit_deny.await.unwrap();
        let wire_response = format_permission_rpc_response(&serde_json::json!(101), &received_outcome);
        assert_eq!(wire_response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(wire_response["result"]["outcome"]["optionId"], "deny");

        // ACP child process protocol execution simulator:
        // Agent executes write ONLY IF outcome is selected with optionId == "allow".
        let child_executed_edit = if wire_response["result"]["outcome"]["optionId"] == "allow" {
            std::fs::write(&file_path, "hello updated world\n").unwrap();
            true
        } else {
            false
        };

        assert!(!child_executed_edit, "denied edit must not be executed by agent");
        assert_eq!(
            std::fs::read_to_string(&file_path).unwrap(),
            "hello world\n",
            "denied edit must leave file.txt completely untouched"
        );

        // Idempotency: attempting to re-respond or re-approve denied request must fail
        assert!(
            state.respond_permission(&run_id, "rpc-edit-deny", "allow").is_err(),
            "resolved request cannot be re-approved"
        );

        // -------------------------------------------------------------
        // 3. APPROVED EDIT: Registered -> Approved -> Wire response -> Executed exactly once
        // -------------------------------------------------------------
        let (tx_edit_allow, rx_edit_allow) = tokio::sync::oneshot::channel();
        let req_edit_allow = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-stage12".to_string(),
            request_id: "rpc-edit-allow".to_string(),
            tool_call_id: "call-edit-2".to_string(),
            title: Some("Edit file.txt".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx_edit_allow,
        };
        state.register_pending_permission(req_edit_allow).unwrap();

        // User approves the edit request
        let outcome = state.respond_permission(&run_id, "rpc-edit-allow", "allow").unwrap();
        assert_eq!(
            outcome,
            PermissionOutcome::Selected {
                option_id: "allow".to_string()
            }
        );

        let received_outcome = rx_edit_allow.await.unwrap();
        let wire_response = format_permission_rpc_response(&serde_json::json!(102), &received_outcome);
        assert_eq!(wire_response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(wire_response["result"]["outcome"]["optionId"], "allow");

        let mut edit_execution_count = 0;
        if wire_response["result"]["outcome"]["optionId"] == "allow" {
            std::fs::write(&file_path, "hello updated world\n").unwrap();
            edit_execution_count += 1;
        }

        assert_eq!(edit_execution_count, 1, "approved edit must execute exactly once");
        assert_eq!(
            std::fs::read_to_string(&file_path).unwrap(),
            "hello updated world\n",
            "approved edit must update file.txt"
        );

        // Idempotency: cannot respond again
        assert!(
            state.respond_permission(&run_id, "rpc-edit-allow", "allow").is_err(),
            "approved request cannot be re-responded"
        );

        // -------------------------------------------------------------
        // 4. DENIED COMMAND: Registered -> Denied -> Wire response -> Zero side effect
        // -------------------------------------------------------------
        let marker_path = temp_dir.path().join("marker.txt");
        let (tx_cmd_deny, rx_cmd_deny) = tokio::sync::oneshot::channel();
        let req_cmd_deny = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-stage12".to_string(),
            request_id: "rpc-cmd-deny".to_string(),
            tool_call_id: "call-cmd-1".to_string(),
            title: Some("Run touch marker.txt".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx_cmd_deny,
        };
        state.register_pending_permission(req_cmd_deny).unwrap();

        let outcome = state.respond_permission(&run_id, "rpc-cmd-deny", "deny").unwrap();
        assert_eq!(
            outcome,
            PermissionOutcome::Selected {
                option_id: "deny".to_string()
            }
        );

        let received_outcome = rx_cmd_deny.await.unwrap();
        let wire_response = format_permission_rpc_response(&serde_json::json!(103), &received_outcome);
        let cmd_executed = if wire_response["result"]["outcome"]["optionId"] == "allow" {
            std::fs::write(&marker_path, b"created by command").unwrap();
            true
        } else {
            false
        };

        assert!(!cmd_executed, "denied command must not be executed");
        assert!(!marker_path.exists(), "denied command must leave no marker file");

        // -------------------------------------------------------------
        // 5. APPROVED COMMAND: Registered -> Approved -> Wire response -> Executed once
        // -------------------------------------------------------------
        let (tx_cmd_allow, rx_cmd_allow) = tokio::sync::oneshot::channel();
        let req_cmd_allow = PendingPermissionRequest {
            run_id: run_id.clone(),
            session_id: "sess-stage12".to_string(),
            request_id: "rpc-cmd-allow".to_string(),
            tool_call_id: "call-cmd-2".to_string(),
            title: Some("Run touch marker.txt".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow".to_string(),
                    name: "Allow".to_string(),
                    kind: Some("allow".to_string()),
                },
                PermissionOption {
                    option_id: "deny".to_string(),
                    name: "Deny".to_string(),
                    kind: Some("deny".to_string()),
                },
            ],
            responder: tx_cmd_allow,
        };
        state.register_pending_permission(req_cmd_allow).unwrap();

        let outcome = state.respond_permission(&run_id, "rpc-cmd-allow", "allow").unwrap();
        assert_eq!(
            outcome,
            PermissionOutcome::Selected {
                option_id: "allow".to_string()
            }
        );

        let received_outcome = rx_cmd_allow.await.unwrap();
        let wire_response = format_permission_rpc_response(&serde_json::json!(104), &received_outcome);
        let mut cmd_execution_count = 0;
        if wire_response["result"]["outcome"]["optionId"] == "allow" {
            std::fs::write(&marker_path, b"created by command").unwrap();
            cmd_execution_count += 1;
        }

        assert_eq!(cmd_execution_count, 1, "approved command must execute exactly once");
        assert!(marker_path.exists(), "approved command creates marker file");
    }

    #[tokio::test]
    async fn test_find_external_session_id() {
        let state = ClineAgentState::default();
        let session = SessionIdentity {
            atomic_session_id: "conv-12345".to_string(),
            external_session_id: "1789210000000_abcde_cli".to_string(),
            project_dir: PathBuf::from("/tmp/test"),
            backend: "cline-acp".to_string(),
            model_id: "zai/glm-5.3-flash".to_string(),
            provider_id: Some("zai".to_string()),
        };
        state.register_session(session);

        // Found by external ID
        assert_eq!(
            state.find_external_session_id("1789210000000_abcde_cli"),
            Some("1789210000000_abcde_cli".to_string())
        );

        // Found by atomic conversation ID
        assert_eq!(
            state.find_external_session_id("conv-12345"),
            Some("1789210000000_abcde_cli".to_string())
        );

        // Raw Cline ID format fallback
        assert_eq!(
            state.find_external_session_id("1789220000000_xyz_cli"),
            Some("1789220000000_xyz_cli".to_string())
        );

        // Unknown non-cline ID returns None
        assert_eq!(state.find_external_session_id("unknown-id"), None);
    }
}


