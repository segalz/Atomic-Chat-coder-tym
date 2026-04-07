## Stage 2 — Frontend: UI wiring (MVP UX)

### Stage 2 deliverables (what must exist after this stage)

- A Code Mode UI that can run one session end-to-end: **start → stream → permission allow/deny → finish**.
- Deterministic rendering driven purely by `code_agent_event` (no terminal parsing).
- A minimal, stable frontend run state model (`run_id`, `status`, `transcript`, `last_error`).
- A safe listener lifecycle (no duplicate listeners, no leaks).
- All new Code Mode styling lives in a **separate CSS file**.

### Primary files to touch

- UI panel: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/containers/CodeModePanel.tsx`
- UI state/store: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/stores/code-mode-store.ts`
- (Recommended) Event types/guards: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/lib/code-agent/events.ts`
- (CSS) Code Mode styles: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/containers/CodeModePanel.css`

### UI → backend wiring (commands + event subscription)

- Start:
  - call `start_code_agent(run_config)` and store the returned `run_id`
  - set frontend status to `starting`
- Subscribe to events:
  - listen once to `code_agent_event`
  - route each event into the store keyed by `run_id`
- Send user input:
  - call `send_code_agent_input(run_id, text)`
  - allow this whenever the run is in `running` (do not treat it as “only after permissions”)
- Permissions:
  - render `permission_request` with Allow/Deny buttons
  - call `respond_code_agent_permission(run_id, request_id, decision)` on click
- Cancel:
  - call `cancel_code_agent(run_id)`
  - immediately set frontend status to `cancelling` (then confirm terminal state via events)

### Frontend run state machine (store-owned)

Use the same statuses as the backend:

- `starting | running | awaiting_permission | cancelling | finished | error`

Define transitions based on user actions + events:

- Start button → `starting`
- `run_started` (for the active `run_id`) → `running`
- `permission_request` → `awaiting_permission`
- after the UI calls `respond_code_agent_permission(...)` → `running` (until next event)
- Cancel button → `cancelling`
- `run_finished` → `finished`
- `run_error` → `error`

Rules:

- Ignore events for unknown run ids or non-active runs (unless multi-run support is explicitly added).
- Be idempotent: duplicated/out-of-order events must not double-append transcript entries.

### Transcript & rendering rules (deterministic)

The UI is a pure projection of events:

- `assistant_delta`: append to the currently streaming assistant message (create one if none exists yet for this turn).
- `tool_start`: add a tool-call entry keyed by `tool_call_id`.
- `tool_result`: attach to the tool-call entry and mark it complete (`is_error` affects UI display only).
- `permission_request`: show a UI prompt card (do not auto-resolve).
- `permission_resolved`: mark that prompt as resolved and record the decision.

### Listener lifecycle (avoid regressions)

- Register the Tauri event listener **once** per component mount.
- Always `unlisten()` on unmount.
- Do not register new listeners per run; use `run_id` routing inside the store.

### Type safety (do not use `any`)

- Define a discriminated union type for events (e.g. `type CodeAgentEvent = { type: 'run_started', ... } | ...`).
- Validate/guard incoming event payloads before updating state (fail closed → set `run_error`).

### Testing tasks

- Component/store tests:
  - event ordering and `assistant_delta` accumulation
  - tool start/result pairing by `tool_call_id`
  - permission allow/deny flow and status transitions
  - cancel flow (UI enters `cancelling` and ends in a terminal state)
- E2E minimal:
  - fake engine → start → stream → permission → allow/deny → finish
  - repeat using the real sidecar engine once Stage 1 is ready

### Exit criteria

- UI reliably renders a full run using both the fake engine and the sidecar engine.
- UI never parses engine stdout; it renders only structured events.

### Do / Don’t

- Do: keep styling in a separate CSS file.
- Do: keep parsing and policy decisions in the backend.
- Don’t: parse terminal text or infer tool boundaries from plain strings.
- Don’t: keep global event listeners without cleanup.

---

