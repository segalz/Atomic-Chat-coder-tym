# Loop Point-Failure Advisor Implementation Prompt

Read first:

- `docs/countecst/loop-point-failure-advisor-plan.md`
- `docs/countecst/loop-point-failure-advisor-progress.md`

Work on exactly the next TODO stage only.

Before editing, state the exact files you will change and why, then wait for approval.

Hard requirements:

- The local worker remains the executor.
- Claude, Antigravity, and Codex are point advisors only.
- Advisor fallback may ask for exact next-step advice, but must not hand over execution.
- The advisor core must support both Loop Mode and regular Code Agent conversations.
- Do not send full conversation logs to advisors.
- Do not inject manual conversation context into Loop Mode.
- Do not inject manual summary context into Loop Mode.
- Do not simulate the manual `Summarize & continue` button.
- Do not revive free-form loop context replay.
- If one advisor does not answer, automatically try another configured advisor.
- If no advisor answers, stop the loop with a clear error.
- Auto advisor order must be user-configurable.
- Advisor CLI availability checks must be lightweight and must not send project data.
- Redact secrets before every advisor call.
- Validate advisor responses before applying them.
- Reject destructive commands, project-root escapes, prompt replay, and safety bypass instructions.
- Enforce advisor attempt budgets and cooldowns.
- After applying advice, verify that it produced a real progress signal.
- Record advisor attempts, decisions, and outcomes in an audit log.
- Keep Loop Mode context budget indicator behavior.
- Preserve existing regular Code Agent conversation behavior.
- Keep changes scoped to the current stage.
- Preserve existing working behavior and avoid regressions.
- Keep UI/design code in separate CSS files when adding UI styling.
- Use CodeHelper MCP first if available and suitable.
- At the end, update `docs/countecst/loop-point-failure-advisor-progress.md` with changed files, verification, and remaining risks.
