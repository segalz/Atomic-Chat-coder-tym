# Plan Mode → Coding → QA Pipeline — Staged Implementation Plan

**Status:** Planning only. Nothing in this document has been implemented yet.

**Origin:** This plan replaces an earlier idea of building a generic
multi-agent pipeline (separate Planner/Coder/Reviewer/Fixer models, or
MCP servers per role) from scratch. Investigation found that **Plan Mode
already implements most of that pattern** — it just isn't wired into the
Coding Agent, and there is no QA/review step after coding. This plan
closes those two gaps instead of building new infrastructure.

## How to use this document

Each stage below is **self-contained** and can be handed to a fresh
conversation/agent with no other context than this file. Every stage
lists exactly which files to read first, what to change, and how to
verify it. Do the stages **in order** — later stages depend on commands
or UI added in earlier ones. Do not start a stage until the previous
one's acceptance criteria are met.

---

## Background (read once, applies to all stages)

The app has three top-level modes, switched via `ModeToggle` in
[`web-app/src/routes/index.tsx`](../web-app/src/routes/index.tsx:44)
and tracked in `useCodeModeStore().mode`
(`'chat' | 'plan' | 'coding'`):

- **`plan`** → renders
  [`CodeModePanel`](../web-app/src/containers/CodeModePanel.tsx) — runs
  a 4-stage local pipeline (`Translate → Vision → Navigate →
  Architect`) via the Tauri command `run_plan_pipeline`, implemented in
  [`src-tauri/src/core/plan_agent.rs`](../src-tauri/src/core/plan_agent.rs).
  Each stage already uses its **own configurable model**
  (`translator`, `vision`, `navigator`, `architect` —
  see `ModelConfig` in
  [`src-tauri/src/core/planner_config.rs`](../src-tauri/src/core/planner_config.rs:4)).
  Models are loaded from a TOML config (`PlannerConfig::load`,
  `planner_config.rs:259+`) with **no UI to change them today**, and
  there is **no command to write the config back**, only
  `get_planner_config` (read-only, registered in
  [`src-tauri/src/lib.rs:121`](../src-tauri/src/lib.rs:121)).

- **`coding`** → renders
  [`CodingAgentPanel`](../web-app/src/containers/CodingAgentPanel/index.tsx) —
  a single tool-calling agent loop (file edits etc.) backed by the
  Tauri command `start_ollama_agent`, implemented in
  [`src-tauri/src/core/ollama_agent.rs`](../src-tauri/src/core/ollama_agent.rs)
  (~3,850 lines). State lives in a **different** Zustand store,
  `useCodingAgentStore`
  ([`web-app/src/stores/coding-agent-store.ts`](../web-app/src/stores/coding-agent-store.ts)),
  which is **not** the same store `CodeModePanel` uses
  (`useCodeModeStore`,
  [`web-app/src/stores/code-mode-store.ts`](../web-app/src/stores/code-mode-store.ts)).
  This is why Plan Mode's output never reaches the Coding Agent's input
  today — they're two separate panels with two separate stores.

- **`chat`** → ordinary LLM chat, unrelated to this plan. Do not touch.

Today, after the `architect` stage finishes, `CodeModePanel` only offers
`handleCopyPlan`
([`CodeModePanel.tsx:379`](../web-app/src/containers/CodeModePanel.tsx:379)),
which copies the assistant-type lines from `agentOutput` to the
clipboard. The user must manually switch tabs and paste. That is the
first gap this plan closes (Stage 3).

The second gap is that there is no review/QA step after the Coding
Agent finishes a run. Stage 4–5 add one, reusing the same
single-shot-completion pattern Plan Mode already uses for its
non-tool-calling stages.

All new backend calls in this plan reuse the existing `ollama_chat`
helper (`plan_agent.rs:389`) — a plain non-streaming chat completion
(`POST {ollama.base_url}{ollama.api_path}`, no tools). Do **not** touch
`ollama_agent.rs`'s tool-calling loop; none of this plan needs it except
indirectly (the Coding Agent keeps running exactly as it does today).

---

## Stage 1 — Backend: persist planner model selection

**Goal:** Add a Tauri command that writes model choices back to the
planner config file, so the UI (Stage 2) has something to call.

**Read first:**
- [`src-tauri/src/core/planner_config.rs`](../src-tauri/src/core/planner_config.rs)
  in full (1,065 lines is `plan_agent.rs`; `planner_config.rs` itself is
  shorter — read the whole file). Pay attention to:
  - `ModelConfig` struct (`:4`) — fields `translator`, `vision`,
    `navigator`, `architect`.
  - `PlannerConfig::load` (`:259`) — note the **user override path** it
    reads from first (read the function body to find the exact path,
    e.g. an app-data directory) before falling back to the bundled
    config and hardcoded defaults.
  - The existing read-only commands at the bottom of the file
    (`:306`–`:330`: `get_planner_config`, `get_coding_agent_config`,
    `get_point_failure_advisor_config`) — match their signature style.

**Tasks:**
1. Add a new `#[tauri::command]` function, e.g.
   `update_planner_models(app, updates: PartialModelConfig) -> Result<PlannerConfig, String>`,
   where `PartialModelConfig` has `Option<String>` for each of
   `translator`, `vision`, `navigator`, `architect` (and leave room to
   add `qa` in Stage 4 — either add the field now as `Option<String>`
   defaulting to `None`, or add it in Stage 4, your choice, but keep
   `ModelConfig` and the partial struct in sync).
2. Implementation: load the current `PlannerConfig` (reuse
   `PlannerConfig::load` or factor out its user-override-path logic if
   it's private), apply the non-`None` fields from `updates` onto
   `config.models`, serialize the **whole** `PlannerConfig` back to
   TOML, and write it to the same user-override path `load()` reads
   from first. Return the updated config so the frontend can confirm.
3. Register the new command in
   [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs:121) next to the
   existing `planner_config::get_planner_config` line.
4. Add a unit test in `planner_config.rs` (there may already be a
   `#[cfg(test)] mod tests` block in `plan_agent.rs` to use as a style
   reference) that writes to a temp dir, calls the update function, and
   asserts the new model name round-trips through a fresh `load()`.

**Acceptance criteria:**
- `cargo test` passes for the new test.
- Manually: call `invoke('update_planner_models', { updates: { architect: 'some-model:tag' } })`
  from the browser devtools console (app must be running via `tauri
  dev`), then call `invoke('get_planner_config')` and confirm
  `models.architect` reflects the change, and that it survives an app
  restart (config file persisted to disk).

**Out of scope:** Do not add a UI for this yet — that's Stage 2.

---

## Stage 2 — Frontend: planner model selector in Plan Mode

**Goal:** Let the user pick which model runs the `architect` (and
optionally `navigator`) stage, instead of it being fixed in a config
file no one can see.

**Read first:**
- [`web-app/src/containers/CodeModePanel.tsx`](../web-app/src/containers/CodeModePanel.tsx)
  — focus on the header/toolbar area (near `handleCopyPlan` and the
  stage status UI, `:379`–`:500` region) and the `checkOllama` /
  `isCheckingOllama` pattern (`:101`) for how the panel already talks
  to Ollama health.
- [`web-app/src/containers/CodingAgentPanel/CodeModelSelector.tsx`](../web-app/src/containers/CodingAgentPanel/CodeModelSelector.tsx)
  — existing model-picker component for the Coding Agent. You can reuse
  this component as-is (it's generic — takes `value`, `installedModels`,
  `onChange`, `onPull`, `onRefresh`) or build a lighter variant if its
  "code-tool-compatible" filtering logic doesn't make sense for a
  planner model (planner models don't need tool-calling support, so the
  `isCodeAgentToolCompatible` filter in that file should probably be
  bypassed or replaced for this use case).
- The Tauri commands `list_ollama_models` (already used in
  `CodingAgentPanel/index.tsx:795`) and the new `update_planner_models`
  from Stage 1.

**Tasks:**
1. On `CodeModePanel` mount, call `invoke('get_planner_config')` to read
   the current `models.architect` value, and `invoke('list_ollama_models')`
   for the dropdown options (same pattern as `CodingAgentPanel`).
2. Add a model selector control near the top of the panel (or inside a
   small settings popover if the toolbar is crowded) bound to
   `models.architect`. On change, call
   `invoke('update_planner_models', { updates: { architect: newModel } })`.
3. Decide whether to also expose `navigator` (recommend: yes, since it
   also affects plan quality) — if so, add a second selector or a
   simple "Advanced" toggle that reveals it. Leave `translator` and
   `vision` as config-only for now (lower impact, keep UI simple).
4. Add i18n strings to
   [`web-app/src/locales/en/code-mode.json`](../web-app/src/locales/en/code-mode.json)
   and the matching
   [`web-app/src/locales/he/code-mode.json`](../web-app/src/locales/he/code-mode.json)
   (e.g. `plannerModelLabel`, `plannerModelHelp`) — follow the existing
   flat key style in that file.

**Acceptance criteria:**
- Selecting a model in the UI, then running a plan, results in the
  `architect` stage actually using that model — verify by checking
  Ollama's logs or by picking two very different models and observing
  different output styles.
- Restarting the app preserves the last-selected model (confirms Stage
  1's persistence works end-to-end).

**Out of scope:** Don't change anything about how `run_plan_pipeline`
loads its config — it already calls `PlannerConfig::load` fresh on each
run (`plan_agent.rs:962`), so once Stage 1's write lands, this stage is
purely additive UI.

---

## Stage 3 — Frontend: "Continue to Code" handoff button

**Goal:** Replace the manual copy/paste step with a button that takes
the finished plan straight into the Coding Agent's prompt box.

**Read first:**
- [`web-app/src/containers/CodeModePanel.tsx:379`](../web-app/src/containers/CodeModePanel.tsx:379)
  — `handleCopyPlan`, the exact logic for extracting plan text
  (`agentOutput.filter(line => line.type === 'assistant').map(...).join('\n\n')`).
  Reuse this extraction logic verbatim.
- [`web-app/src/containers/CodeModePanel.tsx:94`](../web-app/src/containers/CodeModePanel.tsx:94)
  — `stages` state (`StageState`), specifically `stages.architect ===
  'done'` is the signal that a plan is ready.
- [`web-app/src/stores/code-mode-store.ts:61`](../web-app/src/stores/code-mode-store.ts:61)
  — `setMode` (to switch to `'coding'`).
- [`web-app/src/stores/coding-agent-store.ts`](../web-app/src/stores/coding-agent-store.ts)
  — `setDraftPrompt` (`:62`/`:199`) is what seeds the Coding Agent's
  input box. **Do not auto-send** — every other flow in this app
  (Coding Agent, Plan Mode) requires an explicit user click to run an
  agent; seeding the draft and letting the user review/edit/press send
  themselves matches that pattern and avoids accidentally kicking off
  an expensive tool-calling run on a plan the user hasn't read yet.
  Also note `projectDir` is a separate field per store
  (`code-mode-store.ts:47` vs `coding-agent-store.ts` — check it has
  its own `projectDir` too) — carry the project directory across as
  well, don't leave the Coding Agent panel pointed at a different/empty
  folder.

**Tasks:**
1. In `CodeModePanel.tsx`, add a `"Continue to Code →"` button next to
   the existing `"Copy Plan"` button, enabled under the same condition
   (`stages.architect === 'done'`, i.e. wherever `handleCopyPlan`'s
   button is currently shown/enabled).
2. On click:
   - Compute `planText` using the same logic as `handleCopyPlan`.
   - `useCodingAgentStore.getState().setDraftPrompt(planText)`.
   - `useCodingAgentStore.getState().setProjectDir(useCodeModeStore.getState().projectDir)`
     (confirm the exact setter name by reading `coding-agent-store.ts`).
   - `useCodeModeStore.getState().setMode('coding')`.
3. Add the i18n key (`continueToCode` or similar) to both
   `en/code-mode.json` and `he/code-mode.json`.

**Acceptance criteria:**
- Run a plan to completion in Plan Mode, click the new button, land on
  the Coding tab with the prompt box pre-filled with the plan text and
  the same project folder selected, **without** the agent having
  started running yet.
- Confirm the existing `"Copy Plan"` button still works unchanged (this
  is additive, not a replacement).

---

## Stage 4 — Backend: QA/Review stage

**Goal:** Add a backend command that reviews what the Coding Agent did,
using a plain (non-tool-calling) model call — the same pattern as the
`architect` stage, not the same pattern as `start_ollama_agent`.

**Read first:**
- [`src-tauri/src/core/plan_agent.rs:389`](../src-tauri/src/core/plan_agent.rs:389)
  — `ollama_chat(ollama: &OllamaConfig, model: &str, system: &str,
  user_message: &str) -> Result<String, String>`. This is the function
  to reuse; it's already used for the `translate` and `navigate`
  stages.
- [`src-tauri/src/core/plan_agent.rs:669`](../src-tauri/src/core/plan_agent.rs:669)
  (`run_pipeline_inner`) and the `emit_stage!` macro usage around it —
  use this as the template for streaming progress to the frontend via
  `app.emit(...)`, rather than a single blocking request/response.
- [`src-tauri/src/core/planner_config.rs`](../src-tauri/src/core/planner_config.rs)
  — add a `qa: String` field to `ModelConfig` (default it to the same
  value as `architect` in `PlannerConfig::defaults()`,
  `planner_config.rs:232`), and extend the `PartialModelConfig` /
  `update_planner_models` command from Stage 1 to cover it.
- [`web-app/src/containers/CodingAgentPanel/conversation-summary.ts`](../web-app/src/containers/CodingAgentPanel/conversation-summary.ts)
  — likely the best existing source for "what did the agent just do" in
  a compact form (diffs/summary), to use as the QA call's input instead
  of the full raw exec log.

**Tasks:**
1. Add a new Rust module or extend `plan_agent.rs` with a QA system
   prompt constant (e.g. `QA_REVIEW_SYSTEM`) describing the reviewer
   role: given the original request, the plan (optional), and a summary
   of what was changed, point out bugs, missed edge cases, and whether
   the request was actually satisfied. Keep it text-only — no tool
   definitions, no JSON tool-call format expected back.
2. Add `#[tauri::command] pub async fn run_qa_review(app, project_dir,
   original_prompt, plan_text: Option<String>, change_summary, model:
   Option<String>) -> Result<(), String>` that:
   - Loads `PlannerConfig`, uses `models.qa` unless `model` overrides it
     (mirrors how Stage 2's per-call override could work, but a default
     from config is enough for v1).
   - Calls `ollama_chat(...)` with the constructed prompt.
   - Emits the result via a new event, e.g. `qa-review-result` (or reuse
     `plan-stage-progress`-style events if it fits better — your call,
     but document the event shape).
3. Register the command in `lib.rs` next to the other `plan_agent::`
   entries.

**Acceptance criteria:**
- Calling `run_qa_review` with a hand-crafted `change_summary` string
  (no need for a real Coding Agent run yet) returns/emits a coherent
  review. Verify manually via devtools console.
- Confirm it does **not** touch any files on disk and does **not**
  invoke any tool-calling — it's a pure text-in/text-out call, same
  cost profile as the `architect` stage.

---

## Stage 5 — Frontend: trigger QA from the Coding Agent panel

**Goal:** Surface a "Run QA Review" action after a coding run finishes,
and display the result.

**Read first:**
- [`web-app/src/containers/CodingAgentPanel/index.tsx`](../web-app/src/containers/CodingAgentPanel/index.tsx) —
  specifically `agentStatus` state values (`'idle' | 'running' |
  'restarting' | 'free' | 'failed'`, `:378`) to know when a run has
  actually finished, and `appendLog` / `ExecLogLine` (`:399`) for how
  to render new content in the existing log feed.
- `conversation-summary.ts`'s `buildConversationSummary` (from Stage 4's
  research) — reuse it here to build the `change_summary` argument.
- Stage 4's `run_qa_review` command and its result event.

**Tasks:**
1. Add a "Run QA Review" button, shown when `agentStatus` indicates a
   finished run (not while `'running'`).
2. On click, gather: the original user prompt (from the active session,
   see `CodingSession` shape referenced in `conversation-context.ts`),
   the plan text if one exists (`session.planText`), and a change
   summary via `buildConversationSummary`. Call `run_qa_review`.
3. Listen for the result event from Stage 4 and append it to `execLog`
   as a new line type (extend `ExecLogLine`'s `type` union with
   something like `'qa_review'`, matching how `'plan_stage'` was added
   to `AgentOutputLine` in `code-mode-store.ts`).
4. Reuse Stage 2's model-selector pattern if you want per-run QA model
   override; otherwise the config default from Stage 4 is sufficient
   for v1 — don't over-build this.

**Acceptance criteria:**
- After a real Coding Agent run completes, clicking "Run QA Review"
  shows a review in the log without freezing the UI (it's one HTTP
  call, should be fast relative to a tool-calling run).
- Running it twice in a row doesn't crash or duplicate state oddly.

---

## Stage 6 — Polish, settings, end-to-end verification

**Goal:** Tie it together as an opt-in feature (per the original ask:
a toggle, not an always-on behavior) and verify the full path once.

**Read first:** Everything touched in Stages 1–5; no new files.

**Tasks:**
1. Add a persisted boolean setting (in either store, your call —
   `useCodeModeStore` fits better since it already owns `mode`) such as
   `autoSuggestQa: boolean`, defaulting to `true` is fine since the
   action still requires a manual button click (it's not an autonomous
   pipeline) — but make sure it's easy to find/toggle off if a user
   wants the QA button hidden entirely.
2. Run the **full path** manually once, in order, in a real `tauri dev`
   session:
   - Open Plan Mode, pick a planner model (Stage 2), enter a prompt,
     wait for `architect` to finish.
   - Click "Continue to Code" (Stage 3) — confirm the Coding tab opens
     pre-filled with the plan and correct project folder.
   - Review/edit the prompt, press send, let the Coding Agent run to
     completion.
   - Click "Run QA Review" (Stage 5) — confirm a review appears.
3. Confirm nothing in the existing single-model `chat` mode or the
   legacy `direct-ollama` vs `legacy-claude` backend toggle in
   `CodingAgentPanel` regressed — this whole plan should be purely
   additive on top of existing flows.

**Acceptance criteria:** The 3-step manual walkthrough above completes
without errors, using two different models for the planner and coder
stages to prove the multi-model handoff actually works end to end.
