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

/// Shared state managing the Cline ACP agent lifecycle, process ownership,
/// cancellation, event fencing, and explicit session/model binding.
#[derive(Debug)]
pub struct ClineAgentState {
    fence: Arc<RunFence>,
    child_process: Arc<std::sync::Mutex<Option<OwnedChildProcess>>>,
    timeouts: TimeoutConfig,
    cancel_token: Arc<std::sync::Mutex<Option<CancellationToken>>>,
    active_session: Arc<std::sync::Mutex<Option<SessionIdentity>>>,
    sessions_by_external_id: Arc<std::sync::Mutex<std::collections::HashMap<String, SessionIdentity>>>,
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

        let current_phase = self.fence.current_phase();
        match current_phase {
            RunPhase::Idle => return Err("No active run to stop".to_string()),
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
                        "Cline process exited unexpectedly with code {:?}. Stderr tail:\n{}",
                        exit_code, stderr_tail
                    )
                };
                RunTerminalOutcome::Failed { error: err_msg }
            }
        };

        // Clean up child process reference
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
            let _ = self.fence.record_terminal(
                &run_id,
                RunTerminalOutcome::Cancelled {
                    reason: Some("Application shutdown".to_string()),
                },
            );
        }
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
    _app: tauri::AppHandle<R>,
    state: tauri::State<'_, ClineAgentState>,
    ollama_state: tauri::State<'_, crate::core::ollama_agent::OllamaAgentState>,
    project_dir: String,
    prompt: String,
    model: Option<String>,
    run_id: Option<String>,
    session_id: Option<String>,
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

    let bound_model = model.unwrap_or_else(|| SessionModelConfig::default().model_id);
    log::info!(
        "[ClineAgent] Started run {} for project {} with model {} (session: {})",
        active_run_id,
        project_dir,
        bound_model,
        session_id.as_deref().unwrap_or("none")
    );

    Ok(active_run_id.to_string())
}

/// Stops an active Cline ACP agent run.
///
/// Targets the specified run_id or the currently active run.
#[tauri::command]
pub async fn stop_cline_agent(
    state: tauri::State<'_, ClineAgentState>,
    run_id: Option<String>,
) -> Result<(), String> {
    let target = run_id.map(RunId::new);
    state
        .stop_active_run(target.as_ref(), "User requested stop")
        .map(|_| ())
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
}


