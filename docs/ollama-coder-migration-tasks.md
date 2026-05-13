# Ollama Coder Migration - Development Tasks

## Goal

Turn the current Code Agent into a reliable local-first Ollama coder that does not depend on `ollama launch claude` or Claude Code for the main coding loop.

The migration must be safe, staged, reversible, and suitable for continuation across separate Codex conversations.

## Fixed Decisions

- Codex in this chat performs the work. Do not delegate implementation to `ollama-coder`, Claude Code, or another local agent.
- Keep changes small and reviewable.
- Before changing any file in each stage, explain the exact files and purpose, then wait for explicit user approval.
- Design/styling code must stay in separate style files.
- Preserve user changes. Never revert unrelated edits.
- First stabilize the existing app so loops cannot hang forever.
- Then migrate the UI from the legacy Claude-backed path to the direct Ollama/MCP/tool-loop path.
- Keep the legacy Claude-backed path temporarily behind a flag only until the new path is verified.
- Long-term target: a standalone `ollama-coder` app independent of Atomic Chat.

## Continuation Prompt

Use this prompt at the start of each new conversation:

```text
Continuation Task: Ollama Coder Migration

Tasks file:
`/Users/zvisegal/devlope/Atomic-Chat-coder-tym/docs/ollama-coder-migration-tasks.md`

Progress file:
`/Users/zvisegal/devlope/Atomic-Chat-coder-tym/docs/ollama-coder-migration-progress.md`

Instructions:
- Read both files first.
- Execute only the next stage marked as PENDING in the progress file.
- Before changing any file: explain exactly which files you will change and why.
- Do not change code without my explicit approval.
- Design/styling code must always be in a separate file.
- Preserve existing user changes.
- After execution: update the progress file with completed work, changed files, verification, risks, and the next stage.
- You are Codex in this chat. Do not delegate this work to ollama-coder or another local agent.
```

## Code Areas

### Current UI

- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Main visible Code Agent panel.
  - Current send path invokes `spawn_code_agent`.
  - Current loop scheduler advances only after `agentStatus` becomes `free`.
  - Current completion handling depends on `code-agent-done` or stream `type: "result"`.

- `web-app/src/stores/coding-agent-store.ts`
  - Runtime and persisted state for project, sessions, logs, pending diffs, and running status.

### Legacy Claude-Backed Backend

- `src-tauri/src/core/code_agent.rs`
  - Implements `spawn_code_agent`.
  - Currently runs `ollama launch claude --model ... -- -p --output-format stream-json --verbose`.
  - Emits `code-agent-output` and `code-agent-done`.
  - Has stop handling, but no idle watchdog or max runtime for normal runs.

### Direct Ollama Agent Backend

- `src-tauri/src/core/ollama_agent.rs`
  - Local Ollama-driven agent loop.
  - Has tool execution, diff approval concepts, context pruning, max iterations, and cancellation.
  - Needs contract review and UI connection before it can replace the legacy path.

- `src-tauri/src/core/mcp/agent_bridge.rs`
  - MCP/tool bridge and schemas used by the local agent path.

### Command Registration

- `src-tauri/src/lib.rs`
  - Registers both legacy and newer commands.
  - Must remain consistent with frontend invoke names.

### Configuration

- `src-tauri/src/core/planner_config.rs`
- `src-tauri/resources/planner-config.toml`
  - Contains coding agent configuration such as model and iteration defaults.

## Known Problem From Investigation

The app can remain stuck on a loop run such as `running 2/24` because the legacy process remains alive:

```text
/usr/local/bin/ollama launch claude --model qwen3-coder:30b ...
```

The backend waits for stdout EOF before emitting `code-agent-done`. If the child process stalls without output and without exiting, the UI never receives completion, `agentStatus` never becomes `free`, and the loop never schedules the next run.

## Migration Principles

- Stabilize before replacing.
- Prefer explicit state transitions over inferred state from process EOF.
- Every run must finish in one of these states:
  - success
  - model/tool error
  - idle timeout
  - max runtime timeout
  - user stopped
- The loop scheduler must have a policy for each terminal state.
- The new Ollama path must provide the same user-visible capabilities before disabling the legacy path:
  - text streaming
  - tool start/result log
  - diff proposal display
  - approve/reject
  - done/error handling
  - loop continuation

## Development Stages

### Stage 1 - Baseline And Safety Branch

Scope:
- Read this tasks file and the progress file.
- Inspect current relevant files without changing anything.
- Confirm exact current command path from UI to backend.
- Confirm whether the running app still uses `spawn_code_agent`.
- Create or switch to a branch named `codex/ollama-agent-migration`.
- Do not change application code.
- Record current git status in the progress file.

### Stage 2 - Runtime Evidence For Stuck Loop

Scope:
- Read app logs and process evidence for the stuck-run failure mode.
- Do not stop running user processes unless explicitly approved.
- Record the observed failure mode and evidence in the progress file.

### Stage 3 - Legacy Watchdog And Max Runtime

Update:
- `src-tauri/src/core/code_agent.rs`
- Config files only if needed.

Scope:
- Propose exact backend changes first and wait for approval.
- Track last output time for stdout and stderr.
- If there is no output for a configured idle timeout, terminate the run.
- Add a maximum wall-clock runtime per legacy run.
- On timeout, terminate the process and emit a terminal event.
- Do not change the direct Ollama agent path yet.

### Stage 4 - Legacy Process Group Cleanup

Update:
- `src-tauri/src/core/code_agent.rs`

Scope:
- On Unix/macOS, spawn the legacy child in a new process group.
- Ensure `stop_code_agent` can terminate child processes such as `claude`.
- Preserve Windows behavior.

### Stage 5 - UI Stalled State And Loop Failure Policy

Update:
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/stores/coding-agent-store.ts` if persistence is needed.
- Separate style file only if new styling is needed.

Scope:
- Show a stalled/timeout message when backend reports idle timeout or max runtime.
- Define how the loop behaves after failure:
  - stop on failure by default, or
  - continue only if explicitly configured.
- Keep default conservative.

### Stage 6 - Verify Legacy Loop Cannot Hang Forever

Scope:
- Run focused verification if practical.
- Confirm a stalled legacy run reaches a terminal state.
- Update progress file only unless a fix is required and approved.

### Stage 7 - Map Direct Ollama And UI Contracts

Scope:
- Read `ollama_agent.rs` and related bridge files.
- Document commands, event names, payloads, and missing pieces.
- Read `CodingAgentPanel` and store code.
- Document what UI expects today.
- Identify exact adapter needs.
- No code changes except progress file.

### Stage 8 - Event Adapter And Backend Selection Flag

Create or update, after approval:
- A small frontend adapter file near the coding agent panel or store.
- Frontend config/store or backend config as appropriate.

Scope:
- Propose an adapter layer first and wait for approval.
- Normalize direct Ollama agent events and legacy events into a common shape.
- Add a backend selection flag:
  - `legacy-claude`
  - `direct-ollama`
- Default remains legacy until direct path is verified.

### Stage 9 - Connect UI To Direct Ollama Behind Flag

Update:
- `web-app/src/containers/CodingAgentPanel/index.tsx`

Scope:
- When flag is `direct-ollama`, invoke `start_ollama_agent`.
- Keep legacy path available.
- Do not remove `spawn_code_agent` yet.

### Stage 10 - Verify Direct Ollama Core Flow

Scope:
- Run or inspect a minimal direct Ollama agent request.
- Confirm text appears in the log.
- Confirm tool calls render in the UI log.
- Fix event mapping if approved.
- Confirm proposed writes/edits appear in the pending diff panel.
- Confirm no file write happens before approval.
- Confirm approve applies the intended change.
- Confirm reject returns an error to the agent and does not write.
- Confirm success, failure, cancellation, idle timeout, and max runtime all clear running state.
- Confirm no duplicate done messages.

### Stage 11 - Verify Direct Ollama Loop And Make Default

Scope:
- Run a short loop with direct Ollama.
- Confirm each run starts only after the previous terminal state.
- Confirm the counter advances correctly.
- Switch default from legacy Claude path to direct Ollama path.
- Keep legacy fallback still available.
- Hide or de-emphasize the legacy path.
- Keep code available for emergency fallback only.

### Stage 12 - Standalone Plan, QA Checklist, And Final Docs

Scope:
- Search for user-visible or logic-level Claude assumptions and document cleanup needs.
- Add focused tests where practical, after approval.
- Create or update a checklist for manual verification:
  - normal prompt
  - file read
  - file edit with approval
  - rejected edit
  - stalled model
  - loop run
  - stop button
- Identify which files are required for a standalone `ollama-coder` app.
- Identify Atomic Chat dependencies that should not be carried forward.
- Propose target directory, package name, Tauri app structure, and minimum dependencies.
- Decide whether to remove legacy Claude code from Atomic Chat or leave it dormant.
- Update docs with final architecture and operating instructions.
- Mark migration complete.
