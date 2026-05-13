# Bugs To Fix

## Current Status

The Ollama Coder migration verification currently passes:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- `yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false`
- `yarn workspace @janhq/web-app lint`

The frontend lint command passes with `0 errors`, but warnings remain.

## Priority 1: Manual Product QA

### Direct Ollama GUI Loop

Status: Pending

Run a real GUI-driven test in the desktop app:

- Start the app normally.
- Open the visible Coding Agent panel.
- Confirm backend is `direct-ollama`.
- Select a project folder.
- Run a normal prompt.
- Confirm text appears in the execution log.
- Confirm tool calls appear in the log.
- Trigger or verify a diff proposal.
- Approve a diff and confirm the file changes correctly.
- Reject a diff and confirm no write happens.
- Run a short loop and confirm the next run starts only after the previous run finishes.
- Press Stop while a diff approval is pending and confirm the run exits cleanly.

Expected result:

- No stuck `running` state.
- No duplicate done messages.
- Failed or cancelled runs stop the loop.
- Approved writes apply correctly.
- Rejected writes do not modify files.

## Priority 2: Frontend Lint Warnings

Current state:

- `yarn workspace @janhq/web-app lint` passes with `0 errors`.
- There are 9 warnings.

Files to review:

- `web-app/src/components/ai-elements/reasoning.tsx`
- `web-app/src/components/ai-elements/tool.tsx`
- `web-app/src/components/ui/button-group.tsx`
- `web-app/src/components/ui/button.tsx`
- `web-app/src/components/ui/sidebar.tsx`
- `web-app/src/containers/ChatInput.tsx`
- `web-app/src/containers/pm/PlanComposer.tsx`
- `web-app/src/routes/threads/$threadId.tsx`

Warning types:

- Missing React Hook dependencies.
- Fast refresh warnings where files export both components and non-component values.
- Callback dependency instability warnings.

Suggested fix policy:

- For missing hook dependencies, add dependencies only after checking whether behavior changes.
- For unstable functions used in dependency arrays, wrap them in `useCallback` only when needed.
- For fast-refresh warnings, move shared constants/helpers to separate files only if low-risk.
- Avoid large refactors during this cleanup.

Verification after fix:

```bash
yarn workspace @janhq/web-app lint
yarn workspace @janhq/web-app exec tsc -b tsconfig.app.json --pretty false
```

Expected result:

- `0 errors`
- Ideally `0 warnings`
- TypeScript passes

## Priority 3: Rust Dead-Code Warnings

Current state:

- `cargo check --manifest-path src-tauri/Cargo.toml` passes.
- There are 5 warnings in plugin code.

Files to review:

- `src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`
- `src-tauri/plugins/tauri-plugin-vector-db/src/db.rs`

Warning types:

- Unused structs.
- Unread struct fields.

Suggested fix policy:

- Do not delete structs blindly.
- First check whether they are intended API or serialization contracts.
- If they are future-facing or externally meaningful, prefer targeted `#[allow(dead_code)]`.
- If they are genuinely obsolete, remove them only with confidence.
- For unread fields that are useful for deserialization or diagnostics, consider `#[allow(dead_code)]` on the field or struct.

Verification after fix:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected result:

- Build passes.
- No Rust warnings, or only intentionally allowed warnings.

## Priority 4: Documentation Update

After GUI QA and cleanup, update:

- `docs/ollama-coder-migration-progress.md`
- `docs/ollama-coder-standalone-plan.md`

Update items:

- Mark GUI-driven direct loop QA as completed if it passes.
- Record any cleanup changes.
- Record final verification commands and results.
- If legacy fallback remains, document why.
- If all direct QA passes, decide whether legacy fallback should stay or be scheduled for removal.

## Recommended Order

1. Run manual GUI QA first.
2. If QA passes, clean frontend warnings.
3. Then clean Rust warnings.
4. Re-run full verification.
5. Update docs.
6. Decide legacy fallback retirement timing.
