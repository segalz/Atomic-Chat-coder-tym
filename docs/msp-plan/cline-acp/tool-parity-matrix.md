# Atomic-Specific Tool Compatibility Matrix (Stage 16)

## 1. Executive Summary & Architecture Principles

This document formalizes the tool compatibility audit and operational boundaries between **Atomic Chat** and the **Cline ACP CLI backend** (`cline.cmd` 3.0.61, model `zai/glm-5.3-flash`) under the Agent Client Protocol (ACP).

### Core Principles
1. **Process Isolation & Transport**: The Cline CLI runs in its own host-managed process tree communicating with Atomic Chat strictly via JSON-RPC 2.0 over standard I/O (`stdio`).
2. **Autonomous Tool Loop Ownership**: Cline CLI manages its own internal autonomous agent loop. Atomic Chat **must never** double-execute, wrap, or simulate Cline tool events. When Cline performs a file read or search, it executes that operation directly within its workspace.
3. **Explicit Permission Lifecycle**: Any mutating or side-effecting operations (file edits, creations, deletions, and shell command executions) are gated by ACP's `session/request_permission` protocol. Atomic presents diffs and commands to the user for explicit approval (`allow_once`) or denial (`reject_once`).
4. **Strict Security & Credential Boundary**: Atomic Chat must **never** forward machine-global tool definitions, external API tokens (such as `SERPER_API_KEY`), or system credentials to Cline. Cline operates strictly within the bounded project workspace (`project_dir`).

---

## 2. Comprehensive Tool Parity Matrix

| Capability Domain | Atomic Chat (Ollama) Tool / Mechanism | Cline Native / ACP Capability | Parity Status | Operational Responsibility & Boundaries |
|---|---|---|---|---|
| **File Read** | `read_file` (internal Rust tool) | `read_file` (Cline native) | **Full Native Parity** | Cline executes reads directly within `project_dir`. No Atomic proxying. |
| **File Create** | `write_file` (Rust tool with AST check) | `write_to_file` (Cline native) | **Full Native Parity** | Cline initiates creation; Atomic gates via `session/request_permission`. |
| **File Edit** | `edit_file` (Search/Replace block replacement) | `replace_in_file` (Cline native) | **Full Native Parity** | Cline generates diff; Atomic inspects and renders diff for user approval. |
| **Directory Listing** | `list_dir` (Rust filesystem traversal) | `list_files` (Cline native) | **Full Native Parity** | Cline executes traversal directly within workspace boundaries. |
| **Regex Search** | `grep` (Rust regex search across files) | `search_files` (Cline native) | **Full Native Parity** | Cline executes pattern search natively. |
| **Shell Execution** | `run_shell` (Tokio command runner) | `execute_command` (Cline native) | **Full Native Parity** | Cline proposes command; Atomic gates via `session/request_permission`. |
| **Code Navigation** | `locate_code`, `find_and_analyze_code` | `list_code_definition_names` | **Functional Equivalent** | Cline uses native tree-sitter AST parsing for symbol hierarchies rather than heuristic search. |
| **LSP Diagnostics** | 6 `lsp_*` tools (`lsp_diagnostics`, `lsp_definitions`, etc.) | `execute_command` (linters/compilers) + tree-sitter | **Scoped Separation** | Atomic LSP remains Ollama-only. Cline utilizes native tree-sitter and command execution (`tsc`, `cargo check`). |
| **AST Validation** | `oxc_parser` in `agent_bridge.rs` (pre-diff validation) | Internal Cline linters & panel diff inspection | **Supervised by Atomic** | User reviews diffs in panel. Cline self-heals syntax errors via autonomous loop. |
| **MCP Subsystem** | `SharedMcpServers` in AppState (`mcpServers`) | `session/new` (`mcpServers: []`) | **Isolated & Filtered** | Global MCP servers and secrets are NOT forwarded to Cline. Sessions remain isolated. |
| **Planner Mode** | 4-stage pipeline in `plan_agent.rs` (Stages 1–4) | Cline `plan` mode & streamed assistant deltas | **Functional Equivalent** | Cline streams architectural plans into `appendPlanText`. Legacy 4-stage pipeline remains Ollama-only. |
| **Loop Supervision** | `Loop Supervision MCP` (`loop_supervision_server.rs`) | ACP prompt turns + frontend scheduler | **Fully Compatible** | Frontend schedules bounded turns via `sendPrompt`. Supervision MCP remains client-side in Atomic for audit/diff inspection (NOT forwarded in `mcpServers`). |

---

## 3. Deep-Dive Capability Audits

### 3.1 Core File and Terminal Operations
- **Atomic Architecture**: In the direct-ollama backend, tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_shell`) are declared as OpenAI-format function schemas and executed in Rust by `ollama_agent.rs`.
- **Cline ACP Architecture**: Cline CLI possesses native, battle-tested tool implementations. It does not accept OpenAI schemas. Instead, Cline decides when to read, write, or execute commands internally.
- **Resolution**: Cline retains full ownership. No translation adapter is required for core file and shell operations.

### 3.2 Language Server Protocol (LSP) & Code Intelligence
- **Atomic Architecture**: Atomic manages language server processes (TypeScript, Rust, etc.) via `core::lsp::manager`, exposing 6 read-only tools to Ollama when `lsp_enabled` is set.
- **Cline ACP Architecture**: Cline CLI incorporates tree-sitter parsers (`list_code_definition_names`) for cross-language symbol definitions. For diagnostics, Cline routinely invokes project-native tooling (`execute_command` running `tsc --noEmit`, `eslint`, `pytest`, `cargo check`).
- **Resolution**: Exposing Atomic's internal LSP manager over an MCP wrapper is unnecessary and introduces fragile process dependencies. Cline's native capabilities provide effective, project-native language intelligence without requiring synthetic process bridges. Atomic LSP remains direct-ollama specific.

### 3.3 AST & Edit Validation (Oxidation Compiler)
- **Atomic Architecture**: `agent_bridge.rs` uses `oxc_parser` to validate JS/TS syntax before proposing diffs to the UI, returning parse errors to Ollama for self-healing.
- **Cline ACP Architecture**: When Cline proposes edits, ACP delivers the complete diff in `session/request_permission`. Cline verifies changes internally and can run compiler/linter checks directly.
- **Resolution**: Diff validation is handled visually by the user in Atomic's diff review panel. Atomic does not reject Cline's proposed diffs via `oxc_parser` behind the scenes, ensuring the user retains full transparency and authority.

### 3.4 Model Context Protocol (MCP) & Credential Safeguards
- **Atomic Architecture**: Atomic maintains a global registry of MCP servers in `AppState` (`mcpServers`), which may contain third-party integrations (Exa, Browser, Serper) with environment variables containing private API keys (e.g. `SERPER_API_KEY`).
- **Cline ACP Architecture**: ACP's `session/new` protocol message accepts an optional array `mcpServers: McpServerConfig[]`.
- **Security Resolution**:
  1. **Zero Secret Leakage**: Machine-global MCP servers configured in Atomic **must never** be forwarded en masse to Cline.
  2. **Default Isolation**: `start_cline_agent` passes empty `mcpServers: []` during session initialization.
  3. **Scoped Future Extensions**: Any future MCP exposure must be strictly opt-in, explicitly vetted by the user, and stripped of extraneous environment variables.

### 3.5 Planner & Multi-Stage Architecture
- **Atomic Architecture**: `plan_agent.rs` implements a 4-stage pipeline (Translate -> Vision -> Navigate -> Architect) spawning Claude CLI / Ollama in read-only mode.
- **Cline ACP Architecture**: Cline has native support for `plan` mode (read-only architectural analysis) vs `act` mode, and streams plan markdown directly to the assistant transcript.
- **Resolution**: In Atomic Chat's Coding Agent Panel, Cline streams thought deltas and plan markdown directly into `appendPlanText`. The legacy 4-stage `run_plan_pipeline` command remains reserved for Ollama.

### 3.6 Loop Supervision & Multi-Turn Lifecycle
- **Atomic Architecture**: Loop Mode provides automated, multi-run iterative development governed by `loop_supervision_server.rs` and frontend interval scheduling.
- **Cline ACP Architecture**: Cline operates over persistent multi-turn sessions (`sessionId`). Each prompt turn streams real-time progress and terminates with `stopReason: "end_turn"`.
- **Resolution**: Loop scheduling in the panel seamlessly orchestrates successive Cline turns using `isContinuation: true`, maintaining session context without prompt bloat. `Loop Supervision MCP` remains strictly an Atomic-side client tool for local supervision and diff inspection, and is NOT injected into Cline's ACP `mcpServers`. Stages 18 and 19 will route and supervise bounded Loop runs.

---

## 4. Security & Isolation Boundaries

To maintain system integrity and user privacy, the following hard boundaries are enforced:
1. **Workspace Confinement**: All file modifications and shell executions initiated by Cline CLI must remain bounded by the selected `project_dir`.
2. **Credential Protection**: Atomic Chat shall not export host environment secrets, API tokens, or user configuration files to Cline processes.
3. **No Automatic Tool Execution**: Atomic Chat shall never execute tools on Cline's behalf.
4. **Deterministic Permission Gating**: All side-effecting operations require explicit user approval. Rejections are strictly communicated back to Cline via ACP rejection responses (`allow: false`).

---

## 5. Stage 17 Implementation Directives

Per `instructions.md`:
> *"If stage 16 proves no new adapter is needed, verify that with evidence rather than inventing code."*

### Key Conclusion & Directive:
1. **No New Tool Adapter Needed**: The audit confirms that Cline CLI 3.0.61 natively provides full tool parity for file reading, file creation, file editing, directory traversal, regex searching, terminal command execution, and symbol navigation.
2. **No Protocol Translation Bridge Required**: Attempting to inject Atomic's Ollama-specific tool schemas or wrap Atomic's LSP in a synthetic MCP server would add unnecessary complexity without improving functionality.
3. **Stage 17 Scope**: Stage 17 will verify these bounded operational limits and ensure that no unapproved tools, global configurations, or sensitive contexts are advertised or leaked.