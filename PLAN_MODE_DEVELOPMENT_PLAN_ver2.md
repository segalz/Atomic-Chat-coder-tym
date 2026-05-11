להלן הגרסה המעודכנת והאופטימלית של תוכנית התכנות עבור **Atomic Chat**, אשר עברה שכתוב והתאמה קפדנית המבוססת אך ורק על מסקנות המחקר שסיפקת. הדגש בגרסה זו הוא על אמינות, ניהול קונטקסט נכון, ולידציה מוקדמת, ומעבר לתבניות עריכה מותאמות למודלים מקומיים.

---

# LOCAL CODING AGENT — Optimized Implementation Plan

**Goal:** Transform Atomic Chat into a hardened, local-first coding assistant for React Native development, UI-comparable to Claude Desktop / Codex Desktop, running **exclusively** on Ollama. No cloud calls.

**Scope discipline:** Single user. Own projects only. No multi-tenant sandbox paranoia. No Gemini CLI. No Anthropic API. Reuse existing MCP infrastructure.

---

## Architectural Decisions (Locked & Optimized)

1. **Native Rust Agent Loop:** Drop Claude Code CLI. Build a high-performance native Rust agent loop (using Tokio async) that drives Ollama directly via its OpenAI-compatible `/v1/chat/completions` endpoint. This ensures C++ level performance and memory safety for long-lived processes.
2. **Strict Search/Replace Editing Paradigm:** Abandon unified diffs and whole-file rewrites. The agent will strictly use a **Search/Replace block schema** (similar to git conflict markers). This increases edit accuracy for 16B-32B local models up to ~70%+ and prevents "lazy coding" hallucinations.
3. **Pre-Diff Validation via Oxc:** Integrate the **Oxidation Compiler (Oxc)** in the Rust backend for high-speed, in-memory AST validation of TSX/JSX *before* any diff is sent to the UI.
4. **Self-Healing Loop (Try-Heal-Retry):** Implement an automated recovery mechanism for malformed JSON, tool call errors, or AST validation failures, capped at 3 retries.
5. **Aggressive Context Management:** Implement dynamic pruning and directory blacklisting to prevent hitting the 32K/128K context wall.
6. **Minimum Model Specs:** `qwen2.5-coder:32b` (~20GB VRAM) or `deepseek-coder-v2:16b` (~8.3GB VRAM). Vision: `qwen2.5-vl:7b`.

---

## Target UX (Claude Desktop / Codex Desktop parity)

Single unified panel, four zones:
- **Left:** Project picker + file tree + "capture sim" button.
- **Center-top:** Plan (markdown, streamed from planner model, read-only).
- **Center-bottom:** Execution log (tool calls, reasoning tokens, streaming).
- **Right:** Pending diffs (Search/Replace outcomes) with Approve/Reject per file.

One conversation thread. One execute button. No mode switching.

---

## Subtasks

### S1 — Ollama Agent Loop & Context Manager (Rust)
**File:** `src-tauri/src/core/ollama_agent.rs` (new)
- Streaming client to `http://localhost:11434/v1/chat/completions`.
- **Self-Healing Engine:** Intercept tool failures or parsing errors and feed them back to the model as a corrective system message (max 3 auto-retries).
- **Context Protection:** Implement tool result pruning (removing/compacting oldest outputs). Automatically ignore `node_modules`, `ios/Pods`, and `.git` in any directory traversal to prevent context flooding.
- Emits typed events over Tauri channel: `text_delta`, `tool_call_start`, `tool_call_result`, `diff_proposed`, `done`.

### S2 — MCP Bridge & Oxc Validation Layer
**File:** `src-tauri/src/core/mcp/agent_bridge.rs` (new)
- Thin adapter exposing existing MCP tools as OpenAI-style function schemas (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_shell`, `find_and_analyze_code`).
- **Optimized `edit_file`:** Forces the model to use the Search/Replace block schema.
- **Invisible Validation Layer:** Before emitting a `diff_proposed` event, the Rust backend applies the Search/Replace changes to an in-memory buffer and runs it through `oxc_parser`.
    - *If Valid:* Emits `diff_proposed` and blocks for UI approval.
    - *If Invalid:* Intercepts the error, feeds the specific Oxc parser error/location back into the S1 Self-Healing loop to fix the AST automatically.

### S3 — Unified `CodingAgentPanel`
**Files:** `web-app/src/containers/CodingAgentPanel/` (new)
- Four-zone layout.
- Subscribes to Tauri event channel from S1.
- Uses `react-diff-viewer-continued` for diffs. The UI must cleanly render the results of the applied Search/Replace blocks.
- Approve/Reject buttons call back into Rust to resume/abort the blocked `edit_file` tool call. Rejections are fed back into the agent's context as explicit instructions.

### S4 — High-Speed Vision Simulator Context
**Files:** `src-tauri/src/core/sim_capture.rs` (new)
- **iOS:** `xcrun simctl io booted screenshot <tmp>` (direct frame buffer path).
- **Android:** `adb exec-out screencap -p > <tmp>` (pull raw binary stream directly to bypass slow on-device conversion, targeting <100ms latency).
- Feed to `qwen2.5-vl` via Ollama vision endpoint to extract UI text and layout metadata.
- Inject description as a user message. Agent uses `find_and_analyze_code` to map the visual observation directly to the React Native component tree (JSX/TSX).

### S5 — Test Verification & Regression Loop
**File:** `src-tauri/src/core/test_runner.rs` (new)
- Fingerprint detection: `package.json` scripts, `jest.config.*`, `vitest.config.*`.
- After user approves a diff, optionally run `yarn test --findRelatedTests <changed_files>`.
- **Closed-Loop Verification:** Parse the test result JSON. If a test fails, feed the failure trace directly back into the S1 Self-Healing loop as a new user message, forcing the model to re-analyze and fix the regression.

### S6 — Config & Hardware Onboarding
**File:** Extend `planner-config.toml` schema.
- Fields: `ollama_url`, `code_model`, `vision_model`, `max_iterations`, `auto_verify`.
- **System Resource Check:** During the first-run guided setup, validate that Ollama is reachable and check host machine VRAM. Provide warnings if the selected model exceeds available hardware capabilities (e.g., warning if trying to run the 32B model with less than 24GB VRAM/Unified Memory).
- Offer one-click "pull" buttons for missing models.

---

## Order & Estimated Effort

1. **S1 + S2 (Core Loop + Validation):** Largest chunk. Building the Tokio loop, strict Search/Replace enforcement, and Oxc AST validation are the foundation.
2. **S3 (UI):** Parallel-friendly once S1 events are stable.
3. **S6 (Config & Onboarding):** Small, do alongside S3 to ensure smooth VRAM/Model checks.
4. **S4 (Vision Hook):** Additive. Focus on the optimized ADB binary stream.
5. **S5 (Auto-Verify):** Last step to close the regression loop.