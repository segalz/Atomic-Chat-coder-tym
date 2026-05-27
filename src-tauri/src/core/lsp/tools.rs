//! Read-only LSP agent tools for the Code Agent.
//!
//! These tools provide semantic code information without modifying files.
//! They must be used only after LSP is initialized and in valid state.

pub use crate::core::lsp::session::{
    CodeAction, CodeActionContext, CodeActionParams, DocumentSymbolResult, Location,
    NormalizedDiagnostic, NormalizedRange, NormalizedSymbol, SymbolKind, TextEdit, WorkspaceEdit,
};

pub use crate::core::lsp::tools_impl::{
    DefinitionResult, HoverResult, LspToolResult, NormalizedCodeAction, NormalizedTextEdit,
    NormalizedWorkspaceEdit, ReferencesResult, SourceIndicator,
};
