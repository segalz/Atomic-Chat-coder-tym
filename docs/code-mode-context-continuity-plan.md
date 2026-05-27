# Code Mode Context Continuity Plan

## Goal

Improve continuity between prompts in Code Mode so the agent can understand what happened earlier in the same manual conversation, without reintroducing the previous performance regression or breaking Loop Mode.

The key rule:

- Manual Code Mode may use compact context.
- Loop Mode must stay context-free.
- A new conversation must start clean unless the user explicitly loads an old session.

## Recommended Rollout

Use 5 separate implementation conversations.

Do not implement all stages in one conversation. The risk is behavioral: a small mistake can leak context into Loop Mode, inflate prompts, or keep stale summaries after a new session. Each stage should end with verification before moving to the next one.

## Single Prompt To Use In Each New Conversation

Paste this prompt at the start of each implementation conversation:

```text
Read docs/code-mode-context-continuity-plan.md first.

Work on exactly the next unchecked stage only.

Implement the stage end-to-end in this conversation. Do not stop for approval before code edits.

Before editing, briefly state which files you are about to change and why, then proceed.

Hard requirements:
- Do not inject conversation context into Loop Mode.
- Do not inject summary context into Loop Mode.
- New Code Mode sessions must start clean.
- Keep UI/design code separated when adding UI.
- Keep changes scoped to the current stage.
- At the end, update this plan file: mark the completed stage, add changed files, verification performed, and remaining risks.

Use CodeHelper MCP first if available and suitable.
```

## Stage 1: Context Budget Indicator

Status: DONE

Add a visible but quiet context usage indicator in Code Mode.

This stage must not change prompt construction or agent behavior.

Initial estimate:

```ts
estimatedTokens = Math.ceil(characterCount / 4)
contextPercent = estimatedTokens / 32768
```

Suggested warning levels:

- 0-60%: normal
- 60-80%: subtle warning
- 80-90%: recommend summarizing
- 90%+: strongly suggest summarizing before continuing

Likely files:

- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/conversation-context.ts`
- `web-app/src/containers/CodingAgentPanel/ContextBudgetIndicator.tsx`

Verification:

- Context percentage appears in manual Code Mode.
- Prompt payloads are unchanged.
- Loop behavior is unchanged.

Changed files:

- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/ContextBudgetIndicator.tsx`
- `web-app/src/containers/CodingAgentPanel/ContextBudgetIndicator.css`
- `docs/code-mode-context-continuity-plan.md`

Verification performed:

- Used CodeHelper first to inspect the Code Mode panel and prompt/context flow.
- Ran `npm test -- --run web-app/src/containers/CodingAgentPanel/conversation-context.test.ts` and confirmed 6 tests passed, covering unchanged prompt-context behavior including history disabled and loop sessions.
- Ran `npm run build --workspace @janhq/web-app`; TypeScript and Vite production build completed successfully.
- Confirmed the Stage 1 implementation only renders a UI indicator and does not modify `sendPrompt`, `buildCodingAgentPrompt`, Loop Mode prompt options, session creation, or prompt payload construction.

Remaining risks:

- The indicator uses the requested rough `characters / 4` estimate and counts visible active manual session text, so it is intentionally approximate rather than tokenizer-exact.
- Visual placement was build-verified but not browser-screenshot verified in this stage.

## Stage 2: Session Summary Storage

Status: DONE

Add summary storage to Code Mode sessions.

Suggested fields:

```ts
conversationSummary?: string
conversationSummaryUpdatedAt?: number
```

Rules:

- Summary belongs only to the active session.
- New sessions start without summary.
- Old summaries remain in history but are not injected into new sessions.

Likely file:

- `web-app/src/stores/coding-agent-store.ts`

Verification:

- Summary can be stored on an active manual session.
- Starting a new session clears active summary context.
- Existing session migration remains safe.

Changed files:

- `web-app/src/stores/coding-agent-store.ts`
- `web-app/src/stores/coding-agent-store.test.ts`
- `docs/code-mode-context-continuity-plan.md`

Verification performed:

- Used CodeHelper first to inspect the Code Mode session store and confirm Stage 2 should stay scoped to summary storage, session normalization/migration, and session lifecycle actions.
- Added focused store tests for storing a summary on the active manual session, starting a new session without inheriting the previous summary, loading a summarized session, and rejecting summary storage on a loop session.
- Ran `npm test -- --run web-app/src/stores/coding-agent-store.test.ts web-app/src/containers/CodingAgentPanel/conversation-context.test.ts`; 10 tests passed.
- Ran `npm run build --workspace @janhq/web-app`; TypeScript and Vite production build completed successfully.
- Confirmed by code search that Stage 2 does not modify `buildCodingAgentPrompt`, `sendPrompt`, or the loop call path, and does not inject conversation or summary context into Loop Mode.

Remaining risks:

- Summary generation and UI are not implemented yet; Stage 2 only adds safe storage and lifecycle behavior for a later manual summarize action.

## Stage 3: Manual Summarize Button

Status: DONE

Add a manual `Summarize & continue` button in Code Mode.

The button should generate a compact structured summary of the current active conversation.

Summary format:

```md
## Conversation Goal

## Decisions Made

## Important Files

## Work Already Done

## Errors / Failed Attempts

## Constraints / Do Not Break

## Current State

## Recommended Next Step
```

Rules:

- The button is user-triggered.
- No automatic summarization in this stage.
- Loop Mode must not trigger or receive summaries.

Likely files:

- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/stores/coding-agent-store.ts`
- `web-app/src/containers/CodingAgentPanel/conversation-summary.ts`

Verification:

- Manual button creates and stores a summary.
- Summary is visible or inspectable in the session state.
- Loop Mode remains unchanged.

Changed files:

- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/conversation-summary.ts`
- `web-app/src/containers/CodingAgentPanel/conversation-summary.test.ts`
- `web-app/src/containers/CodingAgentPanel/ConversationSummary.css`
- `docs/code-mode-context-continuity-plan.md`

Verification performed:

- Used CodeHelper first to inspect Code Mode panel/store surfaces, then verified the current checkout manually because the tool also referenced an older `CodeModePanel` path.
- Added a user-triggered `Summarize & continue` button that is disabled while Loop Mode is active or while the agent is running.
- Added deterministic structured summary generation with the required headings and a guard that returns no summary for loop sessions.
- Stored the generated summary through the existing `setConversationSummary` manual-session store API and showed a small `Summary saved` status when the active manual session has summary state.
- Ran `npm test -- --run web-app/src/containers/CodingAgentPanel/conversation-summary.test.ts web-app/src/stores/coding-agent-store.test.ts web-app/src/containers/CodingAgentPanel/conversation-context.test.ts`; 12 tests passed.
- Ran `npm run build --workspace @janhq/web-app`; TypeScript and Vite production build completed successfully.
- Confirmed by code search that the Loop Mode send path still calls `sendPromptRef.current(loopPrompt, { source: 'loop', includeConversationContext: false })` and Stage 3 does not inject conversation or summary context into Loop Mode.

Remaining risks:

- Summary quality is deterministic and compact, not model-generated; it extracts useful structure from the active session prompt/logs/plan text.
- Stage 3 stores summaries but does not inject them into prompts yet; that remains Stage 4.
- Visual placement was build-verified but not browser-screenshot verified in this stage.

## Stage 4: Inject Summary For Manual Prompts Only

Status: DONE

Update prompt construction so manual Code Mode prompts can include the current session summary.

Rules:

- Manual prompts may include compact summary context.
- Loop prompts never include summary context.
- New sessions never inherit old summaries.
- The current request is always authoritative.
- Prefer summary over raw history once a summary exists.

Expected loop call shape:

```ts
sendPromptRef.current(loopPrompt, {
  source: 'loop',
  includeConversationContext: false,
  includeSummaryContext: false,
})
```

Likely file:

- `web-app/src/containers/CodingAgentPanel/conversation-context.ts`

Verification:

- Manual prompt 2 receives summary/context from the active manual session.
- Loop continuation receives no history and no summary.
- Manual-to-loop transition does not leak context into loop.
- New session starts clean.

Changed files:

- `web-app/src/containers/CodingAgentPanel/conversation-context.ts`
- `web-app/src/containers/CodingAgentPanel/conversation-context.test.ts`
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `docs/code-mode-context-continuity-plan.md`

Verification performed:

- Used CodeHelper first to inspect Code Mode prompt construction and sendPrompt option flow.
- Updated prompt construction to accept `includeSummaryContext`, include the active manual session's stored `conversationSummary` when enabled, and prefer that stored summary over raw session history once it exists.
- Updated manual send calls so manual prompts opt into conversation and summary context, while Loop Mode prompts opt out of both.
- Confirmed the loop continuation call shape is now `source: 'loop'`, `includeConversationContext: false`, and `includeSummaryContext: false`.
- Added focused tests for stored summary injection, summary-over-raw-history preference, summary opt-out, summary-without-raw-history behavior, and loop-session exclusion even when a loop session has a stored summary.
- Ran `npm test -- --run web-app/src/containers/CodingAgentPanel/conversation-context.test.ts web-app/src/stores/coding-agent-store.test.ts web-app/src/containers/CodingAgentPanel/conversation-summary.test.ts`; 15 tests passed.
- Ran `npm run build --workspace @janhq/web-app`; TypeScript and Vite production build completed successfully.

Remaining risks:

- Runtime UI behavior was not browser-screenshot verified in this stage because the change is prompt-construction focused.
- This stage preserves the existing raw active-session fallback when no stored summary exists; Stage 5 should verify the complete manual, loop, manual-to-loop, new-session, and old-session flows end to end.

## Stage 5: Regression Verification And Hardening

Status: DONE

Perform focused regression checks and tighten any weak guards.

Required checks:

- Manual prompt 1 to manual prompt 2: context or summary is available.
- Loop prompt to loop continuation: no history and no summary are injected.
- Manual prompt then enable loop: loop does not inherit manual summary.
- New Code Mode session: no old summary is injected.
- Explicitly loading an old session: only that session summary may be used.

Verification should include code inspection and at least one build/typecheck command appropriate for the touched files.

Likely files:

- `web-app/src/containers/CodingAgentPanel/conversation-context.test.ts`
- `web-app/src/stores/coding-agent-store.test.ts`
- `docs/code-mode-context-continuity-plan.md`

Changed files:

- `web-app/src/containers/CodingAgentPanel/conversation-context.test.ts`
- `web-app/src/stores/coding-agent-store.test.ts`
- `docs/code-mode-context-continuity-plan.md`

Verification performed:

- Used CodeHelper first to inspect the Code Mode prompt construction, send option flow, session summary storage, and loop/new-session guard surfaces.
- Manually inspected `buildCodingAgentPrompt`, `sendPrompt`, the initial loop send path, loop continuation send path, `startNewSession`, `loadSession`, and `clearSession`.
- Confirmed manual prompts still opt into conversation and summary context, while the initial Loop Mode prompt and loop continuations pass `includeConversationContext: false` and `includeSummaryContext: false`.
- Confirmed `startNewSession` clears active runtime summary state and `buildCodingAgentPrompt` only uses the active manual session from the current project.
- Added Stage 5 regression tests for loop continuation opt-out with an active manual summary, explicit old-session summary isolation, and clean-session summary clearing.
- Ran `npm test -- --run web-app/src/containers/CodingAgentPanel/conversation-context.test.ts web-app/src/stores/coding-agent-store.test.ts web-app/src/containers/CodingAgentPanel/conversation-summary.test.ts`; 18 tests passed.
- Ran `npm run build --workspace @janhq/web-app`; TypeScript and Vite production build completed successfully.

Remaining risks:

- Runtime browser/Tauri interaction was not screenshot-verified in this stage; verification focused on code inspection, regression tests, and production web build.
- Existing Vite warnings about dynamic imports and large chunks remain unchanged by this stage.

## Non-Goals

- Do not add automatic summarization by default.
- Do not add memory sharing across unrelated conversations.
- Do not inject summaries into Loop Mode.
- Do not increase prompt size without showing context budget.
- Do not solve exact token accounting in the first rollout.

## Final Acceptance Criteria

- Manual Code Mode can continue from earlier prompts in the same session.
- Context remains bounded and visible.
- The user can manually summarize and continue.
- Loop Mode remains isolated.
- New sessions start clean.
- The plan file accurately records completed stages and verification.
