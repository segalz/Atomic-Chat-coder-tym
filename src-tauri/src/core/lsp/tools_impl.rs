//! LSP tool types and result wrappers for the Code Agent.
//!
//! These types are used for communication between the LSP session and the agent.

use crate::core::lsp::session::{Location, NormalizedRange};
use serde::{Deserialize, Serialize};

/// Source indicator for LSP vs fallback results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub struct SourceIndicator {
    pub from_lsp: bool,
}

/// Result wrapper for LSP tools indicating source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspToolResult<T> {
    pub tool: T,
    pub source: SourceIndicator,
}

/// Result of lsp_definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefinitionResult {
    pub is_lsp: bool,
    pub target_path: Option<String>,
    pub range: Option<NormalizedRange>,
    pub related: Vec<Location>,
}

/// Result of lsp_references.
/// Cap at 100 references for model context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferencesResult {
    pub is_lsp: bool,
    pub path: Option<String>,
    pub references: Vec<Location>,
}

/// Result of lsp_hover.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverResult {
    pub is_lsp: bool,
    pub contents: String,
}

/// Normalized code action for agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub edit: Option<NormalizedWorkspaceEdit>,
    pub command: Option<serde_json::Value>,
}

/// Normalized workspace edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedWorkspaceEdit {
    pub changes: Option<Vec<NormalizedTextEdit>>,
}

/// Normalized text edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedTextEdit {
    pub file_path: String,
    pub range: NormalizedRange,
    pub new_text: String,
}
