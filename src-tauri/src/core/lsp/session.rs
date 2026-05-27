use crate::core::lsp::json_rpc::{
    encode_message, handle_notification, next_message, request as rpc_request, wait_for_response,
    RequestIdGenerator, ResponseRouter,
};
use crate::core::lsp::protocol::DiagnosticStore;
use crate::core::lsp::protocol::{
    Diagnostic, DocumentSymbol as ProtocolDocumentSymbol, Hover as ProtocolHover,
    HoverContents as ProtocolHoverContents, Location as ProtocolLocation, Range, SymbolInformation,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedDiagnostic {
    pub message: String,
    pub severity: Option<String>,
    pub range: NormalizedRange,
    pub code: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedRange {
    pub start_line: u32,
    pub start_character: Option<u32>,
    pub end_line: u32,
    pub end_character: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub range: NormalizedRange,
    pub selection_range: NormalizedRange,
    pub detail: Option<String>,
    pub container_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    File,
    Namespace,
    Class,
    Enum,
    Interface,
    Struct,
    TypeParameter,
    Method,
    Property,
    Field,
    Constructor,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Event,
    Function,
    Variable,
}

pub const MAX_SESSIONS: usize = 10;
pub const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
pub const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
pub const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct LspServerConfig {
    pub language_id: String,
    pub root_uri: String,
    pub root_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub initialization_options: Option<Value>,
}

impl LspServerConfig {
    pub fn document_selector(&self) -> Vec<String> {
        vec![self.language_id.clone()]
    }
}

#[derive(Debug)]
pub struct LspSession {
    pub config: LspServerConfig,
    pub child: AsyncMutex<Option<Child>>,
    pub stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    pub diagnostics: Arc<AsyncMutex<DiagnosticStore>>,
    pub open_documents: AsyncMutex<HashMap<String, i32>>,
    pub request_id_generator: AsyncMutex<RequestIdGenerator>,
    pub response_router: Arc<AsyncMutex<ResponseRouter>>,
}

impl LspSession {
    pub fn new(
        config: LspServerConfig,
        child: Option<Child>,
        stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
        diagnostics: Arc<AsyncMutex<DiagnosticStore>>,
        response_router: Arc<AsyncMutex<ResponseRouter>>,
    ) -> Self {
        Self {
            config,
            child: AsyncMutex::new(child),
            stdin_tx,
            diagnostics,
            open_documents: AsyncMutex::new(HashMap::new()),
            request_id_generator: AsyncMutex::new(RequestIdGenerator::default()),
            response_router,
        }
    }

    pub async fn send_notification(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        let req = crate::core::lsp::protocol::JsonRpcNotification::new(method, params);
        if let Some(tx) = &self.stdin_tx {
            let msg = encode_message(&req).map_err(|e| e.to_string())?;
            tx.send(msg).map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("No stdin_tx".to_string())
        }
    }

    pub async fn diagnostics(&self, uri: &str) -> Option<Vec<Diagnostic>> {
        self.diagnostics.lock().await.get(uri).map(|d| d.to_vec())
    }

    pub async fn update_diagnostics(&self, uri: String, diagnostics: Vec<Diagnostic>) {
        let params = crate::core::lsp::protocol::PublishDiagnosticsParams {
            uri,
            diagnostics,
            version: None,
        };
        self.diagnostics.lock().await.update(params);
    }

    pub async fn sync_document(&self, file_path: &Path) -> Option<String> {
        let uri = url::Url::from_file_path(file_path).ok()?.to_string();
        let text = tokio::fs::read_to_string(file_path).await.ok()?;

        let mut documents = self.open_documents.lock().await;
        let version = documents.entry(uri.clone()).or_insert(0);
        if *version == 0 {
            *version = 1;
            drop(documents);
            let params = json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": self.config.language_id,
                    "version": 1,
                    "text": text
                }
            });
            self.send_notification("textDocument/didOpen", Some(params))
                .await
                .ok()?;
        } else {
            *version += 1;
            let current_version = *version;
            drop(documents);
            let params = json!({
                "textDocument": {
                    "uri": uri,
                    "version": current_version
                },
                "contentChanges": [{ "text": text }]
            });
            self.send_notification("textDocument/didChange", Some(params))
                .await
                .ok()?;
        }

        Some(uri)
    }

    pub async fn diagnostics_for_file(&self, file_path: &Path) -> Vec<Diagnostic> {
        let Some(uri) = self.sync_document(file_path).await else {
            return Vec::new();
        };

        for _ in 0..10 {
            if let Some(diagnostics) = self.diagnostics(&uri).await {
                return diagnostics;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        self.diagnostics(&uri).await.unwrap_or_default()
    }

    pub async fn document_symbols(&self, file_path: &PathBuf) -> Option<Vec<NormalizedSymbol>> {
        let uri = self.sync_document(file_path).await?;
        let params = json!({
            "textDocument": { "uri": uri }
        });

        let response = self
            .send_request("textDocument/documentSymbol", Some(params))
            .await?;
        match response {
            Value::Array(items) => {
                if items
                    .first()
                    .is_some_and(|item| item.get("location").is_some())
                {
                    let symbols = items
                        .into_iter()
                        .filter_map(|item| serde_json::from_value::<SymbolInformation>(item).ok())
                        .map(symbol_information_to_normalized)
                        .take(200)
                        .collect();
                    Some(symbols)
                } else {
                    let mut symbols = Vec::new();
                    for item in items {
                        if let Ok(symbol) = serde_json::from_value::<ProtocolDocumentSymbol>(item) {
                            flatten_document_symbol(symbol, None, &mut symbols);
                            if symbols.len() >= 200 {
                                break;
                            }
                        }
                    }
                    symbols.truncate(200);
                    Some(symbols)
                }
            }
            _ => None,
        }
    }

    pub async fn definition(
        &self,
        file_path: &PathBuf,
        line: u32,
        character: u32,
    ) -> Option<Location> {
        let uri = self.sync_document(file_path).await?;
        let params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        });

        let response = self
            .send_request("textDocument/definition", Some(params))
            .await?;
        match response {
            Value::Array(locations) => locations
                .into_iter()
                .filter_map(|value| serde_json::from_value::<ProtocolLocation>(value).ok())
                .map(protocol_location_to_normalized)
                .next(),
            Value::Object(_) => serde_json::from_value::<ProtocolLocation>(response)
                .ok()
                .map(protocol_location_to_normalized),
            _ => None,
        }
    }

    pub async fn references(
        &self,
        file_path: &PathBuf,
        line: u32,
        character: u32,
        limit: usize,
    ) -> Option<Vec<Location>> {
        let uri = self.sync_document(file_path).await?;
        let params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": true }
        });

        let response = self
            .send_request("textDocument/references", Some(params))
            .await?;
        let Value::Array(locations) = response else {
            return None;
        };

        Some(
            locations
                .into_iter()
                .filter_map(|value| serde_json::from_value::<ProtocolLocation>(value).ok())
                .map(protocol_location_to_normalized)
                .take(limit)
                .collect(),
        )
    }

    pub async fn hover(&self, file_path: &PathBuf, line: u32, character: u32) -> Option<Hover> {
        let uri = self.sync_document(file_path).await?;
        let params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        });

        let response = self
            .send_request("textDocument/hover", Some(params))
            .await?;
        serde_json::from_value::<ProtocolHover>(response)
            .ok()
            .map(protocol_hover_to_normalized)
    }

    pub async fn send_request(&self, method: &str, params: Option<Value>) -> Option<Value> {
        let id = self.request_id_generator.lock().await.next_id();
        let rx = self.response_router.lock().await.register(id.clone());
        let req = rpc_request(id, method, params);

        if let Some(tx) = &self.stdin_tx {
            if let Ok(msg) = encode_message(&req) {
                if tx.send(msg).is_ok() {
                    return wait_for_response::<Value>(rx, std::time::Duration::from_secs(10))
                        .await
                        .ok();
                }
            }
        }
        None
    }

    pub async fn code_actions(
        &self,
        file_path: &Path,
        start_line: u32,
        start_character: u32,
        end_line: u32,
        end_character: u32,
    ) -> Option<Vec<CodeAction>> {
        let uri = self.sync_document(file_path).await?;

        let diagnostics = self
            .diagnostics
            .lock()
            .await
            .get(&uri)
            .unwrap_or(&[])
            .to_vec();
        let params: Value = json!({
            "textDocument": { "uri": uri },
            "range": {
                "start": { "line": start_line, "character": start_character },
                "end": { "line": end_line, "character": end_character }
            },
            "context": {
                "diagnostics": diagnostics
            }
        });

        self.send_request("textDocument/codeAction", Some(params))
            .await
            .map(|resp| {
                if let Value::Array(arr) = resp {
                    arr.into_iter()
                        .filter_map(|v| serde_json::from_value::<CodeAction>(v).ok())
                        .collect()
                } else {
                    Vec::new()
                }
            })
    }
}

fn normalize_range(range: Range) -> NormalizedRange {
    NormalizedRange {
        start_line: range.start.line,
        start_character: Some(range.start.character),
        end_line: range.end.line,
        end_character: Some(range.end.character),
    }
}

fn protocol_location_to_normalized(location: ProtocolLocation) -> Location {
    Location {
        uri: location.uri,
        range: normalize_range(location.range),
    }
}

fn symbol_kind_from_lsp(kind: u32) -> SymbolKind {
    match kind {
        1 => SymbolKind::File,
        2 => SymbolKind::Namespace,
        3 => SymbolKind::Namespace,
        4 => SymbolKind::Namespace,
        5 => SymbolKind::Class,
        6 => SymbolKind::Method,
        7 => SymbolKind::Property,
        8 => SymbolKind::Field,
        9 => SymbolKind::Constructor,
        10 => SymbolKind::Enum,
        11 => SymbolKind::Interface,
        12 => SymbolKind::Function,
        13 => SymbolKind::Variable,
        14 => SymbolKind::Constant,
        15 => SymbolKind::String,
        16 => SymbolKind::Number,
        17 => SymbolKind::Boolean,
        18 => SymbolKind::Array,
        19 => SymbolKind::Object,
        20 => SymbolKind::Key,
        21 => SymbolKind::Null,
        22 => SymbolKind::EnumMember,
        23 => SymbolKind::Struct,
        24 => SymbolKind::Event,
        25 => SymbolKind::Function,
        26 => SymbolKind::TypeParameter,
        _ => SymbolKind::Variable,
    }
}

fn flatten_document_symbol(
    symbol: ProtocolDocumentSymbol,
    container_name: Option<String>,
    output: &mut Vec<NormalizedSymbol>,
) {
    let name = symbol.name;
    let children = symbol.children;
    output.push(NormalizedSymbol {
        name: name.clone(),
        kind: symbol_kind_from_lsp(symbol.kind),
        range: normalize_range(symbol.range),
        selection_range: normalize_range(symbol.selection_range),
        detail: symbol.detail,
        container_name: container_name.clone(),
    });

    for child in children {
        flatten_document_symbol(child, Some(name.clone()), output);
        if output.len() >= 200 {
            break;
        }
    }
}

fn symbol_information_to_normalized(symbol: SymbolInformation) -> NormalizedSymbol {
    let range = normalize_range(symbol.location.range);
    NormalizedSymbol {
        name: symbol.name,
        kind: symbol_kind_from_lsp(symbol.kind),
        range: range.clone(),
        selection_range: range,
        detail: None,
        container_name: symbol.container_name,
    }
}

fn protocol_hover_to_normalized(hover: ProtocolHover) -> Hover {
    let value = match hover.contents {
        ProtocolHoverContents::Markup(value) => value,
        ProtocolHoverContents::MarkupLangAndContent { value, .. } => value,
    };

    Hover {
        contents: Some(HoverContents { value }),
    }
}

pub struct LspSessionManager {
    sessions: Arc<AsyncMutex<HashMap<String, Arc<LspSession>>>>,
    limits: Limits,
}

impl Clone for LspSessionManager {
    fn clone(&self) -> Self {
        Self {
            sessions: Arc::clone(&self.sessions),
            limits: self.limits.clone(),
        }
    }
}

impl Default for LspSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
            limits: LspSessionManager::limits(),
        }
    }
}

impl LspSessionManager {
    pub fn limits() -> Limits {
        Limits {
            max_sessions: MAX_SESSIONS,
            initialize_timeout: INITIALIZE_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            shutdown_timeout: SHUTDOWN_TIMEOUT,
        }
    }

    pub fn new(limits: Limits) -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
            limits,
        }
    }

    pub async fn get_or_start(&self, config: LspServerConfig) -> Option<Arc<LspSession>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&config.root_uri) {
            return Some(Arc::clone(session));
        }

        let mut child = Command::new(&config.command)
            .args(&config.args)
            .current_dir(&config.root_name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        let mut stdin = child.stdin.take()?;
        let mut stdout = child.stdout.take()?;

        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

        tokio::spawn(async move {
            while let Some(msg) = stdin_rx.recv().await {
                if stdin.write_all(&msg).await.is_err() {
                    break;
                }
            }
        });

        let diagnostics = Arc::new(AsyncMutex::new(DiagnosticStore::default()));
        let response_router = Arc::new(AsyncMutex::new(ResponseRouter::default()));

        let diag_clone = Arc::clone(&diagnostics);
        let router_clone = Arc::clone(&response_router);

        tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut read_buf = [0u8; 8192];
            loop {
                let n = match stdout.read(&mut read_buf).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                buffer.extend_from_slice(&read_buf[..n]);

                while let Ok(Some(value)) = next_message(&mut buffer) {
                    if let Ok(response) = serde_json::from_value::<
                        crate::core::lsp::protocol::JsonRpcResponse,
                    >(value.clone())
                    {
                        router_clone.lock().await.route(response);
                    } else if let Ok(notification) = serde_json::from_value::<
                        crate::core::lsp::protocol::JsonRpcNotification,
                    >(value.clone())
                    {
                        let mut diag = diag_clone.lock().await;
                        let _ = handle_notification(
                            &notification.method,
                            notification.params,
                            &mut diag,
                        );
                    }
                }
            }
        });

        let session = Arc::new(LspSession::new(
            config.clone(),
            Some(child),
            Some(stdin_tx),
            diagnostics,
            response_router,
        ));

        let init_params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": config.root_uri,
            "capabilities": {
                "textDocument": {
                    "codeAction": {
                        "dynamicRegistration": true
                    }
                }
            },
            "initializationOptions": config.initialization_options
        });

        let _ = session.send_request("initialize", Some(init_params)).await;
        let _ = session
            .send_notification("initialized", Some(serde_json::json!({})))
            .await;

        sessions.insert(config.root_uri.clone(), Arc::clone(&session));
        Some(session)
    }

    pub async fn shutdown_all(&self) {}

    pub fn max_sessions(&self) -> usize {
        self.limits.max_sessions
    }

    pub fn initialize_timeout(&self) -> std::time::Duration {
        self.limits.initialize_timeout
    }

    pub fn request_timeout(&self) -> std::time::Duration {
        self.limits.request_timeout
    }

    pub fn idle_timeout(&self) -> std::time::Duration {
        self.limits.idle_timeout
    }

    pub fn shutdown_timeout(&self) -> std::time::Duration {
        self.limits.shutdown_timeout
    }
}

#[derive(Clone)]
pub struct Limits {
    pub max_sessions: usize,
    pub initialize_timeout: std::time::Duration,
    pub request_timeout: std::time::Duration,
    pub idle_timeout: std::time::Duration,
    pub shutdown_timeout: std::time::Duration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSymbolResult {
    pub path: String,
    pub is_lsp: bool,
    pub symbols: Vec<NormalizedSymbol>,
    pub fallback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub uri: String,
    pub range: NormalizedRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverContents {
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hover {
    pub contents: Option<HoverContents>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeActionContext {
    #[serde(rename = "diagnostics")]
    pub diagnostics: Option<Vec<Diagnostic>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeActionParams {
    #[serde(rename = "textDocument")]
    pub text_document: Option<Value>,
    #[serde(rename = "range")]
    pub range: Option<Value>,
    #[serde(rename = "context")]
    pub context: Option<CodeActionContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeAction {
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "kind")]
    pub kind: Option<String>,
    #[serde(rename = "edit")]
    pub edit: Option<WorkspaceEdit>,
    #[serde(rename = "command")]
    pub command: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEdit {
    #[serde(rename = "changes")]
    pub changes: Option<HashMap<String, Vec<TextEdit>>>,
    #[serde(rename = "documentChanges")]
    pub document_changes: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextEdit {
    #[serde(rename = "range")]
    pub range: Range,
    #[serde(rename = "newText")]
    pub new_text: String,
}

#[derive(Debug)]
pub enum LspSessionError {
    Timeout,
    Transport(String),
    Parse(String),
}

impl std::fmt::Display for LspSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LspSessionError::Timeout => write!(f, "LSP request timeout"),
            LspSessionError::Transport(msg) => write!(f, "LSP transport error: {}", msg),
            LspSessionError::Parse(msg) => write!(f, "LSP parse error: {}", msg),
        }
    }
}

impl std::error::Error for LspSessionError {}
