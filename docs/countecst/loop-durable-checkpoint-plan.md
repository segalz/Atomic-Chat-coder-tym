# Loop Durable Checkpoint Plan

## Decision

The previous automatic context-renewal design is abandoned.

Do not continue the failed design based on replaying the same loop prompt with a free-form summary. It caused repeated file reads, repeated tool use, guard workarounds, and unreliable progress after reset.

The new design is durable workflow checkpointing:

- Keep the Loop Mode context budget indicator.
- Record loop work as structured events.
- Derive a compact checkpoint from those events.
- Resume the same loop run from the checkpoint, not from the old conversation.
- Do not inject manual conversation context into Loop Mode.
- Do not inject manual summary context into Loop Mode.

## Architecture

Loop Mode should have three separate layers:

1. Worker Agent
   - Executes the current run.
   - Uses tools and edits files.
   - Does not own durable memory.

2. Event Log
   - Append-only record for each loop run.
   - Stores tool calls, results, edits, failures, decisions, context usage, and run state.
   - This is the source of truth.

3. Checkpoint Manager
   - Builds a small structured checkpoint from the event log.
   - May start as deterministic code.
   - Can later use a local model to improve wording, but schema remains fixed.

## Checkpoint Schema

Use a strict JSON shape:

```json
{
  "loop_id": "",
  "run_number": 1,
  "max_runs": 1,
  "project_dir": "",
  "current_goal": "",
  "current_stage": "",
  "completed_actions": [],
  "files_seen": [],
  "files_changed": [],
  "tool_results": [],
  "known_findings": [],
  "verification": [],
  "next_action": "",
  "do_not_repeat": [],
  "risks": []
}
```

## Stage 1: Cleanup And Context Bar

Goal:

- Remove the failed automatic renewal, replay, free-form loop summary, emergency compaction, freeze snapshot, and loop repeat guard code.
- Keep only the Loop Mode context budget indicator.

Requirements:

- Loop Mode still runs normally.
- Manual Code Mode context behavior stays unchanged.
- Context bar counts the active loop session log while Loop Mode is enabled.
- No automatic renewal is active.

Verification:

- `yarn workspace @janhq/web-app build`
- `cargo check --lib`
- Manual smoke test: normal loop still starts and stops.

## Stage 2: Append-Only Loop Event Log

Goal:

- Add a loop-owned event log that records worker activity without affecting prompt behavior.

Event examples:

- `run_started`
- `model_response`
- `tool_call_started`
- `tool_call_completed`
- `file_changed`
- `verification_completed`
- `run_completed`
- `run_failed`
- `context_percent_updated`

Requirements:

- The log must be append-only.
- The log must be scoped by loop id and run number.
- Event logging must not change agent behavior.
- Keep payloads compact; large tool outputs should be summarized or referenced, not copied in full.

## Stage 3: Deterministic Checkpoint Builder

Goal:

- Build `loop_checkpoint.json` from event logs without an LLM.

Requirements:

- Deterministic output.
- Stable schema.
- Include exact next action when it can be inferred.
- Include `do_not_repeat` from completed broad reads and repeated failed actions.
- Do not use this checkpoint in prompts yet.

## Stage 4: Checkpoint Resume Prompt

Goal:

- When context is high, stop the current run at a safe boundary and start a fresh loop run using only the checkpoint.

Requirements:

- Do not replay the original full prompt.
- Do not inject manual conversation context.
- Do not inject manual summary context.
- Do not advance loop count during checkpoint/resume.
- Resume prompt must be short and schema-driven.

## Stage 5: Checkpoint Manager With Optional Local AI

Goal:

- Add an optional local compacting manager that reads event log + deterministic checkpoint and improves the `next_action` and `known_findings`.

Requirements:

- AI output must validate against schema.
- If validation fails, use the deterministic checkpoint.
- The manager cannot call project-editing tools.
- The manager cannot advance the loop.

## Stage 6: Automatic Renewal Policy

Goal:

- Reintroduce automatic renewal only after checkpointing works.

Policy:

- Trigger above 60 percent context usage.
- Check on every context percentage update.
- Transition: `running -> checkpointing -> resuming_same_run -> running`.
- Only after a real run completion may the normal timer start and loop count advance.

## Non-Goals

- No free-form conversation replay.
- No manual summarize button simulation.
- No prompt-only guard strategy.
- No blocking random shell commands as the main solution.
- No dependence on the worker model remembering what happened.
