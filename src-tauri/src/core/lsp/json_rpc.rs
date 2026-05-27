use crate::core::lsp::protocol::{
    DiagnosticStore, JsonRpcId, JsonRpcRequest, JsonRpcResponse, PublishDiagnosticsParams,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::HashMap, fmt, time::Duration};
use tokio::sync::oneshot;

const HEADER_SEPARATOR: &[u8] = b"\r\n\r\n";

#[derive(Debug)]
pub enum JsonRpcError {
    InvalidHeader(String),
    InvalidContentLength(String),
    InvalidJson(serde_json::Error),
    ResponseChannelClosed,
    ResponseError(String),
    Timeout,
    UnexpectedMessage,
}

impl fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHeader(header) => write!(f, "invalid LSP header: {header}"),
            Self::InvalidContentLength(value) => {
                write!(f, "invalid LSP Content-Length value: {value}")
            }
            Self::InvalidJson(error) => write!(f, "invalid JSON-RPC payload: {error}"),
            Self::ResponseChannelClosed => write!(f, "JSON-RPC response channel closed"),
            Self::ResponseError(message) => write!(f, "JSON-RPC response error: {message}"),
            Self::Timeout => write!(f, "JSON-RPC request timed out"),
            Self::UnexpectedMessage => write!(f, "unexpected JSON-RPC message"),
        }
    }
}

impl std::error::Error for JsonRpcError {}

impl From<serde_json::Error> for JsonRpcError {
    fn from(value: serde_json::Error) -> Self {
        Self::InvalidJson(value)
    }
}

pub fn encode_message<T: serde::Serialize>(message: &T) -> Result<Vec<u8>, JsonRpcError> {
    let payload = serde_json::to_vec(message)?;
    let mut framed = format!("Content-Length: {}\r\n\r\n", payload.len()).into_bytes();
    framed.extend_from_slice(&payload);
    Ok(framed)
}

pub fn next_message(buffer: &mut Vec<u8>) -> Result<Option<Value>, JsonRpcError> {
    let Some(header_end) = find_subsequence(buffer, HEADER_SEPARATOR) else {
        return Ok(None);
    };

    let header = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| JsonRpcError::InvalidHeader("<non-utf8>".to_string()))?;
    let content_length = parse_content_length(header)?;
    let body_start = header_end + HEADER_SEPARATOR.len();
    let body_end = body_start + content_length;

    if buffer.len() < body_end {
        return Ok(None);
    }

    let payload = buffer[body_start..body_end].to_vec();
    buffer.drain(..body_end);
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(Into::into)
}

fn parse_content_length(header: &str) -> Result<usize, JsonRpcError> {
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            return Err(JsonRpcError::InvalidHeader(line.to_string()));
        };

        if name.eq_ignore_ascii_case("Content-Length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|_| JsonRpcError::InvalidContentLength(value.trim().to_string()));
        }
    }

    Err(JsonRpcError::InvalidHeader(
        "missing Content-Length".to_string(),
    ))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, Default)]
pub struct RequestIdGenerator {
    next: i64,
}

impl RequestIdGenerator {
    pub fn next_id(&mut self) -> JsonRpcId {
        self.next += 1;
        JsonRpcId::Number(self.next)
    }
}

#[derive(Debug, Default)]
pub struct ResponseRouter {
    pending: HashMap<JsonRpcId, oneshot::Sender<JsonRpcResponse>>,
}

impl ResponseRouter {
    pub fn register(&mut self, id: JsonRpcId) -> oneshot::Receiver<JsonRpcResponse> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);
        rx
    }

    pub fn route(&mut self, response: JsonRpcResponse) -> bool {
        self.pending
            .remove(&response.id)
            .map(|tx| tx.send(response).is_ok())
            .unwrap_or(false)
    }

    pub fn cancel_all(&mut self) {
        self.pending.clear();
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

pub async fn wait_for_response<T: DeserializeOwned>(
    rx: oneshot::Receiver<JsonRpcResponse>,
    request_timeout: Duration,
) -> Result<T, JsonRpcError> {
    let response = tokio::time::timeout(request_timeout, rx)
        .await
        .map_err(|_| JsonRpcError::Timeout)?
        .map_err(|_| JsonRpcError::ResponseChannelClosed)?;

    if let Some(error) = response.error {
        return Err(JsonRpcError::ResponseError(error.message));
    }

    let result = response.result.ok_or(JsonRpcError::UnexpectedMessage)?;
    serde_json::from_value(result).map_err(Into::into)
}

pub fn request(id: JsonRpcId, method: impl Into<String>, params: Option<Value>) -> JsonRpcRequest {
    JsonRpcRequest::new(id, method, params)
}

pub fn handle_notification(
    method: &str,
    params: Option<Value>,
    diagnostics: &mut DiagnosticStore,
) -> Result<bool, JsonRpcError> {
    if method != "textDocument/publishDiagnostics" {
        return Ok(false);
    }

    let params = params.ok_or(JsonRpcError::UnexpectedMessage)?;
    let diagnostics_params: PublishDiagnosticsParams = serde_json::from_value(params)?;
    diagnostics.update(diagnostics_params);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::lsp::protocol::{
        Diagnostic, JsonRpcError as ProtocolJsonRpcError, Position, Range,
    };
    use serde_json::json;

    #[test]
    fn encodes_lsp_content_length_frame() {
        let message = request(
            JsonRpcId::Number(1),
            "initialize",
            Some(json!({ "rootUri": "file:///tmp/project" })),
        );

        let framed = encode_message(&message).unwrap();
        let framed_text = String::from_utf8(framed.clone()).unwrap();
        assert!(framed_text.starts_with("Content-Length: "));
        assert!(framed_text.contains("\r\n\r\n"));

        let (_, payload) = framed_text.split_once("\r\n\r\n").unwrap();
        assert_eq!(
            payload.len(),
            framed_text
                .lines()
                .next()
                .unwrap()
                .strip_prefix("Content-Length: ")
                .unwrap()
                .parse::<usize>()
                .unwrap()
        );
    }

    #[test]
    fn parses_complete_and_partial_messages() {
        let message = json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } });
        let frame = encode_message(&message).unwrap();
        let split_at = frame.len() - 3;
        let mut buffer = frame[..split_at].to_vec();

        assert!(next_message(&mut buffer).unwrap().is_none());

        buffer.extend_from_slice(&frame[split_at..]);
        let parsed = next_message(&mut buffer).unwrap().unwrap();
        assert_eq!(parsed, message);
        assert!(buffer.is_empty());
    }

    #[test]
    fn rejects_malformed_headers() {
        let mut buffer = b"Content-Length: nope\r\n\r\n{}".to_vec();
        let error = next_message(&mut buffer).unwrap_err();
        assert!(matches!(error, JsonRpcError::InvalidContentLength(_)));
    }

    #[tokio::test]
    async fn routes_response_by_request_id() {
        let mut router = ResponseRouter::default();
        let rx = router.register(JsonRpcId::Number(7));

        let routed = router.route(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: JsonRpcId::Number(7),
            result: Some(json!({ "answer": 42 })),
            error: None,
        });

        assert!(routed);
        assert_eq!(router.pending_len(), 0);

        let value: Value = wait_for_response(rx, Duration::from_secs(1)).await.unwrap();
        assert_eq!(value, json!({ "answer": 42 }));
    }

    #[tokio::test]
    async fn request_timeout_is_reported() {
        let mut router = ResponseRouter::default();
        let rx = router.register(JsonRpcId::Number(9));

        let error = wait_for_response::<Value>(rx, Duration::from_millis(1))
            .await
            .unwrap_err();

        assert!(matches!(error, JsonRpcError::Timeout));
    }

    #[test]
    fn handles_publish_diagnostics_notification() {
        let diagnostic = Diagnostic {
            range: Range {
                start: Position {
                    line: 1,
                    character: 2,
                },
                end: Position {
                    line: 1,
                    character: 8,
                },
            },
            severity: Some(1),
            code: None,
            source: Some("typescript".to_string()),
            message: "Example diagnostic".to_string(),
        };
        let mut store = DiagnosticStore::default();

        let handled = handle_notification(
            "textDocument/publishDiagnostics",
            Some(json!({
                "uri": "file:///tmp/project/src/main.ts",
                "diagnostics": [diagnostic],
                "version": 3
            })),
            &mut store,
        )
        .unwrap();

        assert!(handled);
        let diagnostics = store
            .get("file:///tmp/project/src/main.ts")
            .expect("diagnostics should be stored");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message, "Example diagnostic");
    }

    #[tokio::test]
    async fn response_errors_are_returned() {
        let mut router = ResponseRouter::default();
        let rx = router.register(JsonRpcId::String("abc".to_string()));

        assert!(router.route(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: JsonRpcId::String("abc".to_string()),
            result: None,
            error: Some(ProtocolJsonRpcError {
                code: -32601,
                message: "method not found".to_string(),
                data: None,
            }),
        }));

        let error = wait_for_response::<Value>(rx, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(matches!(error, JsonRpcError::ResponseError(_)));
    }
}
