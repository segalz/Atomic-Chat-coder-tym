# Loop Durable Checkpoint Implementation Prompt

Read first:

- `docs/countecst/loop-durable-checkpoint-plan.md`
- `docs/countecst/loop-durable-checkpoint-progress.md`

Work on exactly the next TODO stage only.

Before editing, state the exact files you will change and why, then wait for approval.

Hard requirements:

- Do not revive the failed free-form summary/replay renewal design.
- Do not inject manual conversation context into Loop Mode.
- Do not inject manual summary context into Loop Mode.
- Keep Loop Mode context budget indicator behavior.
- Keep changes scoped to the current stage.
- Preserve existing working behavior and avoid regressions.
- Use CodeHelper MCP first if available and suitable.
- At the end, update `docs/countecst/loop-durable-checkpoint-progress.md` with changed files, verification, and remaining risks.
