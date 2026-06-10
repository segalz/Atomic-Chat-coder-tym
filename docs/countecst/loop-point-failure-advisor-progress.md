# Point-Failure Advisor Progress

## Current Stage

Next stage: Stage 3 - Advisor Availability Health Check

## Status

Stage 1 complete.

## Decision Summary

- The local worker remains the executor.
- Claude, Antigravity, and Codex are point advisors only.
- Advisor fallback triggers after 3 similar failures or 3 similar no-progress cycles.
- The advisor returns only a structured next-step instruction.
- The worker continues from the same point after applying the advice.
- If one advisor fails, the router tries another advisor automatically.
- If all advisors fail, the loop stops with a clear error.
- A side-panel setup dialog should check which advisor CLIs are available.
- Auto mode should use a user-selected first/second/third advisor fallback order.
- The same advisor core must work in Loop Mode and regular Code Agent conversations.
- Loop Mode can use automatic fallback.
- Regular conversations can use automatic or manual advisor fallback depending on settings.
- Advisor calls must pass through privacy redaction and safety validation.
- Advisor retries must have budgets and cooldowns.
- Advice must enter a short post-advice probation window to confirm it helped.
- Advisor decisions and outcomes must be recorded in an audit log.

## Stage 1 TODO

Status: DONE

Findings:

- `src-tauri/src/core/ollama_agent.rs` still had active automatic checkpoint resume behavior at 60 percent context usage.
- That behavior cleared the current `messages`, built a checkpoint resume prompt, and continued the same run from that prompt.
- This conflicted with the new point-failure advisor plan because it revived the previous context-renewal behavior before a stuck advisor exists.
- Loop context percent reporting should stay active because the Loop Mode context bar depends on it.
- Existing event-log/checkpoint files can remain for now as long as they do not rewrite worker prompt/runtime flow.

Changed files:

- `src-tauri/src/core/ollama_agent.rs`
  - Removed the active 60 percent checkpoint resume/reset block.
  - Removed now-unused checkpoint resume imports, constants, counters, and checkpoint file loader from this file.
  - Kept context percent estimation and `supervision.record_context_percent(percent)` so the Loop context bar can continue working.

- `docs/countecst/loop-point-failure-advisor-progress.md`
  - Marked Stage 1 complete.
  - Recorded findings, changed files, verification, and remaining risks.

Advisor availability:

- Antigravity MCP was available and gave a focused read-only architecture review.
- Claude CLI exists at `/Users/zvisegal/.nvm/versions/node/v24.11.1/bin/claude`, but it is not logged in and returned `Not logged in · Please run /login`.

Verification:

- `cargo fmt` — passed.
- `cargo check --lib` — passed, with existing plugin warnings only.
- `yarn workspace @janhq/web-app build` — passed, with existing chunk-size warnings only.
- `git diff --check` — passed.

Remaining risks:

- `loop_checkpoint.rs`, `loop_checkpoint_ai.rs`, and `loop_event_log.rs` still exist and may be reused later, but Stage 1 disabled their prompt-reset runtime path from `ollama_agent.rs`.
- Manual smoke testing is still needed to confirm a simple Loop run starts/stops and still shows context percent.

## Stage 2 - Advisor Configuration Model

Status: DONE

Changed files:

- `src-tauri/src/core/planner_config.rs`
  - Added `PointFailureAdvisorConfig`.
  - Added advisor mode enum: `auto`, `claude`, `antigravity`, `codex`.
  - Added CLI command config for Claude, Antigravity, and Codex.
  - Added Auto fallback order.
  - Added Loop and regular-conversation advisor policies.
  - Added attempt budget config.
  - Added conservative defaults: advisors disabled, Loop asks before cloud advisor, regular conversations are manual-only.
  - Added `get_point_failure_advisor_config` read-only command.
  - Added unit tests for conservative defaults, old config parsing without advisor section, and advisor override parsing.

- `src-tauri/src/lib.rs`
  - Registered `get_point_failure_advisor_config`.

- `src-tauri/src/core/loop_supervision.rs`
  - Fixed stale test calls to `begin_run` after its signature changed from 4 args to 3 args.

- `src-tauri/src/core/mcp/loop_supervision_server.rs`
  - Fixed the same stale test call pattern.

- `docs/countecst/loop-point-failure-advisor-progress.md`
  - Marked Stage 2 complete.
  - Recorded changed files, verification, and remaining risks.

Advisor availability:

- Antigravity MCP was used for a read-only Stage 2 config review.
- Claude CLI still needs login before it can participate.

Verification:

- `cargo fmt` — passed.
- `cargo test --lib planner_config` — passed, 3 tests.
- `cargo check --lib` — passed, with existing plugin warnings only.
- `yarn workspace @janhq/web-app build` — passed, with existing chunk-size warnings only.
- `git diff --check` — passed.

Remaining risks:

- Stage 2 adds configuration only; it intentionally does not execute advisor CLIs.
- The command strings are stored as plain strings for now; Stage 3 must validate availability without sending project data.
- UI controls are not wired yet; that is planned for Stage 9.

## Stage 3 TODO

- Add a safe CLI availability check before runtime fallback is used.
- Run a tiny contract prompt against each configured advisor.
- Use a short timeout.
- Capture status per advisor.
- Do not send project data during health checks.
- Do not start Loop Mode work from the health check.
- Expose the result to the UI.
- Test fake CLI success, missing command, timeout, invalid JSON, and non-zero exit.

## Planned Stages

1. Freeze scope and remove conflicting runtime behavior.
2. Advisor configuration model.
3. Advisor availability health check.
4. Privacy, redaction, and safety validator.
5. Stuck detector.
6. Stuck report builder.
7. Advisor router.
8. Advisor response applier.
9. UI controls.
10. Runtime limits and failure UX.

## Changed Files

- `docs/countecst/loop-point-failure-advisor-plan.md`
- `docs/countecst/loop-point-failure-advisor-progress.md`
- `docs/countecst/loop-point-failure-advisor-prompt.md`

## Verification

- Documentation-only change.
- No code build required yet.
- `git diff --check` should be run after documentation edits.

## Remaining Risks

- Existing uncommitted loop checkpoint/event-log code may conflict with this new plan.
- Stage 1 must verify actual runtime wiring before implementation continues.
- Advisor CLI command shape is intentionally configurable and must be validated before execution is added.
- Health checks must not send project data to external advisors.
- Shared advisor code must avoid duplicating separate Loop and regular-conversation implementations.
- Safety validation must reject unsafe but plausible advisor advice.
- Advisor retry budgets must prevent a new advisor-driven infinite loop.
- Post-advice probation must avoid false positives when legitimate progress takes more than a few actions.
