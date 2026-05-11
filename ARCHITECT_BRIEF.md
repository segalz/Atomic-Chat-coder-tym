# Architect Brief: Atomic Chat → AI Coding Desktop Tool

**Date**: April 17, 2026  
**Author**: Product Owner (for Software Architect Agent + Deep Research Agent)  
**Status**: RESET — Previous Plan Mode direction is being abandoned. See §4.

---

## 1. Vision & Primary Goal

Transform **Atomic Chat** into a **local-first AI coding desktop tool** comparable to:
- [Codex Desktop](https://openai.com/codex) (OpenAI's offline coding agent)
- [Claude Code Desktop](https://claude.ai/code) (Anthropic's native IDE agent)

But with capabilities **neither of those tools has**:
1. **Android emulator screenshot analysis** — the agent sees your running app visually, links it to source code, and proposes code changes.
2. **Full local inference** — no mandatory cloud dependency; runs on Apple Silicon via MLX, LLaMA.cpp, Foundation Models, or Ollama.
3. **Gemini CLI integration** — leverage Gemini Pro's deep reasoning / thinking budget as the architect stage.
4. **Drag-and-drop image context** — drag any screenshot (emulator, device, Figma export) into the prompt.
5. **Unified planning + execution** — plan first (read-only), then execute (with user approval per step).

---

## 2. What We Have Right Now

### 2.1 Platform (Production-Quality)
| Layer | Technology | Status |
|---|---|---|
| Desktop shell | Tauri 2.7 (macOS, iOS, Android) | ✅ Stable |
| Frontend | React 19 + TypeScript 5.8 + Vite + Zustand | ✅ Stable |
| Backend | Rust (Tokio, rmcp 0.8.5) | ✅ Stable |
| Local LLM: Apple Silicon | MLX (custom Tauri plugin + Swift server) | ✅ Working |
| Local LLM: CPU | LLaMA.cpp (Tauri plugin) | ✅ Working |
| Local LLM: macOS native | Foundation Models (Tauri plugin) | ✅ Working |
| Local LLM: server | Ollama client | ✅ Working |
| Cloud AI SDK | Anthropic, OpenAI, xAI, OpenAI-compatible | ✅ Working |
| MCP client | Full SSE/HTTP/child-process transports | ✅ Working |
| OpenAI-compatible local API | `localhost:1337/v1` | ✅ Working |
| RAG + Vector DB | Tauri plugins (rag, vector-db) | ✅ Scaffolded |
| i18n | English + Hebrew | ✅ Complete |
| Drag & Drop framework | dnd-kit (in frontend) | ✅ Available |

### 2.2 Code Mode (Legacy — partly working)
- Spawns and streams a Claude Code agent (`code_agent.rs`)
- User can run a coding session against a local project
- Output persisted across sessions (Phase 6 complete)
- **Gap**: No visual context; no Android emulator integration; no structured approval flow

### 2.3 Plan Mode (Recently Built — Being Replaced)
Four-stage pipeline: Translate → Vision → Navigate → Architect  
- Image drag-and-drop into prompt area ✅  
- Pre-flight Ollama health check ✅  
- Stage progress bar ✅  
- Copy Plan button ✅  
- TOML-based model config ✅  
- Gemini CLI as architect (Phase 8 — NOT started)  

**Decision**: Plan Mode as a standalone feature is being abandoned. Its best ideas (image drag, pipeline stages, TOML config, read-only enforcement) will be absorbed into the unified Coding Tool architecture described in §3.

### 2.4 Reference Project: PromptMaster (`/Users/zvisegal/devlope/PromtMasterAiAgentIOS`)
This is a C#/Avalonia desktop tool for **iOS/Android screenshot → source file matching + plan generation**. Key ideas to port:

| Concept | PromptMaster Implementation | Port to Atomic Chat |
|---|---|---|
| Screenshot → file match | Vision → IDF scoring → LLM tiebreak | Screenshot pipeline in Rust backend |
| IDF deterministic scoring | Word frequency × file weight | Implement in Rust (no LLM needed for confidence) |
| Gemini CLI subprocess | `GeminiCliService.cs` (process spawn) | Already done partially in `plan_agent.rs` |
| Thinking budget config | `.gemini/settings.json` (32,768 tokens) | Port to `planner-config.toml` |
| 4-slot AI model roles | Separate model per pipeline stage | Already in `planner-config.toml` |
| Code verifier (LM Studio) | Dedicated verification model | Add verification stage |
| Project DNA detection | Architecture pattern scanner | Port or implement in Rust |
| Agent Work Protocol | 3-phase auto-generated instruction | Incorporate in prompt construction |
| Plan export (.md file) | `MarkdownExporter.cs` | Already have copy; add file export |

---

## 3. Target Architecture: AI Coding Desktop Tool

### 3.1 Core Loop (What the User Experiences)

```
User opens project folder
  ↓
Optionally attaches context:
  - Screenshot from Android emulator (drag-drop or auto-capture)
  - Screenshot from any source (Figma, device, browser)
  - Text description of desired change
  ↓
Tool runs Read-Only Analysis:
  1. Vision stage  → extract UI components from screenshot
  2. IDF matching  → find candidate source files (deterministic)
  3. Navigate      → LLM refines to 3-5 files (Ollama/local)
  4. Architect     → Gemini CLI (thinking) generates structured plan
  ↓
User reviews plan (markdown, expandable file diffs)
  ↓
User approves  →  Execution Agent applies changes step by step
                  (each step shown, user confirms or skips)
  ↓
Agent uses MCP tools: Read, Write, Edit, Bash (scoped)
  ↓
Result: working code change + summary
```

### 3.2 Android Emulator Integration (The Key Differentiator)

**Goal**: The tool can "see" what the running Android app looks like, link it to source code, and propose targeted code changes — automatically, without the developer manually taking a screenshot.

**Implementation path**:
1. `adb screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png` → temp file
2. User can trigger this manually (button) or configure it to fire when emulator is focused
3. Screenshot feeds directly into the Vision stage of the pipeline
4. No dependency on cloud vision APIs — runs through local Ollama vision model (e.g., `qwen2.5-vl`)

**Tauri implementation**: `src-tauri/src/core/` — new `emulator_capture.rs` module  
**UI**: Button in CodeModePanel or floating toolbar, auto-attach to current session

### 3.3 Gemini CLI as Architect (Planning Stage)

Already partially implemented in `plan_agent.rs`. Full integration:
- Primary: Gemini CLI subprocess with `--model gemini-2.5-pro` + `thinkingBudget: 32768`
- Fallback: Ollama (local) for offline use
- Config: `planner-config.toml` (already exists, add `[gemini]` section)
- Constraint flags: `--allowedTools Read,Glob,Grep` (read-only in planning stage)

### 3.4 Execution Agent (New — Not in Either Current Project)

**This is what neither PromptMaster nor current Atomic Chat has.**

After the user approves the plan, an **Execution Agent** applies changes:
- Spawns a controlled Claude Code subprocess (already done in `code_agent.rs`)
- Applies changes one file at a time, streaming diffs to UI
- User sees each proposed change before it is written
- Per-step approval: Approve / Skip / Stop
- Full MCP toolset available (Write, Edit, Bash scoped to project folder)
- Auto-runs tests if detected (`package.json` scripts, `Makefile`, etc.)
- Produces a summary of all changes made

**UI**: Execution panel below the plan, showing:
- Current step + file being modified
- Diff view (before/after)
- Approve / Skip / Stop controls
- Running log of all changes

### 3.5 Unified Mode Architecture

Replace the current Code Mode / Plan Mode toggle with a single **Coding Agent** flow:

```
[Project Selector]  →  [Context Panel]  →  [Plan Panel]  →  [Execution Panel]
     Open folder         Screenshot              AI plan          Apply changes
     Recent projects     Prompt text         Review + approve     Per-step diffs
     Git status          Drag-drop files     Gemini thinking      Test runner
```

All four panels can be in a single-window layout (horizontal or collapsible).

---

## 4. What to Build (Prioritized)

### Phase A — Foundation (Pre-requisite)
1. Refactor `CodeModePanel.tsx` into `CodingAgentPanel.tsx` with the unified 4-panel layout
2. Migrate Plan Mode pipeline into a generic `PipelineService` (reusable by both planning and analysis)
3. Keep all existing infrastructure (MCP, local models, cloud SDKs) untouched

### Phase B — Screenshot Pipeline
4. Port PromptMaster's IDF scoring algorithm to Rust (`src-tauri/src/core/idf_matcher.rs`)
5. Implement Android emulator capture (`emulator_capture.rs`) via `adb` subprocess
6. Connect screenshot → Vision stage → IDF → Navigate pipeline (reuse plan_agent.rs stages 1-3)
7. UI: Drag-drop zone + "Capture from Emulator" button in Context Panel

### Phase C — Gemini CLI Architect (Phase 8 of old plan)
8. Complete Gemini CLI integration in `plan_agent.rs` Stage 4
9. Add `[gemini]` section to `planner-config.toml` (path, model, timeout, thinking budget)
10. Fallback: if Gemini CLI not found → Ollama local model

### Phase D — Execution Agent
11. Extend `code_agent.rs` to support step-by-step execution with approval gates
12. Build `ExecutionPanel.tsx` with diff view, approve/skip/stop controls
13. Integrate test runner detection and auto-run
14. Produce change summary at end of session

### Phase E — Polish & Differentiators
15. Project DNA detection (port from PromptMaster `ProjectDnaService`)
16. Plan export to `.md` file
17. Plan versioning (compare multiple generated plans)
18. Streaming plan output (currently all-at-once)
19. Keyboard shortcuts for approve/skip/stop

---

## 5. What Does NOT Exist in Either Project (True Gaps)

| Capability | Status |
|---|---|
| Android emulator auto-capture via `adb` | ❌ Not in either project |
| Per-step execution approval UI | ❌ Not in either project |
| Diff view of proposed code changes | ❌ Not in either project |
| Test runner auto-detect + run | ❌ Not in either project |
| Change summary at session end | ❌ Not in either project |
| Plan versioning / comparison | ❌ Not in either project |
| IDF file matching in Rust | ❌ Not in Atomic Chat (exists in PromptMaster C#) |
| Gemini CLI thinking budget config | ❌ Not in Atomic Chat (exists in PromptMaster) |
| Project DNA architecture detection | ❌ Not in Atomic Chat (exists in PromptMaster) |

---

## 6. What Exists and Works (Do Not Rebuild)

| Capability | Location | Notes |
|---|---|---|
| Image drag-drop into prompt | `CodeModePanel.tsx` | Already built in Plan Mode |
| Ollama vision stage | `plan_agent.rs` stages 1-2 | Working |
| File tree navigator stage | `plan_agent.rs` stage 3 | Working |
| Claude Code agent spawn + stream | `code_agent.rs` | Stable |
| MCP client (SSE/HTTP/process) | `src-tauri/src/core/mcp/` | Production quality |
| TOML model config | `planner-config.toml` + `planner_config.rs` | Working |
| Local API `localhost:1337/v1` | `http.rs` | Stable |
| MLX / LLaMA.cpp / Foundation Models | Tauri plugins | Stable |
| Zustand store with persistence | `code-mode-store.ts` | Stable |
| i18n English + Hebrew | `locales/` | Complete |
| Gemini CLI subprocess | `plan_agent.rs` (partial) | Needs completion |
| dnd-kit drag-and-drop | web-app deps | Available, used in Plan Mode |

---

## 7. Technology Constraints & Decisions

| Decision | Rationale |
|---|---|
| Stay on Tauri + Rust + React | Platform is mature; rebuild would waste months |
| Local-first inference | Core differentiator vs. Codex/Claude Code |
| Gemini CLI via subprocess (not API) | Already done in PromptMaster; avoids API key management |
| `adb` for emulator capture | Standard Android tooling; no extra dependencies |
| IDF scoring in Rust (not LLM) | Deterministic, fast, no hallucination risk for file matching |
| Approval gates before each write | Trust + safety; differentiates from fully-autonomous agents |
| TOML for model config | Already in place; human-readable; supports user overrides |

---

## 8. Instructions for Research Agent

Before the architect builds the full plan, the **deep research agent** should investigate:

1. **`adb screencap` reliability** — What are the failure modes? Does it work with Tauri's permission model on macOS? Is there a better API (Android Debug Bridge Java API vs. CLI)?
2. **Gemini CLI `--allowedTools` flag** — Does Gemini CLI support the same tool restriction flags as Claude Code? What are the exact flags available?
3. **IDF scoring accuracy** — What is the state of the art for screenshot→source-file matching? Are there better algorithms than TF-IDF for code (AST similarity, embedding-based)?
4. **Diff rendering in React** — Best library for inline diff display in a Tauri app (monaco-editor, react-diff-viewer, custom)?
5. **Execution agent sandboxing** — How do Codex Desktop and Claude Code scope file system access? Can we replicate with Tauri's capabilities system?
6. **Streaming diffs** — Can we stream partial file writes to the UI before the agent commits them?
7. **Test runner detection patterns** — What heuristics reliably detect test runner availability (Jest, Vitest, Pytest, Go test, etc.) across project types?

---

## 9. Success Criteria

The tool is complete when:
- [ ] A developer can drag an Android emulator screenshot into the tool
- [ ] The tool automatically identifies which source file(s) render that screen
- [ ] Gemini CLI generates a structured, code-grounded implementation plan
- [ ] The developer approves the plan and the agent applies changes step by step
- [ ] Each step shows a diff before writing; developer can approve, skip, or stop
- [ ] Tests run automatically after changes
- [ ] Everything works fully offline with local models (Ollama + MLX)
- [ ] The tool starts faster and has a simpler UI than both Codex Desktop and Claude Code Desktop

---

## 10. Key Files for the Architect Agent

| File | Purpose |
|---|---|
| `src-tauri/src/core/plan_agent.rs` | Current 4-stage pipeline (extend this) |
| `src-tauri/src/core/code_agent.rs` | Claude Code subprocess spawner (extend for execution) |
| `src-tauri/src/core/planner_config.rs` | TOML config loading |
| `src-tauri/resources/planner-config.toml` | Model configuration |
| `web-app/src/containers/CodeModePanel.tsx` | Main UI panel (refactor target) |
| `web-app/src/stores/code-mode-store.ts` | State management |
| `web-app/src/containers/pm/PlanComposer.tsx` | Plan UI components |
| `src-tauri/src/lib.rs` | Tauri command registry (add new commands here) |
| `src-tauri/Cargo.toml` | Rust dependencies |
| `/Users/zvisegal/devlope/PromtMasterAiAgentIOS/src/PromptMaster.Core/Services/VisionService.cs` | IDF algorithm to port |
| `/Users/zvisegal/devlope/PromtMasterAiAgentIOS/src/PromptMaster.Core/Services/GeminiCliService.cs` | Gemini CLI subprocess reference |
| `/Users/zvisegal/devlope/PromtMasterAiAgentIOS/docs/AGENT_MODEL_ROLES.md` | AI slot architecture reference |
