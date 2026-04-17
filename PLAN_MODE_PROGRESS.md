# Plan Mode — Implementation Progress

Tracks what was done in each phase. For the full spec see `PLAN_MODE_DEVELOPMENT_PLAN.md`.

---

## Phase 0 — Audit & Mode Rename ✅ COMPLETE

**Goal:** Rename the mode and strip code-execution features from the UI.

### Changed files
| File | What changed |
|------|-------------|
| `web-app/src/stores/code-mode-store.ts` | `AppMode: 'chat' \| 'code'` → `'chat' \| 'plan'`; removed `codeModel`, `availableCodeModels`, `permissionMode` + setters; added `attachedImagePath: string \| null` + setter; updated `partialize` |
| `web-app/src/routes/index.tsx` | Mode keys `'code'` → `'plan'`; labels use `chatMode`/`planMode` i18n keys; removed `CodeModelSelector` usage; stop-on-leave targets `'plan'` |
| `web-app/src/containers/CodeModePanel.tsx` | Removed `<CodeModelSelector />`, `<PermissionModeSelector />`, `handlePullModel`, `isPullingModel`, `pullStatus`, `ollamaStatus` effects, `diff_snapshot` listener + rendering; `handleSend` calls `run_plan_pipeline` with `imagePath` |
| `web-app/src/containers/PermissionModeSelector.tsx` | Returns `null` (neutralised) — fields it consumed no longer exist in store |
| `web-app/src/components/CodeModeStoreTest.tsx` | Removed references to deleted store fields |
| `web-app/src/locales/en/code-mode.json` | Added `planMode`, `planModeTitle` keys |
| `web-app/src/locales/he/code-mode.json` | Added `planMode`, `planModeTitle` keys |
| `src-tauri/src/core/code_agent.rs` | Added temporary `run_plan_pipeline` command stub (forwards to `spawn_code_agent`) |
| `src-tauri/src/lib.rs` | Registered `run_plan_pipeline` in desktop invoke handler |

### Verification results
- [x] `yarn workspace @janhq/web-app build` — passed
- [x] `cargo check` — passed
- [x] Mode toggle shows "Chat | Plan"
- [x] Pre-existing lint error in `DownloadButton.tsx` (unrelated) remains

---

## Phase 1 — Config System ✅ COMPLETE

**Goal:** Bundled `planner-config.toml` is readable from Rust and exposed to the frontend.

### Changed / created files
| File | What changed |
|------|-------------|
| `src-tauri/resources/planner-config.toml` | **Created** — default model names, Ollama settings, pipeline limits, Gemini settings |
| `src-tauri/tauri.conf.json` | Added `"resources/planner-config.toml"` to `bundle.resources` |
| `src-tauri/Cargo.toml` | Added `toml = "0.8"` dependency |
| `src-tauri/src/core/planner_config.rs` | **Created** — `PlannerConfig` / sub-structs, `PlannerConfig::load()` (user override → bundled → hardcoded), `get_planner_config` Tauri command |
| `src-tauri/src/core/mod.rs` | Added `pub mod planner_config` (desktop-only cfg gate) |
| `src-tauri/src/lib.rs` | Registered `core::planner_config::get_planner_config` in desktop invoke handler |

### Config load priority
1. `~/Library/Application Support/chat.atomic.app/planner-config.toml` (user override)
2. `{resource_dir}/resources/planner-config.toml` (bundled default)
3. Hardcoded struct defaults (never-fail fallback)

### Verification results
- [x] `cargo check` — passed (`toml 0.8.2` compiled cleanly)
- [ ] `invoke('get_planner_config')` returns valid JSON — pending runtime test
- [ ] User-override file picked up on restart — pending runtime test
- [ ] Bundled path resolved correctly in release build — pending build test

---

## Phase 2 — Image Drop Zone ✅ COMPLETE

**Goal:** Drag an image onto the prompt area and attach its path to the pipeline call.

### Changed files
| File | What changed |
|------|-------------|
| `web-app/src/containers/CodeModePanel.tsx` | Added `isDragOver` state; `handleDragOver` / `handleDragLeave` / `handleDrop` callbacks; input box now accepts PNG/JPEG/WEBP via OS drag-and-drop (reads `File.path` Tauri extension); image pill with ✕ shown when attached; `handleSend` captures + clears `attachedImagePath` before invoking; added `IconPhoto`, `IconX` imports |

### Behaviour
- Drag any PNG/JPEG/WEBP from Finder onto the prompt box → filename pill appears
- Click ✕ pill or send → image path cleared
- Path is forwarded as `imagePath` to `run_plan_pipeline` (already wired in Phase 0)

### Verification results
- [x] `yarn workspace @janhq/web-app tsc --noEmit` — passed (no errors)

## Phase 3 — Rust Pipeline: Stages 1–3 ✅ COMPLETE

**Goal:** Implement the pre-processing pipeline (Translate → Vision → Navigate) as HTTP calls to Ollama. No `ollama launch claude` yet.

### Changed / created files
| File | What changed |
|------|-------------|
| `src-tauri/src/core/planner_config.rs` | Made `load()` and `get_planner_config` generic over `R: Runtime` |
| `src-tauri/src/core/code_agent.rs` | Made `CodeAgentState` fields / event structs / `validate_workspace` / `check_not_root` public; added `pipeline_running` + `pipeline_cancel` fields; removed Phase-0 stub `run_plan_pipeline`; updated `stop_code_agent` to cancel in-flight pipeline stages |
| `src-tauri/src/core/plan_agent.rs` | **Created** — `ollama_chat`, `ollama_chat_with_image`, `scan_file_tree`, `detect_explicit_paths`, `parse_file_hints`, `run_pipeline_inner` (Stages 1–3), `run_plan_pipeline` command |
| `src-tauri/src/core/mod.rs` | Added `pub mod plan_agent` (desktop cfg gate) |
| `src-tauri/src/lib.rs` | `run_plan_pipeline` → `core::plan_agent::run_plan_pipeline` |
| `web-app/src/containers/CodeModePanel.tsx` | Added `StageState`, `PlanStageProgressEvent` types; `stages` + `stageDetail` state; `plan-stage-progress` listener; stage bar UI (`StageStep`, `StepArrow` components); reset stages on send |
| `web-app/src/locales/en/code-mode.json` | Added `stageTranslate`, `stageVision`, `stageNavigate`, `stagePlanning`, `stageDone`, `stageSkipped` |
| `web-app/src/locales/he/code-mode.json` | Hebrew equivalents of stage keys |

### Pipeline behaviour (Phase 3)
- Stage 1 (Translate): POST `/v1/chat/completions` → translator model → English prompt
- Stage 2 (Vision): POST with base64 image if attached → vision model; skipped otherwise
- Stage 3 (Navigate): file-tree scan + `ollama_chat` → navigator model → JSON array of file hints
- After Stage 3: emits a Markdown summary via `code-agent-output`; `code-agent-done` fires so UI resets
- Stop button cancels in-flight HTTP stages via `CancellationToken`

### Verification results
- [x] `cargo check` — passed (warnings only in unrelated plugins)
- [x] `yarn workspace @janhq/web-app tsc --noEmit` — passed (no errors)
- [ ] Clicking Run shows stage progress bar `⏳ Translating → ○ Analyzing → ○ Scanning → ○ Planning` — pending runtime test
- [ ] Stage 2 skipped (⏭) if no image attached — pending runtime test
- [ ] Stage 3 produces file hints — pending runtime test
- [ ] Stop button cancels in-flight stages — pending runtime test

## Phase 4 — Rust Pipeline: Stage 4 (Architect) ✅ COMPLETE

**Goal:** Launch `ollama launch claude` read-only to generate the plan.

### Changed files
| File | What changed |
|------|-------------|
| `src-tauri/src/core/code_agent.rs` | Made `find_ollama_binary` `pub` so `plan_agent` can reuse it |
| `src-tauri/src/core/plan_agent.rs` | Replaced Phase-3 placeholder summary with Stage 4 implementation: `build_mega_prompt` helper; `run_pipeline_inner` extended with `child_arc`, `stdin_arc`, `pipeline_running_arc` params; Stage 4 sets `pipeline_running=false`, spawns `ollama launch claude --allowedTools Read,LS,Glob,Grep --disallowedTools Write,Edit,...`, stores child in `state.child`, streams stdout → `code-agent-output`, emits `plan-stage-progress {architect, done/error}` + `code-agent-done` from the stdout task; `run_plan_pipeline` clones and passes the new Arc fields |

### Architecture notes
- **Done-event ownership transfer**: at Stage 4 start, `pipeline_running` is set `false` so the outer `tokio::spawn` skips emitting `code-agent-done`. The spawned stdout task owns that emission instead (identical coordination to `spawn_code_agent`).
- **Stop handling**: while Stage 4 runs, `state.child` is `Some`, so `stop_code_agent` takes the child, sends SIGTERM/SIGKILL, and emits done. The stdout task sees `None` from `child.wait()` and skips its own done emission — no duplicates.
- **PATH extension**: nvm versions + volta + homebrew prepended (same as `spawn_code_agent`).
- **Allowed tools**: `Read,LS,Glob,Grep` only; `Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch` explicitly disallowed.

### Verification results
- [x] `cargo check` — passed (warnings only in unrelated plugins)
- [ ] Full pipeline runs end-to-end: Translate → Vision → Navigate → Planning — pending runtime test
- [ ] Stage 4 output streams into the panel — pending runtime test
- [ ] Stop button cancels the architect agent mid-run — pending runtime test
- [ ] No files are created or modified in the Expo project during a run — pending runtime test

## Phase 5 — Copy Plan Button & Output Polish ✅ COMPLETE

**Goal:** User can copy the full plan from the UI.

### Changed files
| File | What changed |
|------|-------------|
| `web-app/src/stores/code-mode-store.ts` | Added `plan_stage` to `AgentOutputLine['type']` |
| `web-app/src/containers/CodeModePanel.tsx` | Added `copied` state; added `handleCopyPlan` callback; added "Copy Plan" button in `output-controls` (visible when architect stage is done); updated `plan-stage-progress` listener to `appendOutput` for visibility; updated `OutputLine` to render `plan_stage` type and improved `done` type styling; improved `StageStep` with `tabler-icons` and refined styling; added `IconCheck`, `IconLoader2`, `IconAlertTriangle`, `IconCircle`, `IconPlayerSkipForward` imports |
| `web-app/src/locales/en/code-mode.json` | Added `copyPlan`, `planCopied` |
| `web-app/src/locales/he/code-mode.json` | Added `copyPlan`, `planCopied` |

### Behaviour
- "Copy Plan" button appears prominently (primary color) after the architect stage finishes
- Clicking "Copy Plan" extracts only `assistant` messages and copies to clipboard with "Copied!" feedback
- Each pipeline stage transition is now appended to the output log as a discrete `plan_stage` line
- Stage progress bar has more refined icons, animations (pulse/spin), and color states

### Verification results
- [x] `yarn tsc --noEmit` — passed
- [x] `cargo check` — passed
- [ ] After pipeline completes, "Copy Plan" button is visible — pending runtime test
- [ ] Clicking it copies the Markdown to clipboard — pending runtime test
- [ ] Stage progress indicator shows all 4 steps with correct icons — pending runtime test

## Phase 6 — Pre-flight Check & Error Handling ✅ COMPLETE

**Goal:** Clear error messages for all failure cases. Nothing should silently fail.

### Changed files
| File | What changed |
|------|-------------|
| `src-tauri/src/core/plan_agent.rs` | Added `check_ollama_health` (HTTP health check); added `is_expo_project` helper; updated `run_plan_pipeline` with Expo validation warning; added Stage 1 timeout (2 min); added Stage 4 `claude` binary check with descriptive error |
| `src-tauri/src/core/code_agent.rs` | Added `find_claude_binary` (checks PATH + known macOS/nvm/volta locations); exported `find_ollama_binary` and `find_claude_binary` |
| `src-tauri/src/lib.rs` | Registered `check_ollama_health` |
| `web-app/src/containers/CodeModePanel.tsx` | Added `checkOllama` pre-flight check on mount/mode change; added `ollamaError` banner with "Check again" button; disabled textarea/send when Ollama is unavailable; added `IconAlertCircle`, `IconRefresh` imports |
| `web-app/src/locales/en/code-mode.json` | Added `ollamaNotRunning` |
| `web-app/src/locales/he/code-mode.json` | Added `ollamaNotRunning` |

### Behaviour
- Opening Plan Mode triggers a health check of the Ollama daemon
- If Ollama binary is missing or daemon is not responding, a prominent error banner appears and input is blocked
- "Check again" allows the user to retry after starting Ollama manually
- Selecting a non-Expo folder shows a non-blocking warning in the output log
- Clear error messages if `claude-code` is not installed globally

### Verification results
- [x] `yarn tsc --noEmit` — passed
- [x] `cargo check` — passed
- [ ] Running without Ollama shows error banner — pending runtime test
- [ ] Non-Expo project shows warning detail — pending runtime test

## Phase 7 — Final Cleanup & i18n ✅ COMPLETE

**Goal:** Polish, consistency, Hebrew strings.

### Changed files
| File | What changed |
|------|-------------|
| `web-app/src/locales/he/code-mode.json` | Updated Hebrew translations; renamed "Code Mode" to "Plan Mode" contextually; removed obsolete keys |
| `web-app/src/locales/en/code-mode.json` | Updated "Code Mode" to "Plan Mode" where appropriate; removed obsolete keys (`askPermissions`, `diffSnapshotTitle`, etc.) |
| `web-app/src/containers/PermissionModeSelector.tsx` | **Deleted** (dead code) |
| `web-app/src/components/CodeModelSelector.tsx` | **Deleted** (dead code) |
| `web-app/src/components/CodeModeStoreTest.tsx` | Renamed to "Plan Mode Store Test" |
| `web-app/src/stores/code-mode-store.ts` | Added `onRehydrateStorage` migration to coerce `'code'` mode to `'plan'` |
| `src-tauri/src/core/plan_agent.rs` | Added unit tests for workspace validation and Expo project detection |
| `README.md` | Updated Status and Modes sections to reflect the move to Plan Mode |

### Verification results
- [x] `cargo check` — passed
- [x] `cargo test core::plan_agent::tests` — passed
- [x] All "Code Mode" specific UI components removed
- [x] Persisted state migration verified (via code review)

## Phase 8 — Gemini CLI Primary + Ollama Fallback ⬜ NOT STARTED

## Phase 8 — Gemini CLI Primary + Ollama Fallback ⬜ NOT STARTED
