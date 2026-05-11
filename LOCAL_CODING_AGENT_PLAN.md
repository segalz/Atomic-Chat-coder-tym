# LOCAL CODING AGENT — Implementation Plan

**Goal:** Transform Atomic Chat into a local-first coding assistant for React Native development, UI-comparable to Claude Desktop / Codex Desktop, running **exclusively** on Ollama. No cloud calls.

**Scope discipline:** Single user. Own projects only. No multi-tenant sandbox paranoia. No Gemini CLI. No Anthropic API. Reuse existing MCP infrastructure.

---

## Architectural Decisions (Locked)

1. **Drop Claude Code CLI dependency for the agent loop.** It's hardwired to Anthropic API; proxy hacks are brittle. Build a native Rust agent loop that drives Ollama directly via its OpenAI-compatible `/v1/chat/completions` endpoint with tool-use.
2. **Reuse existing MCP servers** at `src-tauri/src/core/mcp/` (filesystem, bash) as the agent's tools. No rewrite.
3. **Reuse `CodeHelper` MCP** (`find_and_analyze_code`, `search_code_semantic`) for context retrieval. Do **not** reimplement TF-IDF in Rust.
4. **Minimum model:** `qwen2.5-coder:32b` or `deepseek-coder-v2:16b`. Smaller models break tool-calling. Document this as a hard requirement.
5. **Vision:** `qwen2.5-vl:7b` (or larger) via Ollama for screenshot understanding.
6. **No custom sandbox.** Single-user, own code. Rely on project-root cwd enforcement in MCP filesystem tool.

---

## Target UX (Claude Desktop / Codex Desktop parity)

Single unified panel, four zones:

- **Left:** Project picker + file tree + "capture sim" button.
- **Center-top:** Plan (markdown, streamed from planner model, read-only).
- **Center-bottom:** Execution log (tool calls, reasoning tokens, streaming).
- **Right:** Pending diffs with Approve/Reject per file.

One conversation thread. One execute button. No mode switching.

---

## Subtasks

### S1 — Ollama agent loop (Rust)
**File:** `src-tauri/src/core/ollama_agent.rs` (new)
- Streaming client to `http://localhost:11434/v1/chat/completions`.
- Tool-use loop: emit tool schemas, parse `tool_calls`, dispatch to MCP, feed results back.
- Emits typed events over Tauri channel: `text_delta`, `tool_call_start`, `tool_call_result`, `diff_proposed`, `done`.
- Config via existing [planner_config.rs](src-tauri/src/core/planner_config.rs): model name, temperature, max_iterations, system prompt.

**Done when:** CLI test drives a 5-step task (read → edit → save) end-to-end against local Ollama.

### S2 — MCP tool bridge for the agent
**File:** `src-tauri/src/core/mcp/agent_bridge.rs` (new)
- Thin adapter exposing existing MCP tools as OpenAI-style function schemas.
- Tools: `read_file`, `write_file`, `edit_file` (diff-based), `list_dir`, `grep`, `run_shell` (project-root cwd locked), `find_and_analyze_code` (proxy to CodeHelper).
- `write_file` and `edit_file` do **not** commit directly — they emit `diff_proposed` events and block until UI approves.

**Done when:** agent cannot write outside project root; approval gate works.

### S3 — Unified `CodingAgentPanel`
**Files:** `web-app/src/containers/CodingAgentPanel/` (new), replaces `CodeModePanel` + `PlanMode` entry points.
- Four-zone layout described above.
- Subscribes to Tauri event channel from S1.
- Uses `react-diff-viewer-continued` for diffs (lightweight, no Monaco).
- Approve/Reject buttons call back into Rust to resume/abort the blocked `edit_file` tool call.

**Done when:** full flow — prompt → plan streams → execute → diffs appear → approve → file written.

### S4 — Screenshot → context hook
**Files:** `src-tauri/src/core/sim_capture.rs` (new), button in S3 panel.
- iOS: `xcrun simctl io booted screenshot <tmp>`.
- Android: `adb exec-out screencap -p > <tmp>` (single-shot, no persistent socket — sufficient for interactive use).
- Feed PNG to `qwen2.5-vl` via Ollama vision endpoint → extract UI text + description.
- Inject description as a user message in the thread; agent then calls `find_and_analyze_code` to locate source.

**Done when:** "capture sim" → agent identifies the screen's source component within 1–2 tool calls.

### S5 — Test runner detection + auto-verify
**File:** `src-tauri/src/core/test_runner.rs` (new)
- Fingerprint detection: `package.json` scripts (RN default: `jest`), `jest.config.*`, `vitest.config.*`.
- After agent finishes a task, optionally runs `yarn test --findRelatedTests <changed_files>` and feeds failures back into the loop (max 2 auto-retries).
- Toggleable in UI; off by default.

**Done when:** intentional failing edit → agent sees test output → fixes → passes.

### S6 — Config + onboarding
**File:** extend [planner-config.toml](src-tauri/src/core/planner_config.rs) schema.
- Fields: `ollama_url`, `code_model`, `vision_model`, `max_iterations`, `auto_verify`.
- First-run check: Ollama reachable? required models pulled? If not, show guided install screen in the panel.

**Done when:** fresh machine → launch → guided setup → working agent, no manual config editing.

---

## Out of Scope (Explicitly)

- Gemini CLI / any cloud architect.
- SBPL / Seatbelt sandboxing.
- Persistent ADB socket streaming.
- Monaco diff editor.
- Multi-user security model.
- TF-IDF reimplementation (use CodeHelper instead).

---

## Order & Estimated Effort

1. S1 + S2 together (core loop) — largest chunk, unblocks everything.
2. S3 (UI) — parallel-friendly once S1 events are stable.
3. S6 (config) — small, do alongside S3.
4. S4 (screenshot) — additive, low risk.
5. S5 (auto-verify) — last, quality-of-life.

Ship S1–S3+S6 first as "v1 local coder." S4 + S5 are v1.1.
