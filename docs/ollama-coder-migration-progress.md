# Ollama Coder Migration - Progress

## Current Status

Stage 12 completed. Migration goals for the visible Coding Agent path are complete: direct Ollama is the default backend, legacy Claude-backed fallback remains available behind override, and final standalone extraction + QA handoff documentation has been produced.

## Stage Status

| Stage | Name | Status |
| --- | --- | --- |
| 1 | Baseline And Safety Branch | COMPLETED |
| 2 | Runtime Evidence For Stuck Loop | COMPLETED |
| 3 | Legacy Watchdog And Max Runtime | COMPLETED |
| 4 | Legacy Process Group Cleanup | COMPLETED |
| 5 | UI Stalled State And Loop Failure Policy | COMPLETED |
| 6 | Verify Legacy Loop Cannot Hang Forever | COMPLETED |
| 7 | Map Direct Ollama And UI Contracts | COMPLETED |
| 8 | Event Adapter And Backend Selection Flag | COMPLETED |
| 9 | Connect UI To Direct Ollama Behind Flag | COMPLETED |
| 10 | Verify Direct Ollama Core Flow | COMPLETED |
| 11 | Verify Direct Ollama Loop And Make Default | COMPLETED |
| 12 | Standalone Plan, QA Checklist, And Final Docs | COMPLETED |

## Next Stage

Migration complete (all planned stages completed)

## Next Stage Notes

All planned migration stages are completed. Remaining follow-up is operational QA hardening: run one successful manual GUI-driven direct loop in desktop app and then decide legacy fallback retirement timing.

## Completed Work

### 2026-05-13

- Completed Stage 1 baseline inspection.
- Confirmed the visible Code Agent UI still invokes `spawn_code_agent` from `web-app/src/containers/CodingAgentPanel/index.tsx`.
- Confirmed the legacy backend still builds `ollama launch claude --model ... -- -p --output-format stream-json --verbose` in `src-tauri/src/core/code_agent.rs`.
- Confirmed the UI loop scheduler advances only after `agentStatus` becomes `free`.
- Confirmed direct Ollama commands are already registered in `src-tauri/src/lib.rs`: `start_ollama_agent`, `stop_ollama_agent`, `approve_agent_diff`, and `reject_agent_diff`.
- Confirmed the direct Ollama agent emits `agent-text-delta`, `agent-tool-call-start`, `agent-tool-call-result`, `agent-diff-proposed`, and `agent-done`, while the current UI listens for the legacy `code-agent-output` / `code-agent-done` stream and separate `coding-agent-*` event names.
- Created and switched to branch `codex/ollama-agent-migration`.
- Recorded git status after branch creation: `## codex/ollama-agent-migration`.
- Created migration task tracking file.
- Created migration progress tracking file.
- Recorded a reusable continuation prompt for future conversations.
- Split the migration into small stages that can be executed one at a time.
- Revised the plan from 35 conservative stages to 12 larger conversation stages.
- Completed Stage 2 runtime evidence gathering.
- Inspected process state with `ps ax -ww -o pid,ppid,stat,etime,command` filtered for Ollama, Claude, Atomic Chat, Tauri, and coder-related processes.
- No active `/usr/local/bin/ollama launch claude ...` process was present at inspection time.
- Observed Ollama running as `/Applications/Ollama.app/Contents/Resources/ollama serve` with an active `ollama runner`.
- Observed one orphaned `claude` process with parent PID `1` and elapsed runtime of about `01:10:51`, plus unrelated Claude Desktop helper processes.
- Located app logs at `/Users/zvisegal/Library/Application Support/Atomic Chat/data/logs/app.log` and `/Users/zvisegal/Library/Application Support/ollama-coder/data/logs/app.log`.
- Atomic Chat log showed startup, Ollama model checks, MCP startup, Jan API server startup, update check, and cleanup, but no active `spawn_code_agent` run in the retained log.
- Ollama-coder log contained a legacy `[CodeAgent] stdout` stream event at `2026-05-13 07:32:40`, followed by app cleanup at `07:33:46`.
- The retained ollama-coder log did not include a corresponding explicit `code-agent-done`, process exit, timeout, or terminal status entry for that stdout event.
- Initial sandboxed process inspection was blocked with `operation not permitted`; the same read-only process inspection was rerun with approved escalation.
- Completed Stage 3 legacy watchdog and max-runtime implementation.
- Updated `src-tauri/src/core/code_agent.rs` only for the legacy `spawn_code_agent` path.
- Added fixed legacy safeguards: 10 minute idle timeout, 45 minute maximum wall-clock runtime, 5 second watchdog interval, and 2 second termination grace period.
- Added shared last-output tracking that is refreshed by both stdout and stderr reader tasks.
- Replaced stdout-EOF-owned process completion with a watchdog/lifecycle monitor that polls `try_wait`, clears child/stdin state, and emits `code-agent-done` on normal process exit.
- On idle timeout, max runtime timeout, or process-status polling error, the backend now emits `code-agent-error` followed by terminal `code-agent-done` with `success: false`.
- On timeout, the backend takes ownership of the child process from shared state before termination to avoid duplicate terminal events.
- Removed unintended broad `cargo fmt` changes outside the Stage 3 scope; only `src-tauri/src/core/code_agent.rs` and this progress file remain modified.
- Completed Stage 4 legacy process group cleanup.
- Updated `src-tauri/src/core/code_agent.rs` only for the legacy `spawn_code_agent` path.
- Added Unix/macOS process-group setup before spawning the legacy child by calling `setpgid(0, 0)` from `pre_exec`.
- Added a Unix helper for signaling the legacy child process group by PID.
- Updated timeout cleanup to send `SIGTERM` to the process group, wait for the termination grace period, then send `SIGKILL` to the process group if needed.
- Updated `stop_code_agent` to send both graceful and forceful stop signals to the process group on Unix/macOS.
- Preserved the existing non-Unix direct child termination behavior.
- Completed Stage 5 UI stalled-state and loop failure policy.
- Updated `web-app/src/containers/CodingAgentPanel/index.tsx`.
- Added a shared terminal-run handler that formats success, generic failure, idle timeout, and max-runtime timeout messages.
- Added runtime tracking for the last backend agent error so a following failed `code-agent-done` can show the specific failure reason instead of the generic stopped message.
- Added a listener for legacy backend `code-agent-error` while preserving the existing `coding-agent-error` listener for the current frontend/direct-agent event name.
- Added a failed UI state in the log header and a destructive inline banner for the last failed/stalled run.
- Defined conservative loop behavior after failure: any failed terminal state stops the loop, clears scheduled timers/countdown, clears the loop prompt, and records `Loop stopped after failed agent run.` in the execution log.
- Cleared stale failure display when a new prompt starts or the user manually stops/cancels the loop.
- Did not update `web-app/src/stores/coding-agent-store.ts` because persistence was not needed for Stage 5 runtime status.
- Did not add or update style files because the UI used existing utility classes and no new styling code was introduced.
- Completed Stage 6 legacy hang-prevention verification.
- Re-read `src-tauri/src/core/code_agent.rs` after the Stage 3 and Stage 4 changes.
- Confirmed the legacy watchdog polls `try_wait` every 5 seconds and emits `code-agent-done` on normal process exit.
- Confirmed process-status polling errors clear child/stdin state and emit `code-agent-error` followed by `code-agent-done` with `success: false`.
- Confirmed idle timeout and max runtime paths take ownership of the child, clear stdin state, emit `code-agent-error`, terminate the legacy process group, and then emit `code-agent-done` with `success: false`.
- Confirmed `stop_code_agent` takes ownership of the child before signaling, sends SIGTERM/SIGKILL to the process group on Unix/macOS, clears stdin state, and emits `code-agent-done` with `success: false`.
- Confirmed the watchdog exits without emitting a duplicate terminal event if `stop_code_agent` has already taken the child out of shared state.
- Re-read the Stage 5 UI completion handling in `web-app/src/containers/CodingAgentPanel/index.tsx`.
- Confirmed the UI listens to legacy `code-agent-error` and legacy `code-agent-done`.
- Confirmed failed terminal states do not set `agentStatus` to `free`; they set it to `failed`, clear running state, clear loop timers, disable loop mode, and avoid scheduling the next loop run.
- Re-read current Atomic Chat and ollama-coder logs. No new retained runtime evidence showed an active legacy timeout event after the watchdog change.
- Inspected processes with `pgrep -afil 'ollama|claude|Atomic Chat|ollama-coder|tauri|code_agent|spawn_code_agent'`.
- No active `ollama launch claude` legacy process was observed during Stage 6.
- Observed existing Ollama service/runner processes and unrelated Claude Desktop/Claude Code processes, including Claude app helper processes; none matched the legacy `ollama launch claude --model ...` command path.
- Did not stop or kill any user process.
- Did not perform a live 10-minute idle-timeout run or 45-minute max-runtime run because Stage 6 is verification-only, the configured timeouts are intentionally long, and the instructions prohibit stopping user processes without explicit approval.
- Completed Stage 7 direct Ollama and UI contract mapping.
- Re-read `src-tauri/src/core/ollama_agent.rs`.
- Confirmed direct Ollama command registration and command arguments: `start_ollama_agent(project_dir, prompt, model, ollama_base_url?)`, `stop_ollama_agent()`, `approve_agent_diff(call_id)`, and `reject_agent_diff(call_id)`.
- Confirmed direct Ollama event names and payloads: `agent-text-delta` with `{ text }`, `agent-tool-call-start` with `{ id, name }`, `agent-tool-call-result` with `{ id, name, result, is_error }`, `agent-diff-proposed` with `{ call_id, path, search, replace }`, and `agent-done` with `{ success, error }`.
- Confirmed direct Ollama write safety: `write_file` and `edit_file` validate JS/TS content before emitting `agent-diff-proposed`, then wait for approval through the pending diff channel before writing.
- Confirmed direct Ollama cancellation uses a `CancellationToken`; cancelled runs emit `agent-done` with `success: false` and `error: None`.
- Confirmed direct Ollama has `MAX_ITERATIONS = 40`, a 120 second HTTP client timeout per request, and self-healing retries, but no explicit UI-visible idle-timeout or max-wall-runtime event taxonomy yet.
- Re-read `src-tauri/src/core/mcp/agent_bridge.rs`.
- Confirmed tool schemas exposed to the model: `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_shell`, and `find_and_analyze_code`.
- Found a direct backend contract gap: `find_and_analyze_code` is advertised in schemas but is not implemented in `execute_tool`, so if the model calls it the backend returns `Unknown tool: find_and_analyze_code`.
- Re-read `web-app/src/containers/CodingAgentPanel/index.tsx`.
- Confirmed the visible panel still invokes `spawn_code_agent`, not `start_ollama_agent`.
- Confirmed stop handling invokes `stop_code_agent`, not `stop_ollama_agent`.
- Confirmed approve/reject already invoke the direct Ollama commands `approve_agent_diff` and `reject_agent_diff`, which only work for direct Ollama pending diffs.
- Confirmed the UI currently listens for unused `coding-agent-text-delta`, `coding-agent-tool-start`, `coding-agent-tool-result`, `coding-agent-diff-proposed`, and `coding-agent-error` event names.
- Confirmed the UI listens for legacy `code-agent-output`, `code-agent-done`, and `code-agent-error`, parses Claude stream-json from `code-agent-output`, and uses `code-agent-done` as the primary terminal event.
- Confirmed the UI does not listen to direct Ollama `agent-text-delta`, `agent-tool-call-start`, `agent-tool-call-result`, `agent-diff-proposed`, or `agent-done`, so direct runs would not currently render or reliably clear `isRunning`.
- Confirmed UI-local event type assumptions differ from the direct backend: tool start expects `input`, but direct Ollama emits only `id` and `name`; tool result expects `output`, but direct Ollama emits `result` and `is_error`; diff proposed expects `id` and `file_path`, but direct Ollama emits `call_id` and `path`; done expects only `success`, while direct Ollama includes `error`.
- Re-read `web-app/src/stores/coding-agent-store.ts`.
- Confirmed the store shape needed by the adapter: `appendPlanText`, `appendLog`, `addDiff`, `updateDiffStatus`, `startNewSession`, `saveCurrentSession`, `setRunning`, persisted `execLog`, persisted `pendingDiffs`, and rehydration that marks stale pending diffs as rejected.
- Identified exact Stage 8 adapter needs: define a common frontend event model; map legacy raw stream-json and direct typed events into that common model; preserve duplicate-done protection; use direct `agent-done.error` as the failure message; map direct diff IDs from `call_id` to `PendingDiff.id`; map direct diff paths from `path` to `PendingDiff.filePath`; map direct tool result `result` to log content and `is_error` to error display semantics; add a backend selection flag defaulting to `legacy-claude`; route send/stop commands by selected backend; avoid styling changes unless a visible selector is added.
- Completed Stage 8 event adapter and backend selection flag.
- Added `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`.
- Defined the backend flag type as `legacy-claude | direct-ollama` with `DEFAULT_CODING_AGENT_BACKEND` set to `legacy-claude`.
- Added a normalized frontend event model for text deltas, tool starts, tool results, diff proposals, done events, and error events.
- Mapped legacy raw `code-agent-output` stream-json into normalized frontend events.
- Mapped compatibility `coding-agent-*` events into normalized frontend events.
- Mapped direct Ollama `agent-text-delta`, `agent-tool-call-start`, `agent-tool-call-result`, `agent-diff-proposed`, and `agent-done` into normalized frontend events.
- Updated `web-app/src/containers/CodingAgentPanel/index.tsx` so event listeners use the adapter and one shared normalized event handler.
- Preserved duplicate terminal event protection through `completionHandledRef`.
- Preserved the legacy send path for Stage 8; `sendPrompt` still invokes `spawn_code_agent`.
- Added a runtime `agentBackend` state initialized from `DEFAULT_CODING_AGENT_BACKEND`; no visible selector was added, so no styling file was needed.
- Did not update `web-app/src/stores/coding-agent-store.ts` because Stage 8 did not require persisted backend selection.
- Completed Stage 9 direct Ollama command routing behind the backend flag.
- Updated `web-app/src/containers/CodingAgentPanel/index.tsx`.
- Added a `stopSelectedBackend` helper that invokes `stop_ollama_agent` when `agentBackend` is `direct-ollama` and preserves `stop_code_agent` for `legacy-claude`.
- Updated `sendPrompt` so `legacy-claude` still invokes `spawn_code_agent` with the existing `ollamaModel` and `permissionMode` arguments.
- Updated `sendPrompt` so `direct-ollama` invokes `start_ollama_agent` with `projectDir`, `prompt`, `model`, and `ollamaBaseUrl`.
- Updated the main stop button and loop stop button to use the selected backend stop helper instead of calling `stop_code_agent` directly.
- Kept `DEFAULT_CODING_AGENT_BACKEND` as `legacy-claude`.
- Did not add a visible backend selector in Stage 9.
- Did not add or update style files because Stage 9 added no styling.
- Completed Stage 10 direct Ollama core-flow verification and fixes.
- Updated `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`.
- Added `CODING_AGENT_BACKEND_STORAGE_KEY`, backend validation, and `getInitialCodingAgentBackend()`.
- Kept `DEFAULT_CODING_AGENT_BACKEND` as `legacy-claude`, while allowing a developer verification override through `VITE_CODING_AGENT_BACKEND=direct-ollama` or `localStorage["coding-agent-backend"] = "direct-ollama"`.
- Updated `web-app/src/containers/CodingAgentPanel/index.tsx` to initialize `agentBackend` through the adapter helper.
- Improved direct cancellation display by turning failed `agent-done` events with no error into `Agent stopped by user`.
- Updated `src-tauri/src/core/ollama_agent.rs`.
- Added direct-agent safeguards: 10 minute stream idle timeout, 45 minute maximum wall-clock runtime, and explicit cleanup of pending diff approval senders at terminal state.
- Added a non-stream fallback for Ollama turns where streaming times out or stalls. The backend still tries streaming first; on timeout it retries the same turn with `stream: false`, emits any returned text as one `agent-text-delta`, and preserves tool-call execution.
- Implemented the previously advertised `find_and_analyze_code` direct tool using bounded `rg --files` filename analysis, so the model no longer gets `Unknown tool: find_and_analyze_code` for a tool present in the schema.
- Confirmed by inspection that direct text deltas, tool starts/results, diff proposals, errors, and done events map through the normalized UI handler.
- Confirmed by inspection that `agent-diff-proposed` maps `call_id` to `PendingDiff.id` and `path` to `PendingDiff.filePath`, and approve/reject still call `approve_agent_diff` / `reject_agent_diff` with the direct call id.
- Confirmed by inspection that duplicate done protection remains centralized in `completionHandledRef`.
- Confirmed by inspection that cancellation, idle timeout, max runtime timeout, HTTP timeout, max iterations, and tool/self-healing failures all reach `agent-done`, clear backend running state, and clear frontend `isRunning`.
- Did not switch the default backend to `direct-ollama` in Stage 10.
- Did not add or update style files because Stage 10 added no styling.
- Completed Stage 11 direct Ollama default switch and loop policy verification.
- Updated `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`.
- Changed `DEFAULT_CODING_AGENT_BACKEND` from `legacy-claude` to `direct-ollama`.
- Kept the legacy fallback available through `VITE_CODING_AGENT_BACKEND=legacy-claude` or `localStorage["coding-agent-backend"] = "legacy-claude"`.
- Re-read the visible panel loop scheduler and confirmed the next run is scheduled only after a successful terminal event moves `agentStatus` to `free`.
- Confirmed by inspection that each scheduled loop run increments the counter before calling `sendPrompt(loopPrompt)`.
- Confirmed by inspection that failed direct terminal states leave `agentStatus` as `failed`, clear loop timers/countdown, disable loop mode, and do not schedule another run.
- Started the Tauri dev app with `VITE_CODING_AGENT_BACKEND=direct-ollama yarn dev:tauri` for live Stage 11 verification.
- Confirmed the dev Tauri backend process was running as `target/debug/Atomic-Chat`.
- Confirmed from the dev app log that the app reached the visible frontend, loaded coding agent config, checked Ollama, and listed installed Ollama models.
- Could not complete a GUI-driven short loop because Computer Use timed out against the `Atomic Chat` app and the Tauri WebView exposed only a generic group through macOS accessibility.
- Stopped the `yarn dev:tauri` and Vite dev processes that were started for Stage 11 verification.
- Restored the generated `src-tauri/icons/icon.png` artifact that `yarn dev:tauri` rewrote, because the icon was unrelated to Stage 11.
- Did not add or update style files because Stage 11 changed no styling.
- Completed Stage 12 standalone plan, QA checklist, and final handoff docs.
- Added `docs/ollama-coder-standalone-plan.md` with:
- standalone extraction target path and package identity recommendation.
- minimum backend/frontend/config modules to carry into standalone.
- explicit list of Claude assumptions to keep in Atomic Chat and exclude from standalone baseline.
- final direct-Ollama QA checklist with completed and pending items.
- rollback/fallback instructions and post-migration handoff steps.
- Re-ran repository search for Claude/legacy-coder assumptions to ground Stage 12 cleanup scope and separation boundaries.
- Kept legacy fallback intact per migration policy; did not remove `spawn_code_agent` path in Stage 12.

## Changed Files

- `docs/ollama-coder-migration-progress.md`
- `docs/ollama-coder-standalone-plan.md`
- `src-tauri/src/core/code_agent.rs`
- `src-tauri/src/core/ollama_agent.rs`
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`

## Verification

- Documentation files were created only.
- Stage 1 inspected relevant UI, store, legacy backend, direct Ollama backend, MCP bridge, and command registration files.
- Branch creation was verified with `git status --short --branch`.
- Stage 2 used read-only process inspection and log reads only.
- Stage 2 did not stop or kill any running user process.
- Stage 2 did not change application code.
- Stage 3 was approved by the user before code edits.
- Stage 4 was approved by the user before code edits.
- Ran `rustfmt --edition 2021 src-tauri/src/core/code_agent.rs`.
- Ran `cargo check --manifest-path src-tauri/Cargo.toml`; it completed successfully.
- `cargo check` reported existing dead-code warnings in `tauri-plugin-vector-db` and `tauri-plugin-llamacpp`, but no errors.
- `git status --short` after cleanup showed only `docs/ollama-coder-migration-progress.md` and `src-tauri/src/core/code_agent.rs` modified.
- Stage 5 was approved by the user before code edits.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully.
- Ran `yarn workspace @janhq/web-app lint`; it still fails only on pre-existing unrelated errors in `web-app/src/containers/CodeModePanel.tsx` and `web-app/src/containers/DownloadButton.tsx`, plus existing warnings. No `CodingAgentPanel` lint errors remain after the Stage 5 fix.
- Stage 6 was approved by the user before the progress-file update.
- Ran `cargo check --manifest-path src-tauri/Cargo.toml`; it completed successfully with the same existing dead-code warnings in `tauri-plugin-vector-db` and `tauri-plugin-llamacpp`.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully.
- Stage 6 process inspection was read-only. The initial broad `ps` command was blocked by sandboxing; reran read-only process inspection with escalation and then used filtered `pgrep`.
- Stage 6 log inspection was read-only against `/Users/zvisegal/Library/Application Support/Atomic Chat/data/logs/app.log` and `/Users/zvisegal/Library/Application Support/ollama-coder/data/logs/app.log`.
- Stage 7 was approved by the user before the progress-file update.
- Stage 7 was documentation and contract mapping only; no application code was changed.
- Stage 7 used read-only inspection of `src-tauri/src/core/ollama_agent.rs`, `src-tauri/src/core/mcp/agent_bridge.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/core/planner_config.rs`, `src-tauri/resources/planner-config.toml`, `web-app/src/containers/CodingAgentPanel/index.tsx`, and `web-app/src/stores/coding-agent-store.ts`.
- Stage 7 did not run the app, start a direct Ollama request, stop any process, or modify any source code.
- Stage 8 was approved by the user before code edits.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully.
- Ran `yarn workspace @janhq/web-app lint`; it still fails only on pre-existing unrelated errors in `web-app/src/containers/CodeModePanel.tsx` and `web-app/src/containers/DownloadButton.tsx`, plus existing warnings. No `CodingAgentPanel` or `agent-event-adapter.ts` lint errors were reported.
- Stage 9 was approved by the user before code edits.
- Confirmed with `rg` that the Coding Agent panel now references `spawn_code_agent` and `stop_code_agent` only through the selected-backend routing logic.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully.
- Ran `yarn workspace @janhq/web-app lint`; it still fails only on pre-existing unrelated errors in `web-app/src/containers/CodeModePanel.tsx` and `web-app/src/containers/DownloadButton.tsx`, plus existing warnings. No `CodingAgentPanel` or `agent-event-adapter.ts` lint errors were reported.
- Stage 10 was approved by the user before code edits.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully.
- Ran `cargo check --manifest-path src-tauri/Cargo.toml`; it completed successfully with the same existing dead-code warnings in `tauri-plugin-vector-db` and `tauri-plugin-llamacpp`.
- Ran `cargo test --manifest-path src-tauri/Cargo.toml core::mcp::agent_bridge::tests::tool_schemas_has_all_tools`; it passed.
- Ran `yarn workspace @janhq/web-app lint`; it still fails only on pre-existing unrelated errors in `web-app/src/containers/CodeModePanel.tsx` and `web-app/src/containers/DownloadButton.tsx`, plus existing warnings. No `CodingAgentPanel` or `agent-event-adapter.ts` lint errors were reported.
- Checked Ollama locally with `curl -sS http://127.0.0.1:11434/api/tags`; Ollama was reachable on `127.0.0.1:11434` and had `qwen3-coder:30b` installed.
- Confirmed a minimal non-stream OpenAI-compatible request to Ollama returned `direct-ollama-ok` with `qwen2.5-coder:7b`.
- Confirmed an SSE streaming text request to Ollama returned `data:` chunks with `stream-ok`.
- Confirmed a non-stream tool-call request to `qwen3-coder:30b` returned a valid OpenAI-compatible `tool_calls` array for `list_dir`.
- Found that the equivalent streaming tool-call request to `qwen3-coder:30b` returned no chunks for 180 seconds and timed out, which motivated the Stage 10 non-stream fallback.
- Did not stop or kill any user process.
- Did not complete a full GUI-driven Tauri direct-agent run in Stage 10; the core HTTP/tool-call behavior and UI/backend contracts were verified by local requests, code inspection, and build checks.
- Stage 11 was approved by the user before code edits.
- Re-read `web-app/src/containers/CodingAgentPanel/index.tsx` and confirmed the selected backend routes `direct-ollama` sends to `start_ollama_agent` and `legacy-claude` sends to `spawn_code_agent`.
- Re-read `web-app/src/containers/CodingAgentPanel/index.tsx` and confirmed the loop scheduler waits for `agentStatus === 'free'`, which is set only after successful terminal completion and Ollama restart cleanup.
- Re-read `web-app/src/containers/CodingAgentPanel/index.tsx` and confirmed failed runs stop the loop conservatively by clearing timers/countdown, disabling loop mode, and leaving `agentStatus` as `failed`.
- Ran `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`; it completed successfully after the Stage 11 default switch.
- Ran `cargo check --manifest-path src-tauri/Cargo.toml`; it completed successfully with the same existing dead-code warnings in `tauri-plugin-vector-db` and `tauri-plugin-llamacpp`.
- Checked Ollama locally with `curl -sS http://127.0.0.1:11434/api/tags` outside the sandbox; Ollama was reachable and had `qwen3-coder:30b` and `qwen2.5-coder:7b` installed.
- Started `VITE_CODING_AGENT_BACKEND=direct-ollama yarn dev:tauri`; the Tauri dev build completed and launched `target/debug/Atomic-Chat`.
- Read `/Users/zvisegal/Library/Application Support/Atomic Chat/data/logs/app.log` and confirmed the dev app checked Ollama and listed installed models.
- Attempted to inspect the live Tauri app with Computer Use; it timed out with Apple event error `-10005`.
- Queried macOS accessibility with `System Events`; the `Atomic-Chat` process was frontmost and had an `Atomic Chat` window, but the WebView exposed only a generic group and window buttons, so the Code Agent controls were not operable through automation.
- Confirmed with `ps` that the dev processes started for Stage 11 were stopped after verification.
- Confirmed with `git status --short --branch` that no unrelated generated icon change remained after cleanup.
- Stage 12 was approved by the user before documentation edits.
- Stage 12 changed documentation only; no runtime source code paths were modified.
- Ran `rg -n "claude|spawn_code_agent|legacy-claude|direct-ollama|start_ollama_agent|code-agent"` for repo-wide assumption mapping and standalone scoping.

## Risks

- The legacy `ollama launch claude` path may still be running in the currently open app session.
- Do not stop or kill user processes unless explicitly approved.
- Stage 1 found an event-name mismatch between direct Ollama backend events (`agent-*`) and the event names previously consumed by the UI for the non-legacy path (`coding-agent-*`). Stage 8 added frontend adapter listeners for both event families.
- Stage 2 evidence is partial because the retained logs are short and current process inspection did not catch an active stuck `ollama launch claude` process.
- Runtime observability is weak: retained logs can show `CodeAgent` stdout without a nearby durable terminal-state record.
- The orphaned `claude` process may be unrelated to Atomic Chat or ollama-coder, so it is supporting process evidence only, not definitive proof of the stuck run.
- Timeout values are fixed constants for now, not user-configurable settings.
- Stage 6 verified the legacy terminal-state code paths by inspection and build/type checks, but did not run a live stalled `ollama launch claude` process through the 10-minute idle timeout or 45-minute max runtime.
- Stage 6 did not verify a normal successful legacy run in the live app because no legacy run was active and starting one could invoke the old Claude-backed path against user work.
- If the backend emits a failed `code-agent-done` without a preceding `code-agent-error`, the UI still has only a generic stopped/failure reason available.
- Direct Ollama events are now consumed by the visible Code Agent UI adapter, and Stage 9 connected direct send/stop commands behind the backend flag.
- The backend selection flag now defaults to `direct-ollama`, but Stage 11 kept a developer override back to `legacy-claude` through `VITE_CODING_AGENT_BACKEND` or `localStorage`.
- Direct Ollama cancellation currently produces `agent-done` with `success: false` and no error string; the UI now renders that as `Agent stopped by user`.
- Direct Ollama now has idle and max-wall-runtime safeguards, but the configured values are fixed constants rather than user-configurable settings.
- Direct Ollama streaming tool calls with `qwen3-coder:30b` timed out in local testing; Stage 10 added non-stream fallback for this case, but a full GUI-driven direct loop run remains unverified because Stage 11 automation could not operate the Tauri WebView.
- The direct backend now implements `find_and_analyze_code`, but the implementation is intentionally conservative filename analysis and may need richer symbol/content analysis later.
- Direct tool-start events do not include tool arguments, so the existing UI tool input display would be empty unless the adapter/backend is expanded later.
- The Code Agent panel's project tree invokes `list_dir_shallow`, but Stage 7 did not confirm a registered backend command for it; this may be an unrelated existing issue.
- The backend selection flag is still not persisted through the app store. Stage 11 made direct Ollama the default and kept the code-only override for fallback.
- Full GUI-driven direct loop verification remains pending due to desktop accessibility automation limitations observed on 2026-05-13; this is now explicitly tracked as final manual QA follow-up.

## Open Decisions

- The loop now stops by default after a failed run; continuing after failure would require an explicit future setting.
- Exact standalone `ollama-coder` target directory remains undecided.
- Stage 8 kept the backend selection flag component-local with default `legacy-claude`.
- Stage 8 chose frontend-side event adaptation and listens directly to both `agent-*` and compatibility `coding-agent-*` events.
- Stage 9 kept the backend flag code-only and did not expose a temporary developer-visible backend selector.
- Stage 10 added a developer-only backend override path instead of a visible selector.
- Stage 11 made `direct-ollama` the default while preserving the developer-only override path for `legacy-claude`.
- Keep legacy fallback until one successful manual GUI direct-loop run is recorded in desktop app.
- After that run, decide one of:
- remove legacy Claude-backed path from Atomic Chat codebase, or
- keep it dormant behind override for one additional release cycle.
