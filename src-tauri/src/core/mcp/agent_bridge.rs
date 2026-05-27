//! S2 — MCP Bridge & Oxc Validation Layer
//!
//! Exposes MCP tools as OpenAI-style function schemas and provides an invisible
//! AST validation gate for JS/TS edits via the Oxidation Compiler (oxc_parser).
//!
//! Validation flow for edit_file / write_file:
//!   1. Apply Search/Replace to an in-memory buffer.
//!   2. Run oxc_parser on the result (only for .js/.jsx/.ts/.tsx).
//!   3. If valid  → caller emits `diff_proposed` and waits for UI approval.
//!   4. If invalid → return Err(diagnostic) so the S1 Self-Healing loop can fix
//!                   the AST before the diff ever reaches the user.

use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde_json::{json, Value};

// ── Tool schemas ──────────────────────────────────────────────────────────────

/// OpenAI function-calling schemas for the 5 read-only LSP tools.
/// Returned only when `lsp_enabled` is true.
fn lsp_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "lsp_diagnostics",
                "description": "Get LSP diagnostics (errors, warnings) for a file. Returns an empty list if no diagnostics or LSP unavailable.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string", "description": "Absolute path to the project root" },
                        "file_path": { "type": "string", "description": "Absolute path to the file to check" }
                    },
                    "required": ["project_dir"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "lsp_definitions",
                "description": "Go-to-definition: find where a symbol at a given position is defined. Returns null if not found.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string" },
                        "file_path": { "type": "string", "description": "Absolute path to the file" },
                        "line": { "type": "integer", "description": "0-based line number" },
                        "character": { "type": "integer", "description": "0-based character offset" }
                    },
                    "required": ["project_dir", "file_path", "line", "character"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "lsp_references",
                "description": "Find all references to a symbol at a given position. Capped at 100 results.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string" },
                        "file_path": { "type": "string" },
                        "line": { "type": "integer", "description": "0-based line number" },
                        "character": { "type": "integer", "description": "0-based character offset" }
                    },
                    "required": ["project_dir", "file_path", "line", "character"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "lsp_hover",
                "description": "Get hover information (type, docs) for a symbol at a given position.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string" },
                        "file_path": { "type": "string" },
                        "line": { "type": "integer", "description": "0-based line number" },
                        "character": { "type": "integer", "description": "0-based character offset" }
                    },
                    "required": ["project_dir", "file_path", "line", "character"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "lsp_document_symbols",
                "description": "List symbols (functions, classes, variables) defined in a file. Capped at 200 symbols.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string" },
                        "file_path": { "type": "string", "description": "Absolute path to the file" }
                    },
                    "required": ["project_dir", "file_path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "lsp_code_actions",
                "description": "Get code actions (quick fixes and refactoring options) for a range in a file. Use this to get LSP suggestions for fixing diagnostics or refactoring code.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_dir": { "type": "string" },
                        "file_path": { "type": "string", "description": "Absolute path to the file" },
                        "start_line": { "type": "integer", "description": "0-based line number for start of range" },
                        "start_character": { "type": "integer", "description": "0-based character offset for start of range" },
                        "end_line": { "type": "integer", "description": "0-based line number for end of range" },
                        "end_character": { "type": "integer", "description": "0-based character offset for end of range" }
                    },
                    "required": ["project_dir", "file_path", "start_line", "start_character", "end_line", "end_character"]
                }
            }
        }),
    ]
}

/// OpenAI function-calling schemas for all MCP tools exposed to the agent.
/// S1 calls this to build the `tools` array sent with every completion request.
/// Pass `lsp_enabled = true` to include the 5 read-only LSP tools.
pub fn tool_schemas(lsp_enabled: bool) -> Value {
    let mut base = json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the full contents of a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or project-relative file path"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create a new file with the given content. Use ONLY for new files — use edit_file for existing ones.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Edit a file using an exact Search/Replace block. \
                    `search` MUST be a verbatim, unique substring of the current file content \
                    (copy-paste from read_file output). `replace` is what it becomes. \
                    Call once per location; never produce whole-file rewrites.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "search": {
                            "type": "string",
                            "description": "Exact text currently in the file (verbatim, unique)"
                        },
                        "replace": {
                            "type": "string",
                            "description": "Text that replaces the search block"
                        }
                    },
                    "required": ["path", "search", "replace"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and directories at a path. Common build/dep dirs are skipped automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search for a regex pattern in files under a directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string" },
                        "path": { "type": "string" },
                        "file_glob": {
                            "type": "string",
                            "description": "Optional glob filter, e.g. '*.tsx'"
                        }
                    },
                    "required": ["pattern", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_shell",
                "description": "Run a shell command in the project directory. Use sparingly — prefer file tools.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "cwd": {
                            "type": "string",
                            "description": "Working directory (defaults to project root)"
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "locate_code",
                "description": "Locate relevant project files, symbols, dependency hints, and suggested read targets for a coding task. This is a lightweight deterministic code locator; prefer it before broad grep/read_file exploration. If it reports low confidence, no matches, or an internal error, fall back to targeted grep/read_file and continue.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language description of the code area, symbol, behavior, or bug to locate"
                        },
                        "path": {
                            "type": "string",
                            "description": "Optional root directory to search under (defaults to project root)"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of ranked files to return (default 10, max 20)"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find_and_analyze_code",
                "description": "Search the codebase for relevant files and symbols related to a task, returning a structured analysis. Prefer this over multiple read_file + grep calls when you need broader context.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language description of what you are looking for"
                        },
                        "path": {
                            "type": "string",
                            "description": "Root directory to search under (defaults to project root)"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_python",
                "description": "Execute a Python 3 snippet and return its stdout. Use for calculations, data transformations, and any task that does not require AI reasoning — math, unit conversions, sorting, JSON manipulation, etc. Do NOT use for file edits (use edit_file) or shell operations (use run_shell).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "Valid Python 3 code. Must print the result to stdout."
                        }
                    },
                    "required": ["code"]
                }
            }
        }
    ]);

    if lsp_enabled {
        let extra = lsp_tool_schemas();
        base.as_array_mut().unwrap().extend(extra);
    }

    base
}

// ── Oxc Validation ────────────────────────────────────────────────────────────

/// JS/TS extensions that oxc_parser can validate.
const JS_TS_EXTENSIONS: &[&str] = &["js", "jsx", "ts", "tsx", "mjs", "cjs"];

/// Validate `source` as JS/TS using the Oxidation Compiler parser.
///
/// Returns `Ok(())` for non-JS/TS files (no-op) or when the AST is clean.
/// Returns `Err(diagnostic)` with precise location info on parse failure so the
/// S1 Self-Healing loop can feed it back to the model.
pub fn validate_js_ts(source: &str, path: &Path) -> Result<(), String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    if !JS_TS_EXTENSIONS.contains(&ext) {
        return Ok(());
    }

    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let ret = Parser::new(&allocator, source, source_type).parse();

    if ret.errors.is_empty() {
        return Ok(());
    }

    let diagnostics = ret
        .errors
        .iter()
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join("\n");

    Err(format!(
        "Oxc AST validation failed for '{}':\n{}\n\
         Fix the syntax error above, then retry the edit.",
        path.display(),
        diagnostics
    ))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn valid_ts_passes() {
        let src = "const x: number = 42;\nexport default x;\n";
        let path = PathBuf::from("foo.ts");
        assert!(validate_js_ts(src, &path).is_ok());
    }

    #[test]
    fn invalid_ts_returns_err() {
        let src = "const x: number = ;\n"; // missing initializer
        let path = PathBuf::from("foo.ts");
        let result = validate_js_ts(src, &path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Oxc AST validation failed"));
    }

    #[test]
    fn non_js_ts_file_is_skipped() {
        let src = "this is not valid js {{ }} !!";
        let path = PathBuf::from("README.md");
        assert!(validate_js_ts(src, &path).is_ok());
    }

    #[test]
    fn tool_schemas_has_all_tools() {
        let schemas = tool_schemas(false);
        let names: Vec<&str> = schemas
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"write_file"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"list_dir"));
        assert!(names.contains(&"grep"));
        assert!(names.contains(&"run_shell"));
        assert!(names.contains(&"locate_code"));
        assert!(names.contains(&"find_and_analyze_code"));
    }

    #[test]
    fn tool_schemas_includes_lsp_when_enabled() {
        let schemas = tool_schemas(true);
        let names: Vec<&str> = schemas
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"lsp_diagnostics"));
        assert!(names.contains(&"lsp_definitions"));
        assert!(names.contains(&"lsp_references"));
        assert!(names.contains(&"lsp_hover"));
        assert!(names.contains(&"lsp_document_symbols"));
        assert!(names.contains(&"lsp_code_actions"));
    }

    #[test]
    fn tool_schemas_excludes_lsp_when_disabled() {
        let schemas = tool_schemas(false);
        let names: Vec<&str> = schemas
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert!(!names.contains(&"lsp_diagnostics"));
        assert!(!names.contains(&"lsp_document_symbols"));
    }
}
