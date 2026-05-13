# Ollama Coder Standalone Plan and Final QA

## Scope

This document closes Stage 12 of the Ollama Coder migration. It captures:

- remaining Claude assumptions in Atomic Chat code paths
- standalone extraction target for `ollama-coder`
- manual QA checklist for direct Ollama coding flow
- migration handoff notes and rollback posture

## Current Architecture Snapshot

- Visible Coding Agent panel defaults to `direct-ollama`.
- Legacy `spawn_code_agent` (`ollama launch claude`) is still present as fallback.
- Direct coding path is implemented by:
  - `src-tauri/src/core/ollama_agent.rs`
  - `src-tauri/src/core/mcp/agent_bridge.rs`
  - `web-app/src/containers/CodingAgentPanel/index.tsx`
  - `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`

## Remaining Claude Assumptions (Search Summary)

The migration for the visible Coding Agent is done, but repo-wide Claude references still exist and should not be copied into standalone `ollama-coder` unless intentionally required.

Primary buckets:

1. Coding legacy fallback:
   - `src-tauri/src/core/code_agent.rs`
   - legacy events `code-agent-output`, `code-agent-done`, `code-agent-error`
2. Claude settings UX and commands:
   - `web-app/src/routes/settings/claude-code.tsx`
   - `src-tauri/src/core/system/commands.rs` handlers registered in `src-tauri/src/lib.rs`
3. Plan-mode and docs that intentionally mention Claude:
   - `src-tauri/src/core/plan_agent.rs` related docs in repo root
4. General product/docs model catalogs containing Anthropic model IDs.

Decision:
- Keep these references in Atomic Chat for now.
- Exclude them from the standalone `ollama-coder` app baseline.

## Standalone Extraction Target

Proposed location:

- `/Users/zvisegal/devlope/ollama-coder` (new sibling repository)

Proposed package/app identity:

- App name: `ollama-coder`
- Tauri bundle identifier: `ai.jan.ollamacoder` (or org-specific equivalent)

## Minimum Standalone Modules

Backend (required):

- `src-tauri/src/core/ollama_agent.rs`
- `src-tauri/src/core/mcp/agent_bridge.rs`
- command wiring for:
  - `start_ollama_agent`
  - `stop_ollama_agent`
  - `approve_agent_diff`
  - `reject_agent_diff`

Frontend (required):

- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`
- `web-app/src/stores/coding-agent-store.ts`
- minimal shell routing/state needed to mount the panel

Config (required):

- coding-agent relevant fields from `src-tauri/resources/planner-config.toml`
- Ollama base URL / model defaults used by Coding Agent

Can be dropped from standalone baseline:

- Claude Code settings page and commands
- legacy `spawn_code_agent` UI path
- unrelated chat providers/model catalogs not required for local coder UX

## Atomic Chat Dependencies To Avoid Carrying Forward

- global provider/model ecosystems not needed for coding panel
- unrelated settings menus/routes
- plan-mode or Claude tooling unless explicitly in scope
- old event path `code-agent-*` after direct-only stabilization

## Final Manual QA Checklist (Direct Ollama)

Status key: `[ ]` pending, `[x]` complete

- [x] Normal prompt returns text to execution log.
- [x] Tool start/result events render in log (verified by mapping and local HTTP/tool-call checks).
- [x] `write_file` and `edit_file` require approval before write.
- [x] Reject path returns tool error and does not write file.
- [x] Cancel/stop reaches terminal state and clears running status.
- [x] Failure states (tool/model errors) clear running status and stop loop.
- [x] Idle timeout and max runtime safeguards exist in direct backend.
- [x] Legacy fallback still available by override.
- [ ] Full GUI-driven direct loop run in desktop app (blocked previously by macOS accessibility automation limits; should be run manually in-app).

## Rollback and Fallback

- Current rollback: set `VITE_CODING_AGENT_BACKEND=legacy-claude` or `localStorage["coding-agent-backend"]="legacy-claude"`.
- Do not remove legacy backend files until manual GUI loop checklist item is completed successfully.

## Handoff Notes

1. Keep Atomic Chat as migration host until direct GUI loop is manually validated.
2. Start standalone extraction by copying only minimum modules listed above.
3. Add CI checks in standalone repo:
   - `cargo check` for Tauri backend
   - frontend `tsc` for panel/store/adapter
4. After standalone is stable:
   - decide whether Atomic Chat keeps dormant legacy fallback or removes it fully
   - remove `code-agent-*` compatibility adapter branches if legacy is retired
