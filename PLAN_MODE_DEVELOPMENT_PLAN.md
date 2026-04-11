# Plan Mode — Development Plan
## Atomic Chat: Code Mode → Planning Pipeline

> **Goal:** Transform the existing "Code Mode" (which runs `ollama launch claude` as an
> agentic coder) into a **pure planning tool**. The user describes a bug or feature
> (in Hebrew or English), optionally attaches a screenshot, and the pipeline produces a
> structured Markdown execution plan. **No project files are modified and no write-capable shell/tool execution inside the target project is allowed.**
>
> The generated plan is displayed in the panel and can be copied to the clipboard.
> The user then takes it and runs it elsewhere (e.g. another Claude Code session, a
> separate coding agent, or manual review).

---

## 1. Current State (What Exists)

| File | Role | Kept / Changed |
|------|------|----------------|
| `web-app/src/containers/CodeModePanel.tsx` | Main UI panel (833 lines) | **Heavily modified** |
| `web-app/src/stores/code-mode-store.ts` | Zustand store with `AppMode = 'chat' \| 'code'` | **Modified** |
| `web-app/src/components/CodeModelSelector.tsx` | Model picker dropdown | **Removed from Plan Mode** |
| `web-app/src/containers/PermissionModeSelector.tsx` | ask/auto_accept toggle | **Removed from Plan Mode** |
| `src-tauri/src/core/code_agent.rs` | Spawn/stream `ollama launch claude` | **Extended with pipeline** |
| `src-tauri/src/core/http.rs` | `stream_local_http` command (reqwest) | **Reused for stages 1–3** |
| `src-tauri/src/lib.rs` | Tauri command registration | **Updated** |
| `web-app/src/locales/en/code-mode.json` | i18n strings | **Updated** |
| `web-app/src/locales/he/code-mode.json` | i18n strings (Hebrew) | **Updated** |
| `web-app/src/routes/index.tsx` | `ModeToggle` + layout | **Updated (rename mode key)** |

---

## 2. What Changes at a High Level

| Area | Before | After |
|------|--------|-------|
| Mode name | `'code'` (agentic coder) | `'plan'` (planner only) |
| Model selector in UI | User picks from Ollama models | **No model selector** — models are config-only |
| Permission selector | `ask / auto_accept` toggle | **Removed** — always read-only |
| Run action | Spawns `ollama launch claude` (writes code) | Runs 4-stage pipeline, outputs Markdown plan |
| Image support | None | Drag-and-drop image into prompt area |
| Output | Streaming code agent actions | Streaming Markdown plan + stage progress |
| Copy output | Partial | **Full plan copy button** |
| Diff snapshot | Shows file write diffs | **Removed** (no writes happen) |

---

## 3. Pipeline Architecture

```
User clicks RUN
      │
      ▼
┌─ Stage 1: Translate ─────────────────────────────────────────────────┐
│  Rust → POST http://localhost:11434/v1/chat/completions              │
│  Model: TRANSLATOR_MODEL (qwen2.5:14b-instruct-q5_K_M)              │
│  Input: raw user prompt (Hebrew or English)                          │
│  Output: English technical description                               │
│  Emits: plan-stage-progress { stage: "translate", status: "done" }  │
└──────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─ Stage 2: Vision (CONDITIONAL — only if image was attached) ─────────┐
│  Rust → POST http://localhost:11434/v1/chat/completions              │
│  Model: VISION_MODEL (qwen2.5vl:7b)                         │
│  Input: base64 image + translated prompt                             │
│  Output: text description of UI state / visible issue               │
│  Emits: plan-stage-progress { stage: "vision", status: "done|skipped" }│
└──────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─ Stage 3: Navigate ──────────────────────────────────────────────────┐
│  Rust filesystem scan → file tree (max 150 lines)                   │
│  Detect explicit file paths mentioned in translated prompt           │
│  Rust → POST http://localhost:11434/v1/chat/completions              │
│  Model: NAVIGATOR_MODEL (qwen3.5:35b-a3b-q4_K_M)                   │
│  Input: file tree + translated prompt                                │
│  Output: JSON array of 3–5 relative file paths                      │
│  Emits: plan-stage-progress { stage: "navigate", status: "done" }   │
└──────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─ Stage 4: Architect (ollama launch claude — READ-ONLY) ──────────────┐
│  ollama launch claude                                                │
│    --model ARCHITECT_MODEL (qwen3.5:35b-a3b-q4_K_M)                 │
│    -- -p                                                             │
│       --output-format stream-json                                    │
│       --verbose                                                      │
│       --allowedTools "Read,LS,Glob,Grep"                            │
│       --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch" │
│       "{MEGA_PROMPT}"                                                │
│                                                                      │
│  Reuses existing streaming infrastructure:                           │
│    stdout → code-agent-output events → frontend renders             │
│    done   → code-agent-done event                                    │
│                                                                      │
│  Output: streaming Markdown execution plan                           │
└──────────────────────────────────────────────────────────────────────┘
      │
      ▼
   Plan displayed in panel with [Copy Plan] button
```

### Why `ollama launch claude` for Stage 4 only

Stages 1–3 are simple inference tasks (text-in, text-out). Direct Ollama API calls
(`POST /v1/chat/completions`) are sufficient, fast, and deterministic.

Stage 4 (Architect) benefits from the **Claude Code agent loop** because:
- It can **autonomously navigate the Expo project** — reading more files than
  the navigator pre-selected if it decides they are relevant.
- It produces a plan **grounded in actual code** (real function names, real line
  numbers, real import paths) rather than a generic template.
- Using `--allowedTools "Read,LS,Glob,Grep"` + `--disallowedTools "Write,Edit,MultiEdit,NotebookEdit,Bash"`
  ensures it is **physically incapable** of modifying the project.

---

## 4. Model Configuration

Models are **not configurable from the UI**. Advanced users can override them by
editing a TOML config file. The application reads defaults from bundled resources
and merges user overrides at startup.

### 4.1 Default config (bundled in app)

**File:** `src-tauri/resources/planner-config.toml`

```toml
# Planner pipeline model configuration.
# To override, copy this file to:
#   macOS: ~/Library/Application Support/chat.atomic.app/planner-config.toml
# Changes take effect after restarting the app.

[models]
translator  = "qwen2.5:14b-instruct-q5_K_M"
vision      = "qwen2.5vl:7b"
navigator   = "qwen3.5:35b-a3b-q4_K_M"
architect   = "qwen3.5:35b-a3b-q4_K_M"

[ollama]
base_url         = "http://localhost:11434"
api_path         = "/v1/chat/completions"
request_timeout_ms = 120000
max_retries      = 2

[pipeline]
max_file_tree_lines  = 150
max_context_tokens   = 32000
```

### 4.2 Config loading in Rust

New file: `src-tauri/src/core/planner_config.rs`

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelConfig {
    pub translator: String,
    pub vision:     String,
    pub navigator:  String,
    pub architect:  String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OllamaConfig {
    pub base_url:            String,
    pub api_path:            String,
    pub request_timeout_ms:  u64,
    pub max_retries:         u8,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineConfig {
    pub max_file_tree_lines: usize,
    pub max_context_tokens:  usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlannerConfig {
    pub models:   ModelConfig,
    pub ollama:   OllamaConfig,
    pub pipeline: PipelineConfig,
}

impl PlannerConfig {
    /// Load config: user override first, fall back to bundled default.
    pub fn load(app_handle: &tauri::AppHandle) -> Self {
        // 1. Try user override at app_config_dir/planner-config.toml
        // 2. Fall back to bundled resource_dir/resources/planner-config.toml
        // 3. If both fail, use hardcoded defaults
        // (implementation: toml::from_str on file contents)
    }
}

#[tauri::command]
pub fn get_planner_config(app: tauri::AppHandle) -> Result<PlannerConfig, String> {
    Ok(PlannerConfig::load(&app))
}
```

---

## 5. Tauri Events (Rust → Frontend)

### Existing events (unchanged — reused for Stage 4)
| Event | Payload | Used for |
|-------|---------|---------|
| `code-agent-output` | `{ line: String }` | Stage 4 streaming NDJSON |
| `code-agent-done` | `{ exit_code, success }` | Pipeline completion |
| `code-agent-error` | `{ message }` | Fatal errors |

### New events (pipeline progress)
| Event | Payload | Used for |
|-------|---------|---------|
| `plan-stage-progress` | `{ stage: "translate"\|"vision"\|"navigate"\|"architect", status: "running"\|"done"\|"skipped"\|"warning"\|"fallback"\|"error", detail?: String }` | Progress indicator + non-fatal warnings/fallbacks |

---

## 6. New Tauri Command

Add to `src-tauri/src/core/code_agent.rs` (or a new `plan_agent.rs` extracted from it):

```rust
#[tauri::command]
pub async fn run_plan_pipeline<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,   // reuse existing state for process tracking
    project_dir: String,
    prompt: String,
    image_path: Option<String>,         // None if no image attached
) -> Result<(), String>
```

### Internal flow of `run_plan_pipeline`:

```
1. validate_workspace(&project_dir)           // existing helper
2. check_not_root()                            // existing helper
3. Guard: no pipeline already running          // dedicated running flag, not only child process check

4. STAGE 1 — Translate
   app.emit("plan-stage-progress", { stage: "translate", status: "running" })
   POST /v1/chat/completions → translator model
   → translated: String
   app.emit("plan-stage-progress", { stage: "translate", status: "done", detail: translated.clone() })

5. STAGE 2 — Vision (only if image_path.is_some())
   if let Some(img) = &image_path {
     app.emit("plan-stage-progress", { stage: "vision", status: "running" })
     base64_encode(img)
     POST /v1/chat/completions (with image in content array) → vision model
     → vision_analysis: String
     app.emit("plan-stage-progress", { stage: "vision", status: "done" })
   } else {
     app.emit("plan-stage-progress", { stage: "vision", status: "skipped" })
     vision_analysis = "N/A".to_string()
   }

6. STAGE 3 — Navigate
   app.emit("plan-stage-progress", { stage: "navigate", status: "running" })
   scan_file_tree(&project_dir, max_lines)   // new helper in plan_agent.rs
   detect_explicit_paths(&translated)        // regex scan for path-like strings
   POST /v1/chat/completions → navigator model
   → file_hints: Vec<String>  (JSON array parsed from response)
   app.emit("plan-stage-progress", { stage: "navigate", status: "done",
            detail: file_hints.join(", ") })

7. STAGE 4 — Architect (ollama launch claude, read-only)
   app.emit("plan-stage-progress", { stage: "architect", status: "running" })
   build_mega_prompt(translated, vision_analysis, file_hints, project_dir)
   spawn ollama launch claude
     --model architect_model
     -- -p --output-format stream-json --verbose
        --allowedTools "Read,LS,Glob,Grep"
        --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch"
        "{mega_prompt}"
   Store child in state.child (same as before)
   Stream stdout → app.emit("code-agent-output", ...) (identical to today)
   On process exit success → app.emit("plan-stage-progress", { stage: "architect", status: "done" })
```

---

## 7. Mega-Prompt Template (Stage 4)

```
You are a senior software architect and React Native / Expo specialist.

Your ONLY task is to analyze the Expo project located at:
  {project_dir}

Then produce a detailed, step-by-step Markdown execution plan.

══ STRICT RULES ══
- DO NOT write, create, edit, or delete any files.
- DO NOT run shell commands, npm scripts, or git operations.
- DO NOT commit, stage, or touch the git repository in any way.
- Your ENTIRE output must be a structured Markdown plan.
- You MAY use Read, LS, Glob, and Grep as much as needed to understand the code.

══ CONTEXT ══
Task (English):
{translated_prompt}

Visual analysis of emulator screenshot:
{vision_analysis}

Navigator suggests starting from these files:
{file_hints}

══ OUTPUT FORMAT ══
# Execution Plan: [short title]

## Summary
[2–3 sentences describing what needs to change and why]

## Affected Files
[list of files that will need changes, with brief reason for each]

## Implementation Steps
### Step 1: [...]
**File:** `path/to/file.tsx`
**Change:** [exact description of what to change and where]
**Reason:** [why this change is needed]

[repeat for each step]

## Testing Steps
[how to verify the implementation is correct]

## Risks & Notes
[edge cases, dependencies, gotchas]
```

---

## 8. Store Changes (`code-mode-store.ts`)

### Remove
```typescript
codeModel: string
availableCodeModels: string[]
setCodeModel: (model: string) => void
setAvailableCodeModels: (models: string[]) => void
permissionMode: 'ask' | 'auto_accept'
setPermissionMode: (mode: ...) => void
```

### Add
```typescript
attachedImagePath: string | null           // path of dropped image, or null
setAttachedImagePath: (p: string | null) => void

// New output line types for stage progress
// Add to AgentOutputLine['type']:
// | 'plan_stage'
```

### Rename
```typescript
AppMode: 'chat' | 'code'  →  AppMode: 'chat' | 'plan'
```

### Keep unchanged
```typescript
mode, projectDir, draftPrompt, lastVisionResult
isAgentRunning, agentOutput, appendOutput, clearOutput, persistOutput
setAgentRunning, setMode, setProjectDir, setDraftPrompt, setVisionResult
```

---

## 9. Frontend Changes (`CodeModePanel.tsx`)

### Remove
- `<CodeModelSelector />` and all model-related state/effects
- `<PermissionModeSelector />` and all permission-related state/effects
- `handlePullModel` callback
- `diff_snapshot` event listener (line ~256–268)
- `isPullingModel` / `pullStatus` state
- `ollamaStatus` onboarding checks (replace with simpler Ollama pre-flight)
- Rendering of `diff_snapshot` output type

### Add
1. **Image drop zone** — in the prompt textarea area:
   ```tsx
   // onDragOver, onDrop handlers on the textarea wrapper div
   // Accept: image/png, image/jpeg, image/webp
   // On drop: read file.path from dataTransfer items/files (Tauri non-standard File.path)
   // (no new invoke command required)
   // Show: small thumbnail or filename pill with an ✕ to clear
   ```

2. **Stage progress bar** — above the output area:
   ```tsx
   // Listen to 'plan-stage-progress' events
   // Show 4 steps: [Translate] → [Vision] → [Navigate] → [Planning...]
   // Each step shows ⏳ / ✅ / ⏭ (skipped)
   ```

3. **Copy Plan button** — only visible after agent completes:
   ```tsx
   // Extract all AgentOutputLine where type === 'assistant'
   // Join their content and copy to clipboard
   // Label: t('code-mode:copyPlan')
   ```

### Change
- `handleSend` → calls `invoke('run_plan_pipeline', { projectDir, prompt, imagePath })`
  instead of `invoke('spawn_code_agent', ...)`
- `handleStop` → still calls `invoke('stop_code_agent')` (process kill, unchanged)
- Remove `codeModel` guard in `handleSend` (no model to check)
- Remove `if (!codeModel)` error — replace with Ollama running check

### Keep
- `StickToBottom` scroll behavior
- Tool/thinking/assistant output rendering (Stage 4 emits the same NDJSON)
- `handleSelectFolder` (project dir picker)
- `code-agent-output` / `code-agent-done` / `code-agent-error` event listeners
- Keep plain `assistant` line fallback parsing for non-NDJSON outputs (needed for future Gemini fallback path)

---

## 10. Routes Change (`web-app/src/routes/index.tsx`)

```typescript
// Before
const modes = [
  { key: 'chat', label: t('code-mode:chatMode') },
  { key: 'code', label: t('code-mode:codeMode') },
]

// After
const modes = [
  { key: 'chat',  label: t('code-mode:chatMode') },
  { key: 'plan',  label: t('code-mode:planMode') },
]
```

The conditional rendering at line ~148:
```typescript
// Before
{mode === 'code' && <CodeModePanel />}

// After
{mode === 'plan' && <CodeModePanel />}
```

---

## 11. i18n Changes

### `en/code-mode.json` — add/rename keys (keep existing namespace to avoid broad i18n regression)

```json
{
  "chatMode": "Chat",
  "planMode": "Plan",
  "planModeTitle": "Plan Mode",
  "runPipeline": "Run",
  "stopPipeline": "Stop",
  "noProjectSelected": "No project folder selected. Choose an Expo project first.",
  "copyPlan": "Copy Plan",
  "planCopied": "Copied!",
  "dropImageHere": "Drop screenshot here",
  "removeImage": "Remove image",
  "ollamaRequired": "Ollama is required for Plan Mode",
  "stageTranslate": "Translating",
  "stageVision": "Analyzing screenshot",
  "stageNavigate": "Scanning project",
  "stagePlanning": "Planning...",
  "stageDone": "Plan ready",
  "stageSkipped": "Skipped"
}
```

---

## 12. Development Phases

> **Rule:** Each phase ends with a verification checklist. Do NOT start the next phase
> without completing the current phase's checklist. One phase at a time.

---

### Phase 0 — Audit & Mode Rename
**Goal:** Rename the mode and strip code-execution features from the UI.
No new functionality added yet.

**Tasks:**
1. In `code-mode-store.ts`:
   - Change `AppMode = 'chat' | 'code'` → `'chat' | 'plan'`
   - Remove `codeModel`, `availableCodeModels`, `permissionMode` and their setters
   - Add `attachedImagePath: string | null` + `setAttachedImagePath`
   - Update `partialize` accordingly
2. In `routes/index.tsx`:
   - Change mode keys `'code'` → `'plan'`
   - Update labels to use `code-mode` namespace keys (`chatMode`, `planMode`)
   - Remove `CodeModelSelector` usage + `codeModel` store selectors
   - Update switch-stop logic to stop when leaving `'plan'` (not `'code'`)
3. In `CodeModePanel.tsx`:
   - Remove `<CodeModelSelector />`
   - Remove `<PermissionModeSelector />`
   - Remove `handlePullModel`, `isPullingModel`, `pullStatus`
   - Remove `ollamaStatus` state and its `useEffect`
   - Remove `diff_snapshot` listener and rendering
   - Keep `handleSend` functional by wiring it to `run_plan_pipeline` (or temporary backend stub), do not leave TODO/no-op UI paths
4. Update auxiliary references that still depend on removed store fields:
   - `web-app/src/components/CodeModeStoreTest.tsx`
   - Any `mode === 'code'` checks outside `routes/index.tsx`
5. Update `en/code-mode.json` and `he/code-mode.json` with new keys

**Verification:**
- [ ] App compiles without errors (`yarn dev:web`)
- [ ] Mode toggle shows "Chat | Plan"
- [ ] Plan Mode panel opens without crashing
- [ ] No TypeScript errors related to removed fields
- [ ] Chat Mode is completely unaffected

---

### Phase 1 — Config System
**Goal:** Bundled `planner-config.toml` is readable from Rust and exposed to frontend.

**Tasks:**
1. Create `src-tauri/resources/planner-config.toml` with defaults from Section 4.1
2. Ensure `tauri.conf.json` includes the resource (check `bundle.resources`)
3. Create `src-tauri/src/core/planner_config.rs` with `PlannerConfig` struct (Section 4.2)
4. Add `toml` crate dependency (`Cargo.toml`) for parsing planner config
5. Add `get_planner_config` Tauri command
6. Register command in `lib.rs` (desktop invoke handler)
7. (Optional) Add a small frontend config display in Plan Mode footer for debugging

**Verification:**
- [ ] `cargo check` passes
- [ ] `invoke('get_planner_config')` returns valid JSON with model names
- [ ] Editing `planner-config.toml` and restarting app picks up new values
- [ ] Bundled build reads from `resource_dir/resources/planner-config.toml` (not source path)

---

### Phase 2 — Image Drop Zone
**Goal:** User can drag a screenshot PNG/JPG into the prompt area.

**Tasks:**
1. In `CodeModePanel.tsx`:
   - Add `onDragOver`, `onDrop` handlers to the textarea wrapper `<div>`
   - Use path extraction from drop event (`File.path`) to get absolute file path
   - Call `setAttachedImagePath(path)` on successful drop
   - Show image preview: small thumbnail below the textarea with an ✕ clear button
   - Show a dashed border on drag-over
2. Validate: only accept `image/png`, `image/jpeg`, `image/webp` — show error for other types

**Implementation note for file path from drop:**
```typescript
// In onDrop handler:
const files = event.dataTransfer.files
if (files.length > 0) {
  const file = files[0]
  // In Tauri, File objects from drop events expose .path (non-standard)
  const path = (file as any).path as string | undefined
  if (path) setAttachedImagePath(path)
}
```

**Verification:**
- [ ] Dragging a PNG from Finder into the textarea shows a thumbnail
- [ ] The ✕ button clears the image
- [ ] Non-image files show an error message (no crash)
- [ ] Image path is stored in the store correctly

---

### Phase 3 — Rust Pipeline: Stages 1–3
**Goal:** Implement the pre-processing pipeline (Translate → Vision → Navigate)
as HTTP calls to Ollama. No `ollama launch claude` yet.

**Tasks:**

1. Add `plan_agent.rs` (or extend `code_agent.rs`) with these helpers:
   - `ollama_chat(config: &OllamaConfig, model: &str, messages: Vec<Message>, timeout_ms: u64) → Result<String, String>`
     Uses `reqwest::Client` (already in `Cargo.toml`)
   - `ollama_chat_with_image(config, model, prompt, image_path) → Result<String, String>`
     Reads file, base64-encodes it, sends multimodal message
   - `scan_file_tree(project_dir, max_lines) → String`
     Walks directory recursively (prefer `std::fs` to minimize new deps), skips `node_modules`,
     `.git`, `target`, `dist`, `.expo` — returns tree string
   - `detect_explicit_paths(text) → Vec<String>`
     Heuristic path scan (or `regex` crate if explicitly added): look for patterns like `src/...`, `./...`, `components/...`

2. Implement `run_plan_pipeline` command (stub first, then fill stages):
   - Add a dedicated pipeline-running guard in shared state (do not rely only on `state.child`)
   - Stage 1: call `ollama_chat` with translator model + system prompt
   - Stage 2: call `ollama_chat_with_image` if `image_path.is_some()`
   - Stage 3: call `ollama_chat` with navigator model + file tree
     Parse JSON array from response (robust: try `serde_json::from_str`, on failure
     extract first `[...]` substring)
   - If pipeline intentionally stops at Stage 3 in this phase, emit `code-agent-done` and clear running flag so UI does not stay stuck

3. Register `run_plan_pipeline` in `lib.rs`

4. In `CodeModePanel.tsx`, update `handleSend` to call `run_plan_pipeline`

5. Add `plan-stage-progress` event listener in `CodeModePanel.tsx`:
   ```typescript
   listen<PlanStageProgressEvent>('plan-stage-progress', (event) => {
     // Update stage progress state
   })
   ```

6. Add stage progress UI component (4 steps):
   ```
   [✅ Translate] → [✅ Vision] → [⏳ Navigate] → [○ Planning]
   ```

**Verification:**
- [ ] Clicking Run with a Hebrew prompt shows "Translating..." progress
- [ ] Stage 1 completes → "Translated: ..." appears in stage bar
- [ ] Stage 2 runs if image attached, shows "Analyzing screenshot..."
- [ ] Stage 2 skipped (⏭) if no image
- [ ] Stage 3 completes → shows "Found: src/screens/..., src/components/..."
- [ ] No Stage 4 yet — pipeline stops after Stage 3 with a log message
- [ ] `cargo check` passes cleanly

---

### Phase 4 — Rust Pipeline: Stage 4 (Architect)
**Goal:** Launch `ollama launch claude` read-only to generate the plan.

**Tasks:**

1. In `run_plan_pipeline`, after Stage 3:
   - Build mega-prompt using template from Section 7
   - Spawn `ollama launch claude` with:
     ```
     --model {architect_model}
     -- -p
        --output-format stream-json
        --verbose
        --allowedTools "Read,LS,Glob,Grep"
        --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch"
        "{mega_prompt}"
     ```
   - Reuse the existing PATH extension logic (nvm/volta dirs) from `spawn_code_agent`
   - Store child in `state.child` (same `CodeAgentState`)
   - Emit `plan-stage-progress` for architect (`running`/`done`/`error`)
   - Stream stdout → `code-agent-output` events (identical to today)
   - On process exit → `code-agent-done` event (identical to today)

2. **Important**: The mega-prompt contains the project path so the architect agent
   knows where to look. It must be a non-interactive `-p` call so it runs to
   completion without waiting for stdin.

3. Verify `--allowedTools` is properly scoped: test that the agent reads files but
   cannot write them.
4. On fatal failures in any stage, emit both:
   - `code-agent-error` with user-facing message
   - `code-agent-done` with `success: false` to guarantee frontend state cleanup

**Verification:**
- [ ] Full pipeline runs end-to-end: Translate → Vision → Navigate → Planning
- [ ] Stage 4 output streams into the panel (tool_use bubbles showing file reads, thinking, then plan text)
- [ ] Stop button cancels the architect agent mid-run
- [ ] No files are created or modified in the Expo project during a run
- [ ] `git status` on the Expo project shows zero changes after a run

---

### Phase 5 — Copy Plan Button & Output Polish
**Goal:** User can copy the full plan from the UI.

**Tasks:**

1. Add a "Copy Plan" button that appears **only after `code-agent-done` fires with `success: true`**
2. Button logic:
   ```typescript
   const handleCopyPlan = () => {
     const planText = agentOutput
       .filter(line => line.type === 'assistant')
       .map(line => line.content)
       .join('\n\n')
     navigator.clipboard.writeText(planText)
     // Show brief "Copied!" confirmation
   }
   ```
3. Style the copy button prominently (not just an icon — a visible labeled button)
4. Add stage progress indicator (from Phase 3) finalized with proper styling
5. If stage transitions should appear in the output log, do **not** use hidden `system` rows.
   Choose one:
   - Render `system` rows visibly in `OutputLine`, or
   - Append visible assistant/status rows for stage transitions

**Verification:**
- [ ] After pipeline completes, "Copy Plan" button is visible
- [ ] Clicking it copies the Markdown to clipboard (verify with paste)
- [ ] Button is NOT shown while pipeline is still running
- [ ] Stage progress indicator shows all 4 steps with correct ✅ / ⏭ / ⏳ states

---

### Phase 6 — Pre-flight Check & Error Handling
**Goal:** Clear error messages for all failure cases. Nothing should silently fail.

**Tasks:**

1. Pre-flight check when Plan Mode opens (`useEffect` on `mode === 'plan'`):
   - `invoke('check_ollama')` verifies binary exists/version
   - Add `invoke('check_ollama_health')` (new command) to verify daemon responds (e.g. `/api/tags` or `/v1/models`)
   - If binary missing: show install banner
   - If binary exists but daemon unavailable: show "Ollama is not running"
   - No model availability check in UI (user manages models via CLI)

2. Error cases to handle explicitly:
   | Error | User message |
   |-------|-------------|
   | Ollama not running | "Ollama is not running. Start it with: `ollama serve`" |
   | Stage 1 timeout | "Translation timed out. Is Ollama responding?" |
   | Stage 2 — image unreadable | "Could not read image file. Try dragging the screenshot again." |
   | Stage 3 — invalid JSON from navigator | Logged to console; pipeline continues with empty hints |
   | Stage 4 — `ollama launch claude` not found | "Claude Code CLI not found. Run: `npm i -g @anthropic-ai/claude-code`" |
   | Stage 4 — architect timeout | "Planning timed out. The model may need more time — try again." |
   | Project dir not an Expo project | Warning only: "Expo markers not found (`app.json` / `app.config.js` / expo dep). Plan quality may be lower." |

3. Expo project validation in Rust (inside `run_plan_pipeline`):
   ```rust
   // Warn (do not abort) if these are missing:
   // - app.json or app.config.js
   // - package.json with "expo" dependency
   // Emit a plan-stage-progress "warning" detail if not Expo project
   ```

**Verification:**
- [ ] Running without Ollama shows clear error banner
- [ ] Running without a project folder shows inline error
- [ ] Selecting a non-Expo folder shows a warning (but does not block the run)
- [ ] All stage errors display human-readable messages (no raw Rust errors)

---

### Phase 7 — Final Cleanup & i18n
**Goal:** Polish, consistency, Hebrew strings.

**Tasks:**
1. Update `he/code-mode.json` with Hebrew translations of all new keys
2. Remove dead code left from old Code Mode (any remaining refs to `codeModel`,
   `permissionMode`, `diff_snapshot`, `pull_ollama_model` in the frontend)
3. Update `README.md` Status section: replace "Code Mode (agentic coding)" with
   "Plan Mode (development planning)"
4. Add persisted-state migration guard:
   - If persisted `mode === 'code'`, coerce to `'plan'` on hydration
   - Remove stale persisted keys (`codeModel`, `permissionMode`) safely
5. Add minimal test: verify `run_plan_pipeline` returns an error for a non-existent
   project directory

**Verification:**
- [ ] No TypeScript `any` warnings introduced
- [ ] `yarn lint` passes
- [ ] `cargo check` passes
- [ ] App runs in Hebrew locale with no missing i18n keys
- [ ] README reflects the new feature correctly

---

### Phase 8 — Gemini CLI Primary + Ollama Fallback (Stage 4)
**Goal:** Use Gemini CLI as the primary architect engine.
If Gemini is unavailable or fails, fall back transparently to `ollama launch claude`.
Keep the same product invariant: no project file modifications.

> **Why Phase 8 (last):** Phases 1–7 deliver a fully working product using the Ollama
> path. Phase 8 upgrades Stage 4 to a cloud model without touching any other phase.
> The pattern is validated — see `PromptMasterAiAgentIOS/src/PromptMaster.Core/Services/GeminiCliService.cs`.

---

#### 8.1 — How Gemini CLI Works (Reference Implementation)

Use non-interactive command execution from the selected project directory:

```bash
gemini -y --include-directories {projectRoot} -p '{prompt}' -o text
```

Key flags:
| Flag | Meaning |
|------|---------|
| `-y` | YOLO mode — auto-accepts all tool uses (no interactive prompts) |
| `--include-directories {dir}` | Grants the agent file-system access to this directory |
| `-p '{prompt}'` | Non-interactive single-prompt mode |
| `-o text` | Output is **plain text**, not JSON/NDJSON |

Output is **plain text** (the plan as Markdown). Much simpler to render than `ollama launch claude`'s NDJSON.

---

#### 8.2 — Thinking Budget via `~/.gemini/settings.json`

There is no `--thinking-budget` CLI flag in Gemini CLI. The only way to set
`thinkingBudget: 32768` (maximum) is via a `settings.json` config file.

**Solution:** Write the settings file to the **user's home directory** (`~/.gemini/`),
not to the Expo project. This restores full thinking budget control without touching
the target project at all.

```rust
async fn ensure_gemini_user_config() -> Result<(), String> {
    let home = dirs::home_dir()
        .ok_or("Cannot resolve home directory")?;
    let gemini_dir = home.join(".gemini");
    tokio::fs::create_dir_all(&gemini_dir).await
        .map_err(|e| format!("Cannot create ~/.gemini: {}", e))?;

    let settings_path = gemini_dir.join("settings.json");

    // Read existing settings or start fresh
    let mut settings: serde_json::Value = if settings_path.exists() {
        let raw = tokio::fs::read_to_string(&settings_path).await
            .unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Patch in planner settings without overwriting existing user values
    settings["thinkingConfig"]["thinkingBudget"] = serde_json::json!(32768);

    tokio::fs::write(&settings_path, serde_json::to_string_pretty(&settings).unwrap())
        .await
        .map_err(|e| format!("Cannot write ~/.gemini/settings.json: {}", e))?;

    Ok(())
}
```

Call `ensure_gemini_user_config().await?` at the start of `run_stage4_gemini`,
before spawning the process.

**Why this is safe:**
- `~/.gemini/` is Gemini CLI's own global config directory — writing there is expected
- The Expo project is never touched
- Existing user settings are preserved (patch, not overwrite)
- If the write fails, return `Err` → fallback to Ollama (no silent degradation)
- Optional environment variables

This keeps Phase 8 aligned with the planner's "no project modifications" contract.

---

#### 8.3 — Rust Implementation

In `plan_agent.rs`, replace Stage 4's direct `spawn ollama launch claude` with:

```rust
async fn run_stage4_architect(
    app: &AppHandle,
    state: &State<'_, CodeAgentState>,
    mega_prompt: &str,
    project_dir: &str,
    config: &PlannerConfig,
) -> Result<(), String> {
    // Try Gemini first
    match run_stage4_gemini(app, state, mega_prompt, project_dir, config).await {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!("[PlanPipeline] Gemini failed ({}), falling back to Ollama", e);
            app.emit("plan-stage-progress", PlanStageEvent {
                stage: "architect",
                status: "fallback",
                detail: Some(format!("Gemini unavailable: {}. Using local model.", e)),
            }).ok();
            run_stage4_ollama(app, state, mega_prompt, project_dir, config).await
        }
    }
}
```

**`run_stage4_gemini`** — spawns Gemini CLI in non-interactive mode:

```rust
async fn run_stage4_gemini(...) -> Result<(), String> {
    // 1. Find gemini binary (check PATH, /usr/local/bin, /opt/homebrew/bin)
    let gemini_bin = find_binary("gemini")
        .ok_or("gemini CLI not found")?;

    // 2. Spawn directly (no project file writes)
    let mut cmd = Command::new(&gemini_bin);
    cmd.current_dir(project_dir);
    cmd.arg("-y")
       .arg("--include-directories").arg(project_dir)
       .arg("-p").arg(mega_prompt)
       .arg("-o").arg("text");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("PATH", build_extended_path()); // same nvm/volta dirs

    // 3. Stream stdout as plain text lines
    //    Each line → emit "code-agent-output" with a synthetic assistant JSON
    //    so the existing frontend event handler renders it correctly:
    //    { "type": "assistant", "message": { "content": [{ "type": "text", "text": line }] } }
    spawn_and_stream_plain_text(cmd, app, state).await
}
```

**`spawn_and_stream_plain_text`** — wraps plain text lines as synthetic NDJSON:

```rust
// The existing frontend already parses:
// { "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }
// So we wrap each plain text line in this envelope → zero frontend changes needed.
let synthetic_json = serde_json::json!({
    "type": "assistant",
    "message": { "content": [{ "type": "text", "text": line }] }
});
app.emit("code-agent-output", CodeAgentOutputEvent {
    line: synthetic_json.to_string()
}).ok();
```

This reuses the **existing frontend rendering** for the `assistant` type —
no frontend changes needed for the Gemini path.

**`run_stage4_ollama`** — the existing Stage 4 implementation from Phase 4, unchanged.

---

#### 8.4 — Fallback Trigger Conditions

**Rule: any non-`Ok` result from `run_stage4_gemini` triggers the Ollama fallback — no exceptions.**

A partial plan is not useful. Better to get a complete plan from the local model than
an incomplete one from Gemini.

| Condition | Fallback triggered |
|-----------|-------------------|
| `gemini` binary not in PATH | ✅ |
| Gemini process exit code ≠ 0 (any reason, even with partial stdout) | ✅ |
| Timeout (>300s) | ✅ |
| Any `Err` from `run_stage4_gemini` | ✅ |

Implementation — `run_stage4_gemini` must return `Err` on any non-zero exit:
```rust
if !status.success() {
    return Err(format!("gemini exited with code {:?}", status.code()));
    // This triggers fallback even when stdout has partial content.
    // Rationale: an incomplete plan is worse than a complete local plan.
}
```

---

#### 8.5 — Output Line Filtering

Strip only stable Gemini CLI banner/noise lines before emitting to frontend:
- `Loaded cached credentials`
- `YOLO mode`
- `Plan mode` / `Entering plan mode`
- `Using model:`

Do **not** strip arbitrary natural-language lines like "I will..." — that can remove real plan content.

---

#### 8.6 — Config Addition

Add to `planner-config.toml`:
```toml
[gemini]
cli_path          = "gemini"             # override if gemini is not in PATH
model             = "gemini-3.1-pro"     # explicit model — REQUIRED.
                                         # Without this, CLI defaults to "Auto (Gemini 3)"
                                         # which may choose gemini-3-flash for "simple" tasks.
                                         # We always want Pro for code planning.
thinking_budget   = 32768               # maximum thinking tokens — written to ~/.gemini/settings.json
                                         # before each run (not to the Expo project)
timeout_ms        = 300000               # 5 min — Pro with max thinking needs more time
enabled           = true                 # set to false to always use Ollama directly
```

**Why `--model` is required here:**
Gemini CLI's default mode is "Auto (Gemini 3)" — it picks between `gemini-3.1-pro` and
`gemini-3-flash` based on what it considers task complexity. Code planning analysis will
sometimes be classified as "simple enough for Flash." Passing `--model gemini-3.1-pro`
bypasses Auto routing and guarantees Pro every time.

Add to `GeminiConfig` Rust struct:
```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GeminiConfig {
    pub cli_path:   String,
    pub model:      String,
    pub timeout_ms: u64,
    pub enabled:    bool,
}
```

Spawn command with explicit model:
```bash
gemini --model {config.gemini.model} -y --include-directories {project_dir} -p '{prompt}' -o text
```

---

#### 8.7 — Write Boundary Summary

| Location | Gemini path writes? | Notes |
|----------|-------------------|-------|
| `{expo_project}/` | ❌ Never | Core contract — no exceptions |
| `~/.gemini/settings.json` | ✅ Yes | Gemini CLI's own global config — safe to write |
| `/tmp/` | ✅ Yes (optional) | Only if temp script needed — cleaned up immediately |

The Expo project is read-only. `~/.gemini/` is Gemini's own directory.

---

#### Phase 8 Verification

- [ ] `gemini -y --include-directories . -p 'hello' -o text` works from terminal in the Expo project
- [ ] Output streams into the panel correctly (plain text wrapped as synthetic NDJSON)
- [ ] Gemini plan uses file:line references from the actual Expo project
- [ ] **Fallback test A — binary missing**: rename `gemini` binary temporarily → run → Ollama path activates with "fallback" notice in the panel
- [ ] **Fallback test B — non-zero exit**: mock `gemini` with a script that prints partial text then exits with code 1 → Ollama fallback triggers (partial output is discarded, not shown)
- [ ] **Fallback test C — timeout**: set `gemini.timeout_ms = 1000` in config → run → timeout triggers fallback within ~1s, no crash
- [ ] **Fallback test D — `gemini.enabled = false`**: set in config → run → Ollama is used directly, no Gemini attempt logged
- [ ] No files are written in the Expo project during any path (verify `git status` after run)

---

## 13. DO / DON'T for the Implementing Agent

**DO:**
- Follow phases strictly. Complete and verify each phase before starting the next.
- Reuse existing infrastructure: `validate_workspace`, `check_not_root`, `CodeAgentState`,
  `find_ollama_binary`, the event system, the `StickToBottom` scroll, the tool/thinking
  rendering in the frontend.
- Use `reqwest::Client` (already in `Cargo.toml`) for Ollama API calls in Stages 1–3.
- Log each stage start/end with `log::info!("[PlanPipeline] Stage N: ...")`.
- Use the existing `plan-stage-progress` events to keep the UI responsive during
  the slow Stage 1–3 calls.

**DON'T:**
- Do NOT add a model selector to the UI. Models are config-only.
- Do NOT add a permission mode toggle. Stage 4 is always read-only via `--allowedTools`.
- Do NOT remove `spawn_code_agent` from `code_agent.rs` without confirming it is
  no longer referenced anywhere.
- Do NOT send the mega-prompt to Stage 4 without the explicit "DO NOT WRITE FILES"
  instructions — the system prompt is the safety layer alongside `--allowedTools`.
- Do NOT block the Tauri main thread during HTTP calls — all `reqwest` calls must be
  `.await`ed inside `async` commands.
- Do NOT hardcode model names in Rust source code — always read from `PlannerConfig`.
- Do NOT execute multiple phases at once. Wait for explicit user instruction and
  verification before proceeding to the next phase.
