//! # Cline ACP Transport
//!
//! Stage 05 ACP transport layer for Cline ACP v1 on Windows/desktop targets.
//!
//! This module owns the process-level transport between the host application and
//! the Cline agent over the Agent Client Protocol (ACP). It is responsible for
//! spawning/locating the Cline executable, framing and decoding JSON-RPC style
//! messages, guarding against oversized frames, and surfacing transport-level
//! failures (connection closed, protocol violations, I/O and serialization
//! errors) as a single typed error.

use agent_client_protocol::{AcpAgent, AcpAgentConfig};
use serde_json;
use std::io;
use thiserror::Error;

/// Typed error surface for the Cline ACP transport layer.
#[derive(Debug, Error)]
pub enum ClineTransportError {
    /// The configured Cline executable could not be located on the system.
    #[error("Cline executable not found: {0}")]
    ExecutableNotFound(String),

    /// The configured Cline executable path is invalid (not absolute, not a file, etc.).
    #[error("Invalid Cline executable path: {0}")]
    InvalidExecutablePath(String),

    /// Underlying I/O failure from the child process or socket/pipe layer.
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    /// JSON serialization/deserialization failure on the ACP wire format.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// An incoming frame exceeded the transport's size limit.
    #[error("Frame too large: {size} bytes (limit: {limit} bytes)")]
    FrameTooLarge {
        /// Actual size of the offending frame in bytes.
        size: usize,
        /// Maximum allowed frame size in bytes.
        limit: usize,
    },

    /// The connection to the Cline agent was closed (cleanly or unexpectedly).
    #[error("Connection closed: {0}")]
    ConnectionClosed(String),

    /// ACP protocol-level violation (malformed message, unexpected state, etc.).
    #[error("Protocol error: {0}")]
    Protocol(String),
}

/// Transport handle for the Stage 05 Cline ACP v1 integration.
///
/// Owns the immutable process/framing configuration plus the stateful
/// components used to drive the connection: request/response correlation,
/// incremental frame decoding, and the bounded stderr tail.
#[derive(Debug)]
pub struct ClineAcpTransport {
    config: ClineAcpTransportConfig,
    correlator: RequestCorrelator,
    framing: IncrementalMessageBuffer,
    stderr_tail: StderrTailBuffer,
}

impl ClineAcpTransport {
    /// Creates a transport from a configuration, propagating the configured
    /// frame and stderr-tail limits into the corresponding stateful buffers.
    pub fn new(config: ClineAcpTransportConfig) -> Self {
        let max_frame = config.max_frame_bytes;
        let max_stderr = config.max_stderr_tail_bytes;
        Self {
            correlator: RequestCorrelator::new(),
            framing: IncrementalMessageBuffer::new(max_frame),
            stderr_tail: StderrTailBuffer::new(max_stderr),
            config,
        }
    }

    /// The immutable transport configuration.
    pub fn config(&self) -> &ClineAcpTransportConfig {
        &self.config
    }

    /// The request/response correlator.
    pub fn correlator(&self) -> &RequestCorrelator {
        &self.correlator
    }

    /// The incremental frame decoder (mutable, for feeding byte chunks).
    pub fn framing_mut(&mut self) -> &mut IncrementalMessageBuffer {
        &mut self.framing
    }

    /// The bounded stderr tail buffer.
    pub fn stderr_tail(&self) -> &StderrTailBuffer {
        &self.stderr_tail
    }

    /// The bounded stderr tail buffer (mutable).
    pub fn stderr_tail_mut(&mut self) -> &mut StderrTailBuffer {
        &mut self.stderr_tail
    }
}
/// Configuration for the Cline ACP transport process and framing layer.
#[derive(Debug, Clone)]
pub struct ClineAcpTransportConfig {
    /// Path to the Cline executable used to spawn the agent process.
    pub executable_path: std::path::PathBuf,
    /// Optional working directory for the spawned agent process.
    pub working_dir: Option<std::path::PathBuf>,
    /// Additional environment variables for the spawned agent process.
    pub env: std::collections::BTreeMap<String, String>,
    /// Maximum allowed frame size in bytes (default 10 MiB).
    pub max_frame_bytes: usize,
    /// Maximum bytes of stderr tail retained for diagnostics (default 64 KiB).
    pub max_stderr_tail_bytes: usize,
}

impl ClineAcpTransportConfig {
    /// Creates a configuration with defaults: 10 MiB frame limit, 64 KiB
    /// stderr tail, no working directory, and an empty environment map.
    pub fn new(executable_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            executable_path: executable_path.into(),
            working_dir: None,
            env: std::collections::BTreeMap::new(),
            max_frame_bytes: 10 * 1024 * 1024,
            max_stderr_tail_bytes: 64 * 1024,
        }
    }

    /// Sets the working directory for the spawned agent process.
    pub fn working_dir(mut self, working_dir: impl Into<std::path::PathBuf>) -> Self {
        self.working_dir = Some(working_dir.into());
        self
    }

    /// Sets the environment variables for the spawned agent process.
    pub fn env(mut self, env: std::collections::BTreeMap<String, String>) -> Self {
        self.env = env;
        self
    }

    /// Sets the maximum allowed frame size in bytes.
    pub fn max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = max_frame_bytes;
        self
    }

    /// Sets the maximum bytes of stderr tail retained for diagnostics.
    pub fn max_stderr_tail_bytes(mut self, max_stderr_tail_bytes: usize) -> Self {
        self.max_stderr_tail_bytes = max_stderr_tail_bytes;
        self
    }

    /// Builds the official SDK `AcpAgentConfig` with fixed argument `--acp`.
    pub fn build_acp_agent_config(&self) -> AcpAgentConfig {
        let mut cfg = AcpAgentConfig::new(&self.executable_path).arg("--acp");
        for (k, v) in &self.env {
            cfg = cfg.env(k, v);
        }
        cfg
    }

    /// Creates an `AcpAgent` using the official SDK.
    pub fn build_acp_agent(&self) -> AcpAgent {
        AcpAgent::new(self.build_acp_agent_config())
    }
}

/// Bounded tail buffer that retains the most recent stderr bytes up to a limit.
#[derive(Debug, Clone)]
pub struct StderrTailBuffer {
    bytes: std::collections::VecDeque<u8>,
    limit: usize,
    truncated: bool,
}

impl StderrTailBuffer {
    /// Creates a tail buffer with the given byte limit.
    pub fn new(limit: usize) -> Self {
        Self {
            bytes: std::collections::VecDeque::new(),
            limit,
            truncated: false,
        }
    }

    /// Creates a tail buffer with the default 64 KiB limit.
    pub fn default_64k() -> Self {
        Self::new(64 * 1024)
    }

    /// Appends data, retaining only the last `limit` bytes.
    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.limit {
            self.truncated |= !self.bytes.is_empty() || data.len() > self.limit;
            self.bytes.clear();
            self.bytes.extend(data[data.len() - self.limit..].iter().copied());
            return;
        }
        self.bytes.extend(data.iter().copied());
        if self.bytes.len() > self.limit {
            let overflow = self.bytes.len() - self.limit;
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
    }

    /// Returns `true` if any bytes were dropped due to the limit.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// Number of retained bytes.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Returns `true` if no bytes are retained.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Renders the retained bytes as a lossy UTF-8 string, with a truncation
    /// notice prepended if any bytes were dropped.
    pub fn to_string_lossy(&self) -> String {
        let body = String::from_utf8_lossy(self.bytes.make_contiguous()).into_owned();
        if self.truncated {
            format!("[stderr truncated; showing last {} bytes]\n{}", self.limit, body)
        } else {
            body
        }
    }
/// Incremental newline-delimited JSON frame decoder.
///
/// Accepts arbitrary byte chunks (as delivered by an incremental reader) and
/// coalesces them until complete newline-delimited frames are available. Each
/// frame is trimmed of trailing `\r`/whitespace, size-checked, and parsed as a
/// `serde_json::Value`.
#[derive(Debug, Clone)]
pub struct IncrementalMessageBuffer {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl IncrementalMessageBuffer {
    /// Creates an incremental buffer with the given per-frame byte limit.
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
        }
    }

    /// Number of bytes currently coalesced awaiting a complete frame.
    pub fn buffer_len(&self) -> usize {
        self.buffer.len()
    }

    /// Returns `true` if no partial bytes are coalesced.
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Feeds a chunk of bytes into the buffer and returns every complete
    /// newline-delimited JSON frame that became available.
    pub fn feed(&mut self, data: &[u8]) -> Result<Vec<serde_json::Value>, ClineTransportError> {
        self.buffer.extend_from_slice(data);

        // Guard against runaway coalescing: if the pending bytes exceed the
        // frame limit with no newline anywhere in the first `max_frame_bytes`
        // bytes, the peer is producing unframeable output.
        if self.buffer.len() > self.max_frame_bytes
            && !self.buffer[..self.max_frame_bytes].contains(&b'\n')
        {
            return Err(ClineTransportError::FrameTooLarge {
                size: self.buffer.len(),
                limit: self.max_frame_bytes,
            });
        }

        let mut messages = Vec::new();
        let mut consumed = 0usize;

        for start in 0..self.buffer.len() {
            if self.buffer[start] != b'\n' {
                continue;
            }
            let line = &self.buffer[consumed..start];
            let line = trim_ascii(line);
            consumed = start + 1;

            if line.is_empty() {
                continue;
            }
            if line.len() > self.max_frame_bytes {
                return Err(ClineTransportError::FrameTooLarge {
                    size: line.len(),
                    limit: self.max_frame_bytes,
                });
            }
            let value = serde_json::from_slice(line)?;
            messages.push(value);
        }

        self.buffer.drain(..consumed);
        Ok(messages)
    }

    /// Finalizes decoding at EOF, accepting a single trailing frame that was
    /// not terminated by a newline.
    pub fn finish(&mut self) -> Result<Vec<serde_json::Value>, ClineTransportError> {
        let remaining = trim_ascii(&self.buffer);
        if remaining.is_empty() {
            self.buffer.clear();
            return Ok(vec![]);
        }
        if remaining.len() > self.max_frame_bytes {
            return Err(ClineTransportError::FrameTooLarge {
                size: remaining.len(),
                limit: self.max_frame_bytes,
            });
        }
        match serde_json::from_slice(remaining) {
            Ok(value) => {
                self.buffer.clear();
                Ok(vec![value])
            }
            Err(err) => Err(ClineTransportError::ConnectionClosed(format!(
                "Incomplete frame at EOF: {err}"
            ))),
        }
    }
}

/// Trims leading/trailing ASCII whitespace (including `\r`) from a byte slice.
fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let is_ws = |b: u8| b.is_ascii_whitespace();
    let start = bytes.iter().position(|b| !is_ws(b)).unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !is_ws(b))
        .map(|i| i + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

/// JSON-RPC style request identifier, which may be a number or a string.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RequestId {
    /// Numeric request id.
    Number(i64),
    /// String request id.
    String(String),
}

impl RequestId {
    /// Attempts to build a `RequestId` from a JSON value.
    ///
    /// Accepts JSON numbers (that fit in `i64`) and JSON strings; anything
    /// else (including `null`, booleans, arrays, and objects) yields `None`.
    pub fn from_value(v: &serde_json::Value) -> Option<Self> {
        match v {
            serde_json::Value::Number(n) => n.as_i64().map(RequestId::Number),
            serde_json::Value::String(s) => Some(RequestId::String(s.clone())),
            _ => None,
        }
    }

    /// Converts the id back into its JSON wire representation.
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            RequestId::Number(n) => serde_json::Value::Number((*n).into()),
            RequestId::String(s) => serde_json::Value::String(s.clone()),
        }
    }
}

/// An incoming, id-less message that carries a method (a notification).
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingNotification {
    /// Notification method name (e.g. `"session/update"`).
    pub method: String,
    /// Optional `params` payload carried by the notification.
    pub params: Option<serde_json::Value>,
}

/// Correlates outgoing requests with incoming responses and forwards id-less
/// notifications to the caller.
///
/// Each pending request owns a `oneshot` channel: `register` hands the receiver
/// to the caller, and `handle_incoming` resolves it when the matching response
/// (success or RPC error) arrives. `close_all` fails every pending request,
/// which is used when the connection drops.
#[derive(Debug)]
pub struct RequestCorrelator {
    pending: std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<
                RequestId,
                tokio::sync::oneshot::Sender<Result<serde_json::Value, ClineTransportError>>,
            >,
        >,
    >,
}

impl RequestCorrelator {
    /// Creates an empty correlator with no pending requests.
    pub fn new() -> Self {
        Self {
            pending: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
        }
    }

    /// Registers a pending request under `id` and returns the oneshot receiver
    /// that will resolve when the matching response, an RPC error, or a
    /// connection close arrives.
    pub async fn register(
        &self,
        id: RequestId,
    ) -> tokio::sync::oneshot::Receiver<Result<serde_json::Value, ClineTransportError>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        rx
    }

    /// Routes one incoming JSON message.
    ///
    /// Messages carrying a non-null `"id"` are treated as responses to pending
    /// requests and are resolved via their oneshot channel (returning `Ok(None)`).
    /// Messages without an id but with a `"method"` are surfaced as
    /// [`IncomingNotification`] values. Anything else is ignored.
    pub async fn handle_incoming(
        &self,
        value: serde_json::Value,
    ) -> Result<Option<IncomingNotification>, ClineTransportError> {
        let has_id = value.get("id").is_some() && !value["id"].is_null();
        let has_method = value.get("method").is_some();

        if has_id && !has_method {
            let id = RequestId::from_value(&value["id"]).ok_or_else(|| {
                ClineTransportError::Protocol("Invalid request id format".into())
            })?;

            let sender = self.pending.lock().await.remove(&id);
            match sender {
                Some(sender) => {
                    if value.get("error").is_some() && !value["error"].is_null() {
                        let _ = sender.send(Err(ClineTransportError::Protocol(format!(
                            "RPC error: {}",
                            value["error"]
                        ))));
                    } else {
                        let result_val = value
                            .get("result")
                            .cloned()
                            .unwrap_or_else(|| value.clone());
                        let _ = sender.send(Ok(result_val));
                    }
                    Ok(None)
                }
                None => Err(ClineTransportError::Protocol(format!(
                    "Unknown or stale request ID: {:?}",
                    id
                ))),
            }
        } else if let Some(method) = value.get("method") {
            Ok(Some(IncomingNotification {
                method: method.as_str().unwrap_or("").to_string(),
                params: value.get("params").cloned(),
            }))
        } else {
            Ok(None)
        }
    }

    /// Fails every pending request with [`ClineTransportError::ConnectionClosed`].
    ///
    /// Called when the transport reaches EOF or otherwise loses the agent so
    /// no caller is left blocked on a response that can never arrive.
    pub async fn close_all(&self, reason: &str) {
        let mut pending = self.pending.lock().await;
        for (_id, sender) in pending.drain() {
            let _ = sender.send(Err(ClineTransportError::ConnectionClosed(
                reason.to_string(),
            )));
        }
    }

    /// Number of requests currently awaiting a response.
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }
}


/// Characters that are dangerous when embedded in an executable path that may
/// end up in a shell command line or batch file interpretation.
const DANGEROUS_SHELL_CHARS: [char; 12] = [
    '&', '|', ';', '$', '`', '<', '>', '\n', '\r', '%', '^', '"',
];

/// Returns `true` if the string contains directory traversal (`..`) or dangerous shell metacharacters.
pub fn contains_dangerous_shell_chars(s: &str) -> bool {
    s.contains("..") || s.chars().any(|c| DANGEROUS_SHELL_CHARS.contains(&c))
}

/// Windows candidate file names for the Cline executable in PATH directories.
#[cfg(windows)]
const CLINE_PATH_FILENAMES: [&str; 3] = ["cline.cmd", "cline.exe", "cline.bat"];

/// Unix candidate file name for the Cline executable in PATH directories.
#[cfg(not(windows))]
const CLINE_PATH_FILENAMES: [&str; 1] = ["cline"];

/// Well-known directory candidates for the Cline executable (Windows).
#[cfg(windows)]
fn well_known_candidates() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(key) {
            out.push(
                std::path::PathBuf::from(base)
                    .join("npm")
                    .join("cline.cmd"),
            );
        }
    }
    if let Some(base) = std::env::var_os("ProgramFiles") {
        out.push(
            std::path::PathBuf::from(base)
                .join("nodejs")
                .join("cline.cmd"),
        );
    }
    out
}

/// Well-known candidates for the Cline executable (Unix).
#[cfg(not(windows))]
fn well_known_candidates() -> Vec<std::path::PathBuf> {
    vec![
        std::path::PathBuf::from("/usr/local/bin/cline"),
        std::path::PathBuf::from("/usr/bin/cline"),
    ]
}

/// Resolves the Cline CLI executable path securely.
///
/// If `configured_override` is provided, it is validated for dangerous shell
/// metacharacters, directory traversal, absolute path requirement, and existence,
/// then returned as-is. Otherwise, well-known installation locations and `PATH`
/// directories are searched for a suitable candidate.
pub fn resolve_cline_executable(
    configured_override: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, ClineTransportError> {
    if let Some(path) = configured_override {
        let as_str = path.to_string_lossy();
        if contains_dangerous_shell_chars(&as_str) || !path.is_absolute() {
            return Err(ClineTransportError::InvalidExecutablePath(
                as_str.into_owned(),
            ));
        }
        if !path.is_file() {
            return Err(ClineTransportError::ExecutableNotFound(
                as_str.into_owned(),
            ));
        }
        return Ok(path.to_path_buf());
    }

    // Well-known candidate locations first.
    for candidate in well_known_candidates() {
        if let Ok(resolved) = validate_discovered_candidate(&candidate) {
            return Ok(resolved);
        }
    }

    // Standard PATH lookup.
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for filename in CLINE_PATH_FILENAMES {
                let candidate = dir.join(filename);
                if let Ok(resolved) = validate_discovered_candidate(&candidate) {
                    return Ok(resolved);
                }
            }
        }
    }

    Err(ClineTransportError::ExecutableNotFound(
        "Cline executable not found in well-known locations or PATH".to_string(),
    ))
}

/// Validates a discovered candidate: must be an existing absolute file with no
/// dangerous shell metacharacters in its path.
fn validate_discovered_candidate(
    candidate: &std::path::Path,
) -> Result<std::path::PathBuf, ClineTransportError> {
    if !candidate.is_file() || !candidate.is_absolute() {
        return Err(ClineTransportError::ExecutableNotFound(
            candidate.to_string_lossy().into_owned(),
        ));
    }
    let as_str = candidate.to_string_lossy();
    if contains_dangerous_shell_chars(&as_str) {
        return Err(ClineTransportError::InvalidExecutablePath(
            as_str.into_owned(),
        ));
    }
    Ok(candidate.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_contains_dangerous_shell_chars() {
        assert!(!contains_dangerous_shell_chars("/usr/local/bin/cline"));
        assert!(!contains_dangerous_shell_chars("C:\\Program Files\\nodejs\\cline.cmd"));
        assert!(!contains_dangerous_shell_chars(""));
        assert!(contains_dangerous_shell_chars("cline;rm"));
        assert!(contains_dangerous_shell_chars("cline&whoami"));
        assert!(contains_dangerous_shell_chars("cline|cat"));
        assert!(contains_dangerous_shell_chars("$HOME/cline"));
        assert!(contains_dangerous_shell_chars("a`b"));
        assert!(contains_dangerous_shell_chars("a<b"));
        assert!(contains_dangerous_shell_chars("a>b"));
        assert!(contains_dangerous_shell_chars("a\nb"));
        assert!(contains_dangerous_shell_chars("a\rb"));
        assert!(contains_dangerous_shell_chars("a%b"));
        assert!(contains_dangerous_shell_chars("a^b"));
        assert!(contains_dangerous_shell_chars("a\"b"));
        assert!(contains_dangerous_shell_chars("../cline"));
        assert!(contains_dangerous_shell_chars("C:/path/../other"));
    }

    #[test]
    fn test_resolve_cline_executable_rejects_dangerous_chars() {
        for bad in [
            "bad;path",
            "bad&path",
            "bad|path",
            "$bad",
            "bad\npath",
            "bad%path",
            "bad^path",
            "bad\"path",
            "/bin/../etc/passwd",
        ] {
            let result = resolve_cline_executable(Some(std::path::Path::new(bad)));
            match result {
                Err(ClineTransportError::InvalidExecutablePath(_)) => {}
                other => panic!("expected InvalidExecutablePath for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_resolve_cline_executable_rejects_relative_path() {
        let result = resolve_cline_executable(Some(std::path::Path::new("relative/path/cline.cmd")));
        match result {
            Err(ClineTransportError::InvalidExecutablePath(_)) => {}
            other => panic!("expected InvalidExecutablePath for relative path, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_cline_executable_missing_path() {
        let missing = std::env::temp_dir().join("cline-definitely-not-here-12345");
        let result = resolve_cline_executable(Some(&missing));
        match result {
            Err(ClineTransportError::ExecutableNotFound(_)) => {}
            other => panic!("expected ExecutableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_cline_executable_valid_override() {
        let mut path = std::env::temp_dir();
        path.push("cline-acp-test-valid-override.txt");
        std::fs::write(&path, b"test").expect("failed to write temp file");
        let result = resolve_cline_executable(Some(&path));
        std::fs::remove_file(&path).ok();
        match result {
            Ok(resolved) => assert_eq!(resolved, path),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn test_stderr_tail_buffer_under_limit() {
        let mut buf = StderrTailBuffer::new(64);
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert!(!buf.is_truncated());

        buf.push(b"hello world");
        assert_eq!(buf.len(), 11);
        assert!(!buf.is_truncated());
        assert_eq!(buf.to_string_lossy(), "hello world");

        buf.push(b" tail");
        assert_eq!(buf.len(), 16);
        assert!(!buf.is_truncated());
        assert_eq!(buf.to_string_lossy(), "hello world tail");

        // Exactly at the limit is still not truncated.
        let mut exact = StderrTailBuffer::new(4);
        exact.push(b"abcd");
        assert_eq!(exact.len(), 4);
        assert!(!exact.is_truncated());
        assert_eq!(exact.to_string_lossy(), "abcd");
    }

    #[test]
    fn test_stderr_tail_buffer_overflow_truncation() {
        // Overflow via accumulation: older bytes are drained from the front.
        let mut buf = StderrTailBuffer::new(8);
        buf.push(b"0123456789");
        assert_eq!(buf.len(), 8);
        assert!(buf.is_truncated());
        assert_eq!(
            buf.to_string_lossy(),
            "[stderr truncated; showing last 8 bytes]\n23456789"
        );

        // Single push larger than the limit keeps only the last limit bytes.
        let mut big = StderrTailBuffer::new(4);
        big.push(b"abcdefgh");
        assert_eq!(big.len(), 4);
        assert!(big.is_truncated());
        assert_eq!(
            big.to_string_lossy(),
            "[stderr truncated; showing last 4 bytes]\nefgh"
        );

        // Truncation notice is prepended for lossy rendering.
        assert!(big.to_string_lossy().starts_with("[stderr truncated; showing last 4 bytes]\n"));

        // default_64k uses the 64 KiB limit.
        let default_buf = StderrTailBuffer::default_64k();
        assert_eq!(default_buf.len(), 0);
        assert_eq!(default_buf.to_string_lossy(), "");
    }

    #[test]
    fn test_stderr_tail_buffer_64k_boundary() {
        let mut buf = StderrTailBuffer::default_64k();
        let exact_chunk = vec![b'x'; 64 * 1024];
        buf.push(&exact_chunk);
        assert_eq!(buf.len(), 64 * 1024);
        assert!(!buf.is_truncated());
        assert!(!buf.to_string_lossy().starts_with("[stderr truncated"));

        // Pushing one more byte triggers truncation and keeps exactly 64 KiB
        buf.push(b"y");
        assert_eq!(buf.len(), 64 * 1024);
        assert!(buf.is_truncated());
        assert!(buf.to_string_lossy().starts_with("[stderr truncated; showing last 65536 bytes]\n"));
        assert!(buf.to_string_lossy().ends_with('y'));
    }

    #[test]
    fn test_transport_config_builder() {
        let config = ClineAcpTransportConfig::new("cline-acp");
        assert_eq!(config.executable_path, std::path::PathBuf::from("cline-acp"));
        assert!(config.working_dir.is_none());
        assert!(config.env.is_empty());
        assert_eq!(config.max_frame_bytes, 10 * 1024 * 1024);
        assert_eq!(config.max_stderr_tail_bytes, 64 * 1024);

        let mut env = std::collections::BTreeMap::new();
        env.insert("CLINE_ACP".to_string(), "1".to_string());
        let built = ClineAcpTransportConfig::new(std::path::PathBuf::from("C:/bin/cline"))
            .working_dir("C:/work")
            .env(env.clone())
            .max_frame_bytes(1024)
            .max_stderr_tail_bytes(128);

        assert_eq!(built.executable_path, std::path::PathBuf::from("C:/bin/cline"));
        assert_eq!(built.working_dir, Some(std::path::PathBuf::from("C:/work")));
        assert_eq!(built.env, env);
        assert_eq!(built.max_frame_bytes, 1024);
        assert_eq!(built.max_stderr_tail_bytes, 128);
    }

    #[test]
    fn test_incremental_buffer_single_message() {
        let mut buf = IncrementalMessageBuffer::new(1024);
        assert!(buf.is_empty());
        assert_eq!(buf.buffer_len(), 0);

        let messages = buf
            .feed(b"{\"jsonrpc\":\"2.0\",\"method\":\"test\"}\n")
            .expect("feed should succeed");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["jsonrpc"], "2.0");
        assert_eq!(messages[0]["method"], "test");
        assert!(buf.is_empty());
    }

    #[test]
    fn test_incremental_buffer_split_chunks() {
        let mut buf = IncrementalMessageBuffer::new(1024);

        let first = buf
            .feed(b"{\"jsonrpc\":\"2.0\",")
            .expect("feed chunk1 should succeed");
        assert!(first.is_empty());
        assert!(!buf.is_empty());

        let second = buf
            .feed(b"\"method\":\"split\"}\n")
            .expect("feed chunk2 should succeed");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["jsonrpc"], "2.0");
        assert_eq!(second[0]["method"], "split");
        assert!(buf.is_empty());
    }

    #[test]
    fn test_incremental_buffer_coalesced_messages() {
        let mut buf = IncrementalMessageBuffer::new(1024);

        let messages = buf
            .feed(b"{\"id\":1}\n{\"id\":2}\n{\"id\":3}\n")
            .expect("feed should succeed");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["id"], 1);
        assert_eq!(messages[1]["id"], 2);
        assert_eq!(messages[2]["id"], 3);
        assert!(buf.is_empty());
    }

    #[test]
    fn test_incremental_buffer_coalesced_with_partial() {
        let mut buf = IncrementalMessageBuffer::new(1024);

        let messages = buf
            .feed(b"{\"id\":1}\n{\"id\":")
            .expect("feed should succeed");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], 1);

        // Remainder stays coalesced in the buffer.
        assert_eq!(buf.buffer_len(), b"{\"id\":".len());
        assert!(!buf.is_empty());
    }

    #[test]
    fn test_incremental_buffer_oversized_frame() {
        let mut buf = IncrementalMessageBuffer::new(16);

        // Exceeds the limit with no newline anywhere.
        let result = buf.feed(b"0123456789abcdef0123456789abcdef");
        match result {
            Err(ClineTransportError::FrameTooLarge { size, limit }) => {
                assert!(size > 16);
                assert_eq!(limit, 16);
            }
            other => panic!("expected FrameTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn test_incremental_buffer_malformed_json() {
        let mut buf = IncrementalMessageBuffer::new(1024);

        let result = buf.feed(b"{invalid-json}\n");
        match result {
            Err(ClineTransportError::Json(_)) => {}
            other => panic!("expected Json error, got {other:?}"),
        }
    }

    #[test]
    fn test_incremental_buffer_eof_clean() {
        let mut buf = IncrementalMessageBuffer::new(1024);
        let messages = buf.finish().expect("finish on empty buffer should succeed");
        assert!(messages.is_empty());
    }

    #[test]
    fn test_incremental_buffer_eof_trailing_valid() {
        let mut buf = IncrementalMessageBuffer::new(1024);
        buf.feed(b"{\"id\":42}").expect("feed should succeed");
        let messages = buf.finish().expect("finish should succeed");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], 42);
        assert!(buf.is_empty());
    }

    #[test]
    fn test_incremental_buffer_eof_trailing_incomplete() {
        let mut buf = IncrementalMessageBuffer::new(1024);
        buf.feed(b"{\"id\":").expect("feed should succeed");
        match buf.finish() {
            Err(ClineTransportError::ConnectionClosed(msg)) => {
                assert!(msg.contains("Incomplete frame at EOF"));
            }
            other => panic!("expected ConnectionClosed, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // RequestCorrelator
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn test_correlator_in_order_response() {
        let correlator = RequestCorrelator::new();
        let rx = correlator.register(RequestId::Number(1)).await;
        assert_eq!(correlator.pending_count().await, 1);

        let handled = correlator
            .handle_incoming(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"ok": true}
            }))
            .await
            .expect("in-order response should be handled");
        assert!(handled.is_none());
        assert_eq!(correlator.pending_count().await, 0);

        let result = rx
            .await
            .expect("receiver should resolve")
            .expect("response should be Ok");
        assert_eq!(result["ok"], true);
    }

    #[tokio::test]
    async fn test_correlator_out_of_order_responses() {
        let correlator = RequestCorrelator::new();
        let rx1 = correlator.register(RequestId::Number(1)).await;
        let rx2 = correlator.register(RequestId::Number(2)).await;
        assert_eq!(correlator.pending_count().await, 2);

        // The response for request 2 arrives before the response for 1.
        let handled2 = correlator
            .handle_incoming(serde_json::json!({"id": 2, "result": "second"}))
            .await
            .expect("response for id 2 should be handled");
        assert!(handled2.is_none());
        assert_eq!(
            rx2.await.expect("rx2 should resolve").expect("result 2"),
            serde_json::json!("second")
        );
        assert_eq!(correlator.pending_count().await, 1);

        // Then the response for request 1 arrives.
        let handled1 = correlator
            .handle_incoming(serde_json::json!({"id": 1, "result": "first"}))
            .await
            .expect("response for id 1 should be handled");
        assert!(handled1.is_none());
        assert_eq!(
            rx1.await.expect("rx1 should resolve").expect("result 1"),
            serde_json::json!("first")
        );
        assert_eq!(correlator.pending_count().await, 0);
    }

    #[tokio::test]
    async fn test_correlator_error_response() {
        let correlator = RequestCorrelator::new();
        let rx = correlator
            .register(RequestId::String("abc".to_string()))
            .await;

        let handled = correlator
            .handle_incoming(serde_json::json!({
                "id": "abc",
                "error": {"code": -32601, "message": "method not found"}
            }))
            .await
            .expect("error response should be handled");
        assert!(handled.is_none());
        assert_eq!(correlator.pending_count().await, 0);

        match rx.await.expect("receiver should resolve") {
            Err(ClineTransportError::Protocol(msg)) => {
                assert!(msg.contains("RPC error"), "got: {msg}");
                assert!(msg.contains("method not found"), "got: {msg}");
            }
            other => panic!("expected Protocol RPC error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_correlator_notification_passthrough() {
        let correlator = RequestCorrelator::new();

        let handled = correlator
            .handle_incoming(serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"update": {"kind": "agent_message"}}
            }))
            .await
            .expect("notification should be handled");
        match handled {
            Some(IncomingNotification { method, params }) => {
                assert_eq!(method, "session/update");
                assert_eq!(params, Some(serde_json::json!({"update": {"kind": "agent_message"}})));
            }
            other => panic!("expected notification, got {other:?}"),
        }
        assert_eq!(correlator.pending_count().await, 0);

        // A notification without params still passes through with `None`.
        let no_params = correlator
            .handle_incoming(serde_json::json!({"method": "ping"}))
            .await
            .expect("paramless notification should be handled");
        assert_eq!(
            no_params,
            Some(IncomingNotification {
                method: "ping".to_string(),
                params: None,
            })
        );
    }

    #[tokio::test]
    async fn test_correlator_reverse_request_with_id_and_method() {
        let correlator = RequestCorrelator::new();

        // Agent-to-client request (e.g. session/request_permission) has both id and method
        let handled = correlator
            .handle_incoming(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 99,
                "method": "session/request_permission",
                "params": {"toolCallId": "call_1"}
            }))
            .await
            .expect("agent reverse request should pass through without stale ID error");

        match handled {
            Some(IncomingNotification { method, params }) => {
                assert_eq!(method, "session/request_permission");
                assert_eq!(params, Some(serde_json::json!({"toolCallId": "call_1"})));
            }
            other => panic!("expected reverse request to pass through, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_correlator_unknown_id() {
        let correlator = RequestCorrelator::new();

        // No pending registration for id 7 -> stale/unknown response error.
        let result = correlator
            .handle_incoming(serde_json::json!({"id": 7, "result": "late"}))
            .await;
        match result {
            Err(ClineTransportError::Protocol(msg)) => {
                assert!(msg.contains("Unknown or stale request ID"), "got: {msg}");
            }
            other => panic!("expected Protocol stale-id error, got {other:?}"),
        }

        // An id with an invalid wire format is rejected as well.
        let malformed = correlator
            .handle_incoming(serde_json::json!({"id": {"nested": true}, "result": "x"}))
            .await;
        match malformed {
            Err(ClineTransportError::Protocol(msg)) => {
                assert!(msg.contains("Invalid request id format"), "got: {msg}");
            }
            other => panic!("expected Protocol invalid-id error, got {other:?}"),
        }

        // A null id is treated as a non-response message, not a stale id.
        let null_id = correlator
            .handle_incoming(serde_json::json!({"id": null, "result": "x"}))
            .await
            .expect("null id message should be handled");
        assert!(null_id.is_none());
    }

    #[tokio::test]
    async fn test_correlator_eof_cancels_pending() {
        let correlator = RequestCorrelator::new();
        let rx1 = correlator.register(RequestId::Number(1)).await;
        let rx2 = correlator.register(RequestId::String("two".to_string())).await;
        assert_eq!(correlator.pending_count().await, 2);

        correlator
            .close_all("agent process exited unexpectedly")
            .await;
        assert_eq!(correlator.pending_count().await, 0);

        for (label, rx) in [("one", rx1), ("two", rx2)] {
            match rx.await.expect("receiver should resolve after close_all") {
                Err(ClineTransportError::ConnectionClosed(reason)) => {
                    assert_eq!(reason, "agent process exited unexpectedly");
                }
                other => panic!("expected ConnectionClosed for {label}, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_build_acp_agent_config() {
        let mut config = ClineAcpTransportConfig::new("cline.cmd");
        config.env.insert("CLINE_MODEL".to_string(), "zai/glm-5.3-flash".to_string());

        let acp_cfg = config.build_acp_agent_config();
        assert_eq!(acp_cfg.command(), std::path::Path::new("cline.cmd"));
        assert_eq!(acp_cfg.arguments(), &["--acp"]);
        assert_eq!(acp_cfg.environment().get("CLINE_MODEL").map(String::as_str), Some("zai/glm-5.3-flash"));
    }

    #[test]
    fn test_cline_acp_transport_init() {
        let config = ClineAcpTransportConfig::new("cline.cmd")
            .max_frame_bytes(2048)
            .max_stderr_tail_bytes(1024);
        let transport = ClineAcpTransport::new(config);

        assert_eq!(transport.config().executable_path, std::path::PathBuf::from("cline.cmd"));
        assert_eq!(transport.stderr_tail().len(), 0);
        assert!(!transport.stderr_tail().is_truncated());
    }
}
