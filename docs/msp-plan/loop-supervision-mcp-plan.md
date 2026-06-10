# Loop Supervision MCP Plan

## Goal

Design and implement a lightweight supervision layer for Loop Mode so the local
coding loop remains the main worker, while a stronger cloud model can supervise,
audit, approve, pause, or investigate only when needed.

The key rule:

- Loop Mode stays local-first and cheap.
- Cloud supervision is an escalation path, not the primary worker.
- Loop Mode must not receive manual Code Mode conversation context.
- Loop Mode must not receive stored conversation summary context.
- Supervision must control loop state, not inject prompt history.

## Current Architecture Notes

- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Owns the Loop scheduler UI and timers.
  - Starts loop runs with `source: 'loop'`.
  - Sends loop prompts with `includeConversationContext: false` and
    `includeSummaryContext: false`.
  - Listens to direct Ollama and legacy code-agent events and writes them into
    the coding-agent store.

- `web-app/src/containers/CodingAgentPanel/conversation-context.ts`
  - Builds prompt context for manual Code Mode.
  - Already returns the raw current prompt when both history and summary context
    are disabled.
  - Rejects loop sessions as context sources.

- `web-app/src/stores/coding-agent-store.ts`
  - Persists sessions, execution logs, pending diffs, and session source
    (`manual` or `loop`).
  - Good frontend source for visible progress, but not enough by itself for
    authoritative supervision state.

- `src-tauri/src/core/ollama_agent.rs`
  - Runs the direct local Ollama coding loop.
  - Tracks running/cancel state with `OllamaAgentState`.
  - Emits tool, diff, text, error, and done events.
  - Applies file edits through `write_file` and `edit_file`.

- `src-tauri/src/core/mcp/commands.rs`
  - Existing MCP server lifecycle commands.

- `src-tauri/src/core/mcp/helpers.rs`
  - Existing MCP server startup, monitoring, restart, and cleanup logic.

- `src-tauri/src/core/mcp/agent_bridge.rs`
  - Exposes local worker tools to the Ollama agent.
  - Supervision tools should not be added here, because these are tools for the
    local worker model, not for the cloud supervisor.

## Important Existing Gap

`src-tauri/src/core/ollama_agent.rs` currently resolves absolute file paths as
provided. A future guardrail stage must canonicalize file paths and reject edits
outside the selected project root before relying on supervision checks.

## Uniform Prompt For Every Stage

The short reusable prompt is stored separately:

- `docs/msp-plan/loop-supervision-mcp-prompt.md`

The implementation conversation must follow all rules in this file, including:

- Use CodeHelper MCP first if available and suitable.
- Keep Loop Mode isolated from manual Code Mode context.
- Do not inject conversation context into Loop Mode.
- Do not inject summary context into Loop Mode.
- Keep changes scoped to the current stage.
- Do not implement future stages early.
- If adding UI/design code, keep design code in a separate file.
- Preserve existing working behavior and avoid regressions.
- If the next TODO stage is unclear, stop and ask before editing.

## Proposed MCP API Shape

Read-only tools:

- `loop_status`
- `read_loop_progress`
- `get_loop_diff`
- `run_loop_audit`
- `get_last_loop_errors`

Control tools:

- `pause_loop`
- `resume_loop`
- `stop_loop`
- `approve_next_stage`
- `set_loop_limits`
- `request_supervisor_review`

Suggested compact response shape:

```json
{
  "run_id": "uuid",
  "status": "idle|running|paused|waiting_approval|failed|complete|stopped",
  "project_dir": "/absolute/project/path",
  "source": "loop",
  "current_run": 1,
  "max_runs": 3,
  "last_step": "tool_result",
  "risk_flags": ["diff_too_large"],
  "next_action": "none|audit|pause|approve|stop"
}
```

## Safety Boundaries

- The cloud supervisor must not write files directly.
- The cloud supervisor must not modify the loop prompt.
- The cloud supervisor must not inject manual Code Mode history.
- The cloud supervisor must not inject stored conversation summaries.
- Control operations change loop state only: pause, resume, stop, set limits,
  approve a gate, or request review.
- Read APIs must cap returned logs and diffs by byte count.
- File paths must be canonicalized and checked against the selected project root.
- Diff and progress reports should be compact by default, with opt-in detail.

## Token-Saving Strategy

- Keep local loop progress as structured events instead of raw transcript dumps.
- Return summaries by default and tail logs only when requested.
- Cap `get_loop_diff` by bytes and changed-path count.
- Prefer changed-path lists, error signatures, and audit flags over full text.
- Escalate with a compact evidence bundle:
  - status
  - last errors
  - changed paths
  - diff stats
  - latest build/test result
  - triggered guardrails

## What Stays Local

- Coding work.
- File reads, searches, edits, and local tool use.
- Ordinary retry/self-healing.
- Build/test execution.
- Loop scheduling.
- Compact progress collection.

## What Escalates To Cloud

- Build/test failure after local retry.
- Same step or same error signature fails twice.
- Progress file or status claim contradicts filesystem/git state.
- Attempted file edit outside allowed scope.
- Diff is too large.
- Route/navigation files change.
- New legacy navigation patterns appear.
- Before commit.
- Every N loop runs when audit interval is configured.

## Stage 1: Local Loop Supervision State

Status: DONE (2026-05-31)

Add an authoritative local supervision state for Loop Mode. Do not expose MCP
tools yet.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `src-tauri/src/core/mod.rs`
- `src-tauri/src/core/state.rs`
- `src-tauri/src/core/ollama_agent.rs`
- `web-app/src/containers/CodingAgentPanel/index.tsx`

Implementation notes:

- Add a small Rust-side state model:
  - `run_id`
  - `project_dir`
  - `status`
  - `started_at`
  - `updated_at`
  - `current_run`
  - `max_runs`
  - `last_step`
  - `last_errors`
  - `changed_paths`
  - `risk_flags`
  - `pause_requested`
  - `stop_requested`
  - `limits`
- Update state from existing agent events and direct loop transitions.
- Keep the frontend store behavior unchanged except for reporting loop lifecycle
  facts into the supervision state.
- Do not change prompt construction.
- Do not add cloud calls.
- Do not add MCP tools.

Verification:

- `cargo check --lib` from `src-tauri`.
- Focused frontend test or typecheck if TypeScript state calls are changed.
- Manual source check that loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`
- Confirm manual Code Mode context behavior is untouched.

Changed files:

- `src-tauri/src/core/loop_supervision.rs`
  - Added internal Rust supervision snapshot state with run metadata, status,
    timestamps, step/error/path tracking, pause/stop flags, and limits.
- `src-tauri/src/core/mod.rs`
  - Registered the new `loop_supervision` module for desktop builds.
- `src-tauri/src/lib.rs`
  - Managed `LoopSupervisionState` in the desktop Tauri app state.
- `src-tauri/src/core/ollama_agent.rs`
  - Wired direct Ollama Loop runs into supervision lifecycle tracking.
  - Recorded iteration, tool, file-change, error, completion, and stop-request
    facts for Loop runs only.
  - Preserved the existing configurable max-iteration work.
- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Passed Loop run metadata (`source`, `currentRun`, `maxRuns`, and
    `maxIterations`) to `start_ollama_agent`.
  - Kept prompt construction and Loop context flags unchanged.

Verification performed:

- `cargo fmt -- src/core/loop_supervision.rs src/core/mod.rs src/core/ollama_agent.rs src/lib.rs`
- `cargo check --lib` from `src-tauri` passed.
- `yarn workspace @janhq/web-app build` passed.
- `git diff --check` passed.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`
- Manual source check found no `loop_status`, `read_loop_progress`,
  `get_loop_diff`, or `get_last_loop_errors` command surface added in Stage 1.

Remaining risks:

- Supervision state is internal only until Stage 2 exposes read-only commands,
  so it is not manually inspectable from the UI yet.
- Stage 1 tracks direct Ollama Loop runs; legacy Code Agent Loop runs are not
  authoritative in this new state.
- Path canonicalization and project-root edit rejection remain future Stage 3
  guardrail work.

## Stage 2: Read-Only Tauri Supervision Commands

Status: DONE (2026-05-31)

Expose read-only local commands before MCP transport.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/core/ollama_agent.rs`

Commands:

- `loop_status`
- `read_loop_progress`
- `get_loop_diff`
- `get_last_loop_errors`
- `run_loop_audit`

Implementation notes:

- Return compact structured data.
- Cap progress and diff output.
- Avoid reading unrelated files.
- Do not add control operations yet.

Verification:

- `cargo check --lib` from `src-tauri`.
- Unit tests for command serialization and output caps.
- Manual Tauri command invocation if practical.
- Confirm no command can mutate loop state.

Changed files:

- `src-tauri/src/core/loop_supervision.rs`
  - Added read-only Tauri commands for `loop_status`,
    `read_loop_progress`, `get_loop_diff`, `get_last_loop_errors`, and
    `run_loop_audit`.
  - Added compact response structs, capped progress/error/diff output, and
    read-only helper methods over the existing supervision snapshot.
  - Added unit tests for command response serialization, output caps, and
    read-only audit behavior.
- `src-tauri/src/core/ollama_agent.rs`
  - Recorded compact Loop-only diff metadata for successful `write_file` and
    `edit_file` tool applications so `get_loop_diff` can report changed paths
    and capped previews without reading unrelated files.
- `src-tauri/src/lib.rs`
  - Registered the five read-only Loop supervision commands in the desktop
    Tauri invoke handler, matching the desktop-managed supervision state.

Verification performed:

- `cargo fmt -- src/core/loop_supervision.rs src/core/ollama_agent.rs src/lib.rs`
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `git diff --check` passed.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`
- Confirmed the new command wrappers only read from `LoopSupervisionState` and
  do not mutate loop state.

Remaining risks:

- Manual Tauri invocation was not performed in this stage; coverage is from
  command registration, helper tests, and `cargo check --lib`.
- `get_loop_diff` reports compact metadata captured during successful Loop file
  edits; it does not compute a fresh git diff.
- The read-only audit command intentionally remains shallow until Stage 3 adds
  deterministic guardrail and audit rules.
- Path canonicalization and project-root edit rejection remain future Stage 3
  guardrail work.

## Stage 3: Guardrails And Audit Rules

Status: DONE (2026-05-31)

Add deterministic local audit checks.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `src-tauri/src/core/ollama_agent.rs`

Checks:

- Canonical path is inside project root.
- Same error signature occurs twice.
- Diff exceeds configured byte or file-count limit.
- Changed paths include route/navigation files.
- Legacy navigation patterns appear in changed files.
- Build/test failed.
- Progress/status claims contradict git diff or filesystem.

Implementation notes:

- Start with deterministic checks.
- Do not call a cloud model in this stage.
- Treat audit output as flags and recommendations, not automatic edits.

Verification:

- `cargo check --lib` from `src-tauri`.
- Unit tests for path-scope rejection.
- Unit tests for repeated-error signature detection.
- Unit tests for diff-size thresholds.
- Fixture tests for route/navigation path detection.

Changed files:

- `src-tauri/src/core/loop_supervision.rs`
  - Added deterministic audit flags for repeated error signatures, diff byte
    limits, changed-path count limits, route/navigation path changes, legacy
    navigation patterns, failed build/test commands, missing changed paths, and
    rejected out-of-project edit paths.
  - Extended supervision limits with diff byte and changed-path thresholds.
  - Added compact build/test failure tracking and path-rejection tracking.
  - Added focused unit tests for the new audit rules and command detection.
- `src-tauri/src/core/ollama_agent.rs`
  - Added project-root edit path enforcement for `write_file` and `edit_file`.
  - Canonicalizes the selected project root and the existing target path prefix
    before allowing file writes.
  - Records rejected edit paths into Loop supervision state for Loop runs.
  - Records failed build/test-like `run_shell` commands into Loop supervision
    audit state without changing shell tool output behavior.
  - Added focused unit tests for relative inside-project paths, parent escapes,
    and absolute outside-project paths.

Verification performed:

- `cargo fmt -- src/core/loop_supervision.rs src/core/ollama_agent.rs`
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo test resolve_project_edit_path --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `git diff --check` passed.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`

Remaining risks:

- Manual Tauri command invocation was not performed in this stage; verification
  is from Rust unit tests and `cargo check --lib`.
- Filesystem contradiction checking is intentionally lightweight: audit flags
  changed paths that no longer exist, but does not compute a fresh git diff.
- Build/test failure detection is based on deterministic command-name matching
  for failed `run_shell` commands; it does not parse every possible custom
  project script name.
- Control commands, MCP transport, and cloud escalation remain future stages.

## Stage 4: Control Commands

Status: DONE (2026-05-31)

Add local control commands after read-only state is reliable.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `src-tauri/src/core/ollama_agent.rs`
- `src-tauri/src/lib.rs`
- `web-app/src/containers/CodingAgentPanel/index.tsx`

Commands:

- `pause_loop`
- `resume_loop`
- `stop_loop`
- `approve_next_stage`
- `set_loop_limits`

Implementation notes:

- `pause_loop` should support:
  - `after_current_run`
  - `immediate`
- `resume_loop` resumes scheduling only, not prompt history.
- `stop_loop` should cancel the active local worker and prevent further loop
  scheduling.
- `approve_next_stage` only releases a local gate.
- `set_loop_limits` updates limits, not prompts.

Verification:

- `cargo check --lib` from `src-tauri`.
- Frontend build or focused tests if scheduler code changes.
- Manual check that pause prevents the next scheduled loop run.
- Manual check that resume does not inject context.
- Manual check that stop cancels active work and clears future scheduling.

Changed files:

- `src-tauri/src/core/loop_supervision.rs`
  - Added local control response/state APIs for `pause_loop`,
    `resume_loop`, `approve_next_stage`, and `set_loop_limits`.
  - Added pause modes for `after_current_run` and `immediate`.
  - Added stop/pause fields to status responses so the frontend scheduler can
    react to external control state.
  - Added unit tests for pause-after-current-run, immediate pause/resume, stop
    state, and limit updates.
- `src-tauri/src/core/ollama_agent.rs`
  - Added `stop_loop`, which marks Loop supervision as stopped, cancels any
    active direct Ollama worker, and rejects pending edit/diff approvals.
  - Reused the same cancellation helper for `stop_ollama_agent` to preserve
    existing manual stop behavior.
- `src-tauri/src/lib.rs`
  - Registered the Stage 4 control commands in the desktop Tauri invoke
    handler.
- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Added best-effort polling of `loop_status` while Loop or the agent is
    active.
  - Added local scheduler pause handling so pause clears pending timers without
    dropping the stored Loop prompt.
  - Routed Loop stop/cancel actions through `stop_loop`.
  - Preserved Loop prompt isolation: scheduled Loop sends still use
    `source: 'loop'`, `includeConversationContext: false`, and
    `includeSummaryContext: false`.

Verification performed:

- `cargo fmt -- src/core/loop_supervision.rs src/core/ollama_agent.rs src/lib.rs`
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo test resolve_project_edit_path --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `yarn workspace @janhq/web-app build` passed.
- `git diff --check` passed.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`

Remaining risks:

- Manual Tauri command invocation was not performed in this stage; control
  command verification is from Rust unit tests, command registration, frontend
  build, and source inspection.
- Frontend control polling is best-effort and local to the mounted
  `CodingAgentPanel`; Stage 5 MCP transport can call the same commands, but no
  MCP supervision surface exists yet.
- `pause_loop` does not suspend an in-flight model stream mid-token; it clears
  future scheduling immediately and, for `after_current_run`, leaves the active
  worker to finish.
- `approve_next_stage` releases a local waiting-approval state only; no staged
  gate producer exists yet.

## Stage 5: MCP Supervision Surface

Status: DONE (2026-05-31)

Expose the supervision API through MCP for a cloud supervisor.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `src-tauri/src/core/mcp/commands.rs`
- `src-tauri/src/core/mcp/helpers.rs`
- possibly a new `src-tauri/src/core/mcp/loop_supervision_server.rs`

Implementation notes:

- Keep supervisor MCP tools separate from `agent_bridge.rs`.
- The local Ollama worker must not see supervisor tools.
- MCP tools should call the same internal functions as Tauri commands.
- Use compact schemas and response caps.
- Control tools must use the same safety checks as local commands.

Verification:

- `cargo check --lib` from `src-tauri`.
- MCP tool list includes supervision tools only on the supervisor surface.
- Local worker tool schema does not include supervision tools.
- Tool-call timeout and cancellation behavior are tested.

Changed files:

- `src-tauri/src/core/mcp/loop_supervision_server.rs`
  - Added a dedicated Loop Supervision MCP-shaped tool surface separate from
    `agent_bridge.rs`.
  - Exposed supervisor-only tools for `loop_status`, `read_loop_progress`,
    `get_loop_diff`, `get_last_loop_errors`, `run_loop_audit`, `pause_loop`,
    `resume_loop`, `stop_loop`, `approve_next_stage`, and `set_loop_limits`.
  - Routed tool calls to the existing `LoopSupervisionState` read/control APIs
    with compact structured `CallToolResult` responses.
  - Added tests that the supervisor surface excludes local worker tools,
    returns structured results, validates arguments, and rejects unknown tools.
- `src-tauri/src/core/mcp/mod.rs`
  - Registered the new `loop_supervision_server` module.
- `src-tauri/src/core/mcp/commands.rs`
  - Added Tauri command wrappers for listing and calling the supervisor MCP
    tool surface without adding those tools to the existing worker-facing MCP
    server list.
  - Reused existing MCP tool timeout settings and cancellation-token storage for
    supervisor tool calls.
  - Added focused tests for supervisor tool timeout, cancellation, and success
    behavior.
- `src-tauri/src/lib.rs`
  - Registered the supervisor MCP list/call commands in the Tauri invoke
    handler.

Verification performed:

- `cargo fmt -- src/core/mcp/commands.rs src/core/mcp/loop_supervision_server.rs src/core/mcp/mod.rs src/lib.rs`
- `cargo test loop_supervision_server --lib` from `src-tauri` passed.
- `cargo test loop_supervision_mcp_command_tests --lib` from `src-tauri`
  passed.
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `git diff --check` passed.
- Manual source check confirmed supervisor tool names are not present in
  `src-tauri/src/core/mcp/agent_bridge.rs`.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`

Remaining risks:

- Stage 5 adds a local MCP-shaped supervisor command surface, but does not start
  a standalone stdio, SSE, or streamable-HTTP MCP server process for external
  clients.
- The supervisor `stop_loop` tool marks Loop supervision stopped, but does not
  directly cancel an in-flight Ollama worker because the active cancellation
  helper remains internal to `ollama_agent.rs`; the existing local Tauri
  `stop_loop` command still performs active worker cancellation.
- Manual MCP client invocation was not performed in this stage; verification is
  from command registration, unit tests, `cargo check --lib`, and source
  inspection.

## Stage 6: Escalation Workflow

Status: DONE (2026-05-31)

Wire guardrails to cloud escalation decisions.

Likely files:

- `src-tauri/src/core/loop_supervision.rs`
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- MCP supervision server files from Stage 5

Escalation triggers:

- Build/test failure.
- Same step fails twice.
- Progress file contradicts filesystem.
- File edit outside allowed scope.
- Diff is too large.
- Route/navigation changes.
- New legacy navigation appears.
- Before commit.
- After every configured N loop runs.

Implementation notes:

- `request_supervisor_review` should create a compact evidence package.
- The cloud supervisor can recommend:
  - continue
  - pause
  - stop
  - approve next stage
  - request more evidence
- The cloud supervisor should not directly edit files.

Verification:

- `cargo check --lib` from `src-tauri`.
- Trigger tests for each escalation condition.
- Evidence package size test.
- Manual dry run where escalation pauses the loop without modifying prompts.

Changed files:

- `src-tauri/src/core/loop_supervision.rs`
  - Added compact supervisor evidence responses for escalation review.
  - Added deterministic escalation trigger mapping for build/test failures,
    repeated error signatures, out-of-project edit attempts, diff byte/path
    limits, route/navigation changes, legacy navigation patterns, missing
    changed paths, and configured audit intervals.
  - Added supervisor recommendations for `continue`, `pause`, `stop`, and
    `request_more_evidence`.
  - Added `request_supervisor_review`, which returns capped evidence and pauses
    Loop scheduling when the deterministic recommendation requires review.
  - Extended loop limits with `audit_interval_runs`.
  - Added focused tests for compact evidence, pause-on-escalation, interval
    escalation, and continue/no-trigger behavior.
- `src-tauri/src/core/mcp/loop_supervision_server.rs`
  - Exposed supervisor-only `request_supervisor_review` on the Loop Supervision
    MCP surface.
  - Kept the tool separate from `agent_bridge.rs` so the local worker does not
    see supervisor tools.
  - Added MCP dispatch coverage for the new evidence package tool.
- `src-tauri/src/lib.rs`
  - Registered the local Tauri `request_supervisor_review` command.
- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Extended best-effort Loop supervision polling to request supervisor review
    when local status reports `next_action: audit`.
  - Pauses future Loop scheduling for pause/review recommendations without
    modifying the stored Loop prompt or prompt context flags.

Verification performed:

- `cargo fmt -- src/core/loop_supervision.rs src/core/mcp/loop_supervision_server.rs src/lib.rs`
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo test loop_supervision_server --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `yarn workspace @janhq/web-app build` passed.
- `git diff --check` passed.
- Manual source check confirmed supervisor tool names are not present in
  `src-tauri/src/core/mcp/agent_bridge.rs`.
- Manual source check confirmed Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`

Remaining risks:

- Stage 6 creates a compact local evidence package and deterministic
  recommendation; it does not call a cloud model directly.
- `request_supervisor_review` is the explicit before-commit review hook, but no
  automatic git commit interception was added.
- Manual Tauri invocation was not performed in this stage; verification is from
  Rust unit tests, command registration, frontend build, and source inspection.
- Stage 5's standalone external MCP server limitation still applies: this is a
  local MCP-shaped supervisor surface exposed through existing Tauri commands.

## Stage 7: Universal Project Loop Launcher

Status: DONE (2026-05-31)

Allow a Loop coding run to be queued for any validated project directory,
without relying on the currently selected UI folder.

Implementation notes:

- Keep Loop prompt isolation unchanged:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`
- Validate and canonicalize the requested project directory before launch.
- Start the first run immediately, then let the existing Loop scheduler handle
  remaining runs.
- Preserve the existing Loop supervision pause/stop behavior.
- Support a file-backed launch request so automation can queue a run while the
  app is open.

Launch request file:

- `loop-launch-request.json` inside the configured Jan data folder.

Request shape:

```json
{
  "project_dir": "/absolute/project/path",
  "prompt": "Fix the failing tests",
  "loop_times": 3,
  "loop_interval_minutes": 5,
  "max_iterations": 250,
  "created_at": "2026-05-31T00:00:00Z"
}
```

Changed files:

- `src-tauri/src/core/loop_launcher.rs`
  - Added validation/canonicalization for queued Loop launch requests.
  - Added commands to get the queue path, queue a request, and consume a queued
    request.
  - Added focused tests for prompt validation and limit clamping.
- `src-tauri/src/core/mod.rs`
  - Registered the new desktop `loop_launcher` module.
- `src-tauri/src/lib.rs`
  - Registered `get_loop_launch_request_path`, `queue_loop_launch_request`, and
    `consume_loop_launch_request`.
- `web-app/src/containers/CodingAgentPanel/loop-launcher.ts`
  - Added the frontend request types and queue/consume helpers.
  - Exposed the event name for in-app launch requests.
- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Added polling for queued launch requests when no agent is running.
  - Starts Loop runs against the canonical requested project directory, even if
    it was not the previously selected folder.
  - Exposes `window.queueAtomicLoopCoding(...)` and
    `window.getAtomicLoopLaunchPath()` for local automation.
  - Preserves Loop prompt isolation and supervision fallback behavior.

Verification performed:

- `cargo fmt -- src/core/loop_launcher.rs src/core/mod.rs src/lib.rs`
- `cargo test loop_launcher --lib` from `src-tauri` passed.
- `cargo test loop_supervision --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `yarn workspace @janhq/web-app build` passed.
- `git diff --check` passed.
- Manual source check confirmed launched Loop sends still use:
  - `source: 'loop'`
  - `includeConversationContext: false`
  - `includeSummaryContext: false`

Remaining risks:

- The file-backed launcher starts only while `CodingAgentPanel` is mounted in
  the app.
- The launcher queues at most one pending request because the file path is
  single-slot by design.
- Manual screen verification of a queued launch was not performed in this
  stage; verification is from Rust tests, frontend build, and source
  inspection.

## Stage 8: MCP Stop-Loop Cancellation Parity

Status: DONE (2026-06-01)

Make the supervisor MCP `stop_loop` tool match the local Tauri `stop_loop`
command by cancelling any active direct Ollama worker, not only marking Loop
supervision state as stopped.

Changed files:

- `src-tauri/src/core/ollama_agent.rs`
  - Made the existing active-agent cancellation helper available inside the
    crate so the supervisor MCP command path can reuse the same cancellation
    behavior as the local `stop_loop` command.
- `src-tauri/src/core/mcp/commands.rs`
  - Added `OllamaAgentState` to the Loop supervision MCP command path.
  - Routed successful MCP `stop_loop` calls through the shared active-agent
    cancellation helper.
  - Added a focused regression test proving MCP `stop_loop` cancels an active
    `CancellationToken`.

Verification performed:

- `cargo fmt -- src/core/mcp/commands.rs src/core/ollama_agent.rs`
- `cargo test loop_supervision_mcp_command_tests --lib` from `src-tauri`
  passed.
- `cargo test loop_supervision_server --lib` from `src-tauri` passed.
- `cargo check --lib` from `src-tauri` passed.
- `git diff --check` passed.

Remaining risks:

- Manual Tauri/MCP invocation was not performed in this fix; coverage is from
  Rust command-path unit tests and `cargo check --lib`.
- The supervisor surface is still local MCP-shaped Tauri commands, not a
  standalone external MCP server process.

## Stage 9: Pre-Commit Review Fixes

Status: DONE (2026-06-01)

Fix review findings before committing the Loop Supervision MCP work.

Changed files:

- `src-tauri/src/core/mcp/mod.rs`
  - Gated `loop_supervision_server` behind the same desktop-only target cfg as
    `loop_supervision` and `ollama_agent`.
- `src-tauri/src/core/mcp/commands.rs`
  - Gated Loop Supervision MCP imports, commands, helpers, and command tests
    behind desktop-only target cfg so mobile builds do not reference
    desktop-only modules.
- `src-tauri/src/lib.rs`
  - Kept Loop Supervision MCP commands registered only in the desktop invoke
    handler.
  - Removed Loop Supervision MCP commands from the mobile invoke handler.
- `src-tauri/src/core/mcp/loop_supervision_server.rs`
  - Changed `request_supervisor_review` from a read-only tool annotation to a
    control tool annotation because it can pause Loop scheduling when local
    guardrails require review.
  - Added test coverage that the supervisor review tool is not advertised as
    read-only.

Verification performed:

- `cargo fmt -- src/core/mcp/commands.rs src/core/mcp/mod.rs src/core/mcp/loop_supervision_server.rs src/lib.rs`
- `cargo test loop_supervision_server --lib` from `src-tauri` passed.
- `cargo test loop_supervision_mcp_command_tests --lib` from `src-tauri`
  passed.
- `cargo check --lib` from `src-tauri` passed.
- `yarn workspace @janhq/web-app build` passed.
- `git diff --check` passed.

Remaining risks:

- `cargo check --lib --target aarch64-apple-ios` could not run because the
  local Rust `aarch64-apple-ios` target is not installed.
- Manual Tauri/MCP invocation was not performed in this fix.
