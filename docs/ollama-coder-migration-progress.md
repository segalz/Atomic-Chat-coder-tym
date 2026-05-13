# Ollama Coder Migration - Progress

## Current Status

Migration planning files have been created. No application code has been changed.

## Stage Status

| Stage | Name | Status |
| --- | --- | --- |
| 1 | Baseline And Safety Branch | PENDING |
| 2 | Runtime Evidence For Stuck Loop | PENDING |
| 3 | Legacy Watchdog And Max Runtime | PENDING |
| 4 | Legacy Process Group Cleanup | PENDING |
| 5 | UI Stalled State And Loop Failure Policy | PENDING |
| 6 | Verify Legacy Loop Cannot Hang Forever | PENDING |
| 7 | Map Direct Ollama And UI Contracts | PENDING |
| 8 | Event Adapter And Backend Selection Flag | PENDING |
| 9 | Connect UI To Direct Ollama Behind Flag | PENDING |
| 10 | Verify Direct Ollama Core Flow | PENDING |
| 11 | Verify Direct Ollama Loop And Make Default | PENDING |
| 12 | Standalone Plan, QA Checklist, And Final Docs | PENDING |

## Next Stage

Stage 1 - Baseline And Safety Branch

## Next Stage Notes

Read-only first, then branch creation only. Before changing code in later stages, explain and get approval.

Files to inspect:
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/stores/coding-agent-store.ts`
- `src-tauri/src/core/code_agent.rs`
- `src-tauri/src/core/ollama_agent.rs`
- `src-tauri/src/core/mcp/agent_bridge.rs`
- `src-tauri/src/lib.rs`

Goal:
- Confirm the current UI still invokes `spawn_code_agent`.
- Confirm the legacy backend still launches `ollama launch claude`.
- Confirm what direct Ollama agent commands/events already exist.
- Create or switch to branch `codex/ollama-agent-migration`.
- Do not change application code in Stage 1.

## Completed Work

### 2026-05-13

- Created migration task tracking file.
- Created migration progress tracking file.
- Recorded a reusable continuation prompt for future conversations.
- Split the migration into small stages that can be executed one at a time.
- Revised the plan from 35 conservative stages to 12 larger conversation stages.

## Changed Files

- `docs/ollama-coder-migration-tasks.md`
- `docs/ollama-coder-migration-progress.md`

## Verification

- Documentation files were created only.
- No application code was changed.

## Risks

- The legacy `ollama launch claude` path may still be running in the currently open app session.
- Do not stop or kill user processes unless explicitly approved.

## Open Decisions

- Exact idle timeout and max runtime values are not decided yet.
- Whether the loop should stop or continue after a failed run remains undecided.
- Exact standalone `ollama-coder` target directory remains undecided.
