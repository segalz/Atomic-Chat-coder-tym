//! LSP read-only tool commands exposed as Tauri invoke handlers.

use crate::core::lsp::diagnostics_pipeline::DiagnosticsPipeline;
use crate::core::lsp::server_config::resolve_lsp_root;
use crate::core::lsp::session::{
    CodeAction, DocumentSymbolResult, Limits, Location, LspServerConfig, LspSessionManager,
    NormalizedDiagnostic, NormalizedRange, IDLE_TIMEOUT, INITIALIZE_TIMEOUT, MAX_SESSIONS,
    REQUEST_TIMEOUT, SHUTDOWN_TIMEOUT,
};
use crate::core::lsp::tools_impl::{
    NormalizedCodeAction, NormalizedTextEdit, NormalizedWorkspaceEdit,
};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

/// Read-only LSP tools state
#[derive(Default)]
pub struct LspToolsState {
    pub manager: LspSessionManager,
    pub diagnostics_pipeline: std::sync::Arc<tokio::sync::Mutex<Option<DiagnosticsPipeline>>>,
    pub lsp_enabled: bool,
}

impl LspToolsState {
    pub fn new(lsp_enabled: bool) -> Self {
        Self {
            manager: LspSessionManager::new(LspSessionManager::limits()),
            diagnostics_pipeline: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            lsp_enabled,
        }
    }

    pub fn limits() -> Limits {
        Limits {
            max_sessions: MAX_SESSIONS,
            initialize_timeout: INITIALIZE_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            shutdown_timeout: SHUTDOWN_TIMEOUT,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LspConfig {
    pub lsp_enabled: bool,
    pub max_sessions: usize,
    pub initialize_timeout: usize,
    pub request_timeout: usize,
    pub idle_timeout: usize,
}

impl From<LspSessionManager> for LspConfig {
    fn from(manager: LspSessionManager) -> Self {
        Self {
            lsp_enabled: true,
            max_sessions: manager.max_sessions(),
            initialize_timeout: manager.initialize_timeout().as_secs() as usize,
            request_timeout: manager.request_timeout().as_secs() as usize,
            idle_timeout: manager.idle_timeout().as_secs() as usize,
        }
    }
}

pub fn file_to_uri(path: &PathBuf) -> String {
    url::Url::from_file_path(path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string().into())
}

#[tauri::command]
pub async fn get_lsp_config<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<LspConfig, String> {
    let config = LspConfig {
        lsp_enabled: std::env::var("LSP_ENABLED")
            .map_or(true, |e| e != "false" && e != "0" && e != "no"),
        max_sessions: 4,
        initialize_timeout: 10,
        request_timeout: 10,
        idle_timeout: 10 * 60,
    };
    Ok(config)
}

#[tauri::command]
pub async fn lsp_diagnostics<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: Option<String>,
) -> Result<Vec<NormalizedDiagnostic>, String> {
    if !state.lsp_enabled {
        return Ok(Vec::new());
    }

    let target_path = match file_path {
        Some(p) => {
            let path = PathBuf::from(p);
            if path.is_absolute() {
                path
            } else {
                PathBuf::from(&project_dir).join(path)
            }
        }
        None => return Ok(Vec::new()),
    };

    let resolution = match resolve_lsp_root(&project_dir, &target_path) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] diagnostics unavailable: degraded mode");
        return Ok(Vec::new());
    }

    let config = LspServerConfig {
        language_id: resolution.language_id.clone(),
        root_uri: resolution.root_uri.clone(),
        root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
        command: resolution.server_command().to_string(),
        args: resolution.server_args(&resolution.root_dir),
        initialization_options: Some(serde_json::json!({
            "trace.server": "verbose",
            "trace.client": "verbose",
        })),
    };

    let session = state.manager.get_or_start(config).await;

    let session = if let Some(s) = session {
        s
    } else {
        return Ok(Vec::new());
    };

    let diagnostics = session.diagnostics_for_file(&target_path).await;

    let normalized_diagnostics: Vec<NormalizedDiagnostic> = diagnostics
        .into_iter()
        .map(|d| {
            let range = NormalizedRange {
                start_line: d.range.start.line,
                start_character: Some(d.range.start.character),
                end_line: d.range.end.line,
                end_character: Some(d.range.end.character),
            };
            NormalizedDiagnostic {
                message: d.message,
                severity: d.severity.map(|s| s.to_string()),
                range,
                code: d.code.map(|c| c.to_string()),
                source: d.source,
            }
        })
        .collect();

    Ok(normalized_diagnostics)
}

#[tauri::command]
pub async fn lsp_document_symbols<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: String,
) -> Result<DocumentSymbolResult, String> {
    if !state.lsp_enabled {
        return Ok(DocumentSymbolResult {
            is_lsp: false,
            path: file_path,
            symbols: vec![],
            fallback: String::new(),
        });
    }

    let file_path = absolute_file_path(&project_dir, PathBuf::from(file_path));

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[LSP] root resolution failed: {}", e);
            return Ok(DocumentSymbolResult {
                is_lsp: false,
                path: file_path.to_string_lossy().to_string(),
                symbols: vec![],
                fallback: String::new(),
            });
        }
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] symbols unavailable: degraded mode");
        return Ok(DocumentSymbolResult {
            is_lsp: false,
            path: file_path.to_string_lossy().to_string(),
            symbols: vec![],
            fallback: String::new(),
        });
    }

    let Some(session) = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await
    else {
        return Ok(DocumentSymbolResult {
            is_lsp: false,
            path: file_path.to_string_lossy().to_string(),
            symbols: vec![],
            fallback: String::new(),
        });
    };

    let symbols = session
        .document_symbols(&file_path)
        .await
        .unwrap_or_default();

    Ok(DocumentSymbolResult {
        is_lsp: true,
        path: file_path.to_string_lossy().to_string(),
        symbols: symbols,
        fallback: String::new(),
    })
}

#[tauri::command]
pub async fn lsp_definitions<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: String,
    line: u32,
    character: u32,
) -> Result<Option<Location>, String> {
    if !state.lsp_enabled {
        return Ok(None);
    }

    let file_path = absolute_file_path(&project_dir, PathBuf::from(file_path));

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[LSP] root resolution failed: {}", e);
            return Ok(None);
        }
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] definition unavailable: degraded mode");
        return Ok(None);
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = if let Some(s) = session {
        s
    } else {
        return Ok(None);
    };

    let location = session.definition(&file_path, line, character).await;

    Ok(location)
}

#[tauri::command]
pub async fn lsp_references<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: String,
    line: u32,
    character: u32,
) -> Result<Option<Vec<Location>>, String> {
    if !state.lsp_enabled {
        return Ok(None);
    }

    let file_path = absolute_file_path(&project_dir, PathBuf::from(file_path));

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[LSP] root resolution failed: {}", e);
            return Ok(None);
        }
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] references unavailable: degraded mode");
        return Ok(None);
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = if let Some(s) = session {
        s
    } else {
        return Ok(None);
    };

    let references = session.references(&file_path, line, character, 100).await;

    if let Some(refs) = references {
        let limited = refs.iter().take(100).cloned().collect();
        return Ok(Some(limited));
    }
    Ok(None)
}

#[tauri::command]
pub async fn lsp_hover<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: String,
    line: u32,
    character: u32,
) -> Result<Option<String>, String> {
    if !state.lsp_enabled {
        return Ok(None);
    }

    let file_path = absolute_file_path(&project_dir, PathBuf::from(file_path));

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[LSP] root resolution failed: {}", e);
            return Ok(None);
        }
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] hover unavailable: degraded mode");
        return Ok(None);
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = if let Some(s) = session {
        s
    } else {
        return Ok(None);
    };

    let hover = session.hover(&file_path, line, character).await;

    let result = hover.and_then(|h| h.contents);

    Ok(result.map(|c| c.value))
}

pub async fn lsp_diagnostics_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: Option<PathBuf>,
) -> Result<Vec<NormalizedDiagnostic>, String> {
    if !state.lsp_enabled {
        return Ok(Vec::new());
    }

    let target_path = if let Some(p) = file_path {
        p
    } else {
        return Ok(Vec::new());
    };

    let resolution = match resolve_lsp_root(&project_dir, &target_path) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] diagnostics unavailable: degraded mode");
        return Ok(Vec::new());
    }

    let config = LspServerConfig {
        language_id: resolution.language_id.clone(),
        root_uri: resolution.root_uri.clone(),
        root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
        command: resolution.server_command().to_string(),
        args: resolution.server_args(&resolution.root_dir),
        initialization_options: Some(serde_json::json!({
            "trace.server": "verbose",
            "trace.client": "verbose",
        })),
    };

    let session = state.manager.get_or_start(config).await;

    let session = if let Some(s) = session {
        s
    } else {
        return Ok(Vec::new());
    };

    let diagnostics = session.diagnostics_for_file(&target_path).await;

    let normalized_diagnostics: Vec<NormalizedDiagnostic> = diagnostics
        .into_iter()
        .map(|d| {
            let range = NormalizedRange {
                start_line: d.range.start.line,
                start_character: Some(d.range.start.character),
                end_line: d.range.end.line,
                end_character: Some(d.range.end.character),
            };
            NormalizedDiagnostic {
                message: d.message,
                severity: d.severity.map(|s| s.to_string()),
                range,
                code: d.code.map(|c| c.to_string()),
                source: d.source,
            }
        })
        .collect();

    Ok(normalized_diagnostics)
}

pub async fn lsp_definitions_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: PathBuf,
    line: u32,
    character: u32,
) -> Option<Location> {
    if !state.lsp_enabled {
        return None;
    }

    let file_path = absolute_file_path(&project_dir, file_path);

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(_) => return None,
    };

    if resolution.is_degraded() {
        return None;
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = session?;
    session.definition(&file_path, line, character).await
}

pub async fn lsp_references_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: PathBuf,
    line: u32,
    character: u32,
) -> Option<Vec<Location>> {
    if !state.lsp_enabled {
        return None;
    }

    let file_path = absolute_file_path(&project_dir, file_path);

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(_) => return None,
    };

    if resolution.is_degraded() {
        return None;
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = session?;
    let references = session.references(&file_path, line, character, 100).await?;
    let limited = references.iter().take(100).cloned().collect();
    Some(limited)
}

pub async fn lsp_hover_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: PathBuf,
    line: u32,
    character: u32,
) -> Option<String> {
    if !state.lsp_enabled {
        return None;
    }

    let file_path = absolute_file_path(&project_dir, file_path);

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(_) => return None,
    };

    if resolution.is_degraded() {
        return None;
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = session?;
    let hover = session.hover(&file_path, line, character).await?;
    hover.contents.map(|c| c.value)
}

pub async fn lsp_document_symbols_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: PathBuf,
) -> Option<DocumentSymbolResult> {
    if !state.lsp_enabled {
        return None;
    }

    let file_path = absolute_file_path(&project_dir, file_path);

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(_) => return None,
    };

    if resolution.is_degraded() {
        return None;
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = session?;
    let symbols = session
        .document_symbols(&file_path)
        .await
        .unwrap_or_default();

    Some(DocumentSymbolResult {
        is_lsp: true,
        path: file_path.to_string_lossy().to_string(),
        symbols: symbols,
        fallback: String::new(),
    })
}

#[tauri::command]
pub async fn start_diagnostics_pipeline<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LspToolsState>,
) -> Result<(), String> {
    let mut pipeline_opt = state.diagnostics_pipeline.lock().await;
    if pipeline_opt.is_some() {
        return Ok(());
    }

    let mut pipeline = DiagnosticsPipeline::new(state.manager.clone());
    pipeline.start(app).await.map_err(|e| e.to_string())?;

    *pipeline_opt = Some(pipeline);

    Ok(())
}

#[tauri::command]
pub async fn add_workspace_to_diagnostics_pipeline<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    workspace_path: String,
) -> Result<(), String> {
    let mut pipeline_opt = state.diagnostics_pipeline.lock().await;
    let pipeline = pipeline_opt
        .as_mut()
        .ok_or("Diagnostics pipeline not started")?;

    let path = PathBuf::from(workspace_path);
    pipeline
        .add_workspace_root(path)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn lsp_code_actions<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, LspToolsState>,
    project_dir: String,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
) -> Result<Option<Vec<NormalizedCodeAction>>, String> {
    if !state.lsp_enabled {
        return Ok(None);
    }

    let file_path = absolute_file_path(&project_dir, PathBuf::from(file_path));

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[LSP] root resolution failed: {}", e);
            return Ok(None);
        }
    };

    if resolution.is_degraded() {
        log::warn!("[LSP] code_actions unavailable: degraded mode");
        return Ok(None);
    }

    let Some(session) = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await
    else {
        return Ok(None);
    };

    let code_actions = session
        .code_actions(
            &file_path,
            start_line,
            start_character,
            end_line,
            end_character,
        )
        .await
        .map(|actions| actions.into_iter().map(code_action_to_normalized).collect());

    Ok(code_actions)
}

pub async fn lsp_code_actions_internal(
    state: &LspToolsState,
    project_dir: String,
    file_path: PathBuf,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
) -> Option<Vec<NormalizedCodeAction>> {
    if !state.lsp_enabled {
        return None;
    }

    let file_path = absolute_file_path(&project_dir, file_path);

    let resolution = match resolve_lsp_root(&project_dir, &file_path) {
        Ok(r) => r,
        Err(_) => return None,
    };

    if resolution.is_degraded() {
        return None;
    }

    let session = state
        .manager
        .get_or_start(LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
            })),
        })
        .await;

    let session = session?;
    session
        .code_actions(
            &file_path,
            start_line,
            start_character,
            end_line,
            end_character,
        )
        .await
        .map(|actions| actions.into_iter().map(code_action_to_normalized).collect())
}

fn uri_to_path(uri: &str) -> String {
    url::Url::parse(uri)
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| uri.strip_prefix("file://").unwrap_or(uri).to_string())
}

fn absolute_file_path(project_dir: &str, file_path: PathBuf) -> PathBuf {
    if file_path.is_absolute() {
        file_path
    } else {
        PathBuf::from(project_dir).join(file_path)
    }
}

fn code_action_to_normalized(code_action: CodeAction) -> NormalizedCodeAction {
    let edit = code_action.edit.map(|workspace_edit| {
        let mut all_changes = Vec::new();

        if let Some(changes_map) = workspace_edit.changes {
            for (uri, edits) in changes_map {
                let file_path = uri_to_path(&uri);
                for edit in edits {
                    all_changes.push(NormalizedTextEdit {
                        file_path: file_path.clone(),
                        range: NormalizedRange {
                            start_line: edit.range.start.line,
                            start_character: Some(edit.range.start.character),
                            end_line: edit.range.end.line,
                            end_character: Some(edit.range.end.character),
                        },
                        new_text: edit.new_text,
                    });
                }
            }
        }

        if let Some(Value::Array(doc_changes)) = workspace_edit.document_changes {
            for doc_change in doc_changes {
                if let Some(text_document) = doc_change.get("textDocument") {
                    if let Some(uri) = text_document.get("uri").and_then(|u| u.as_str()) {
                        let file_path = uri_to_path(uri);
                        if let Some(Value::Array(edits)) = doc_change.get("edits") {
                            for edit_val in edits {
                                if let Ok(edit) = serde_json::from_value::<
                                    crate::core::lsp::session::TextEdit,
                                >(edit_val.clone())
                                {
                                    all_changes.push(NormalizedTextEdit {
                                        file_path: file_path.clone(),
                                        range: NormalizedRange {
                                            start_line: edit.range.start.line,
                                            start_character: Some(edit.range.start.character),
                                            end_line: edit.range.end.line,
                                            end_character: Some(edit.range.end.character),
                                        },
                                        new_text: edit.new_text,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        NormalizedWorkspaceEdit {
            changes: if all_changes.is_empty() {
                None
            } else {
                Some(all_changes)
            },
        }
    });

    NormalizedCodeAction {
        title: code_action.title,
        kind: code_action.kind,
        edit,
        command: code_action.command,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::lsp::protocol::{Position, Range};
    use crate::core::lsp::session::{CodeAction, TextEdit, WorkspaceEdit};
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn uri_to_path_decodes_file_uris() {
        let path = uri_to_path("file:///tmp/project/hello%20world.ts");
        assert_eq!(path, "/tmp/project/hello world.ts");
    }

    #[test]
    fn code_action_normalization_preserves_command_and_typed_edits() {
        let mut changes = HashMap::new();
        changes.insert(
            "file:///tmp/project/src/main.ts".to_string(),
            vec![TextEdit {
                range: Range {
                    start: Position {
                        line: 2,
                        character: 4,
                    },
                    end: Position {
                        line: 2,
                        character: 9,
                    },
                },
                new_text: "replacement".to_string(),
            }],
        );

        let normalized = code_action_to_normalized(CodeAction {
            title: "Apply fix".to_string(),
            kind: Some("quickfix".to_string()),
            edit: Some(WorkspaceEdit {
                changes: Some(changes),
                document_changes: None,
            }),
            command: Some(json!({
                "title": "Run follow-up",
                "command": "example.command"
            })),
        });

        assert_eq!(normalized.title, "Apply fix");
        assert_eq!(
            normalized
                .command
                .as_ref()
                .and_then(|c| c["command"].as_str()),
            Some("example.command")
        );
        let edit = &normalized.edit.unwrap().changes.unwrap()[0];
        assert_eq!(edit.file_path, "/tmp/project/src/main.ts");
        assert_eq!(edit.range.start_line, 2);
        assert_eq!(edit.range.start_character, Some(4));
        assert_eq!(edit.range.end_line, 2);
        assert_eq!(edit.range.end_character, Some(9));
        assert_eq!(edit.new_text, "replacement");
    }
}
