# Code Mode Development Process (claw-code engine)

This document describes the development process for **Code Mode** in Atomic Chat using a **claw-code**-based agent engine (see `/Users/zvisegal/devlope/Claw-Code-Local-IOS`) and an **event-driven** UI contract.

## Goals

- Deliver a UI experience similar to Claude Desktop / Codex Desktop: **plan → act → tool-use → code changes → run tests**.
- Keep the UI **engine-agnostic** by relying on a stable **event contract**, not terminal text parsing.
- Run **local-first** via a stable OpenAI-compatible base URL (commonly `http://localhost:1337/v1`).
- Enforce safety: **workspace boundaries + explicit permissions + deny-by-default**.
- Avoid regressions: Chat Mode stays stable and provider/model serving remains unchanged.

## Repository touchpoints

- UI panel: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/containers/CodeModePanel.tsx`
- UI state: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/web-app/src/stores/code-mode-store.ts`
- Backend (Tauri/Rust): `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/src-tauri/`
- Local API/proxy (stable endpoint): `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/src-tauri/src/core/server/proxy.rs`
- Agent engine source: `/Users/zvisegal/devlope/Claw-Code-Local-IOS`

## Architecture (target)

The recommended approach is an **internal agent service** inside Tauri that communicates with the UI via Tauri commands + events.

```mermaid
flowchart LR
  UI["React UI (Code Mode)"] -->|Tauri invoke| AS["Agent Service (Rust)"]
  AS -->|events stream| UI
  AS -->|HTTP (OpenAI-compatible)| API["Local API Proxy<br/>127.0.0.1:1337/v1"]
  API --> MS["Local model servers<br/>(MLX / llama.cpp / optional Ollama)"]
  AS --> ENG["Engine (claw-code)<br/>Sidecar → Embedded"]
  ENG -->|tool calls + model requests| AS
```

### Integration strategy

We recommend a two-step engine integration:

1. **MVP**: run `claw` as a **sidecar** process and consume a **structured event stream** (NDJSON preferred).
2. **Upgrade**: embed `claw-code-local` crates **in-process** inside `src-tauri` once the event contract is stable.

This keeps early progress fast while preserving a clean path to deterministic permission handling and stronger safety.

## Agent service contract (must remain stable)

### Commands (UI → backend)

- `start(runConfig)` → returns `run_id`
- `sendInput(run_id, text)`
- `respondPermission(run_id, request_id, decision)` where `decision ∈ {allow, deny}`
- `cancel(run_id)`

### Events (backend → UI)

Minimum set (engine-agnostic):

- `run_started` `{ run_id, workspace_root, model_id, timestamp }`
- `assistant_delta` `{ run_id, text_delta }`
- `tool_start` `{ run_id, tool_name, input, tool_call_id }`
- `tool_result` `{ run_id, tool_name, tool_call_id, output, is_error }`
- `permission_request` `{ run_id, request_id, tool_name, required_mode, input, reason_code?, reason?, tool_call_id?, test_id?, paths?, command?, argv? }`
- `permission_resolved` `{ run_id, request_id, decision, reason_code?, reason?, tool_call_id?, test_id? }`
- `run_error` `{ run_id, message, details? }`
- `run_finished` `{ run_id, usage?, summary? }`

Rules:

- UI must never parse terminal formatting; it only renders events.
- Backward compatibility matters: once shipped, extend events by adding fields rather than renaming.

## “Reality gates” (must be proven early)

These are small spikes that prevent building a large UI on assumptions:

1. **Streaming gate**
   - Prove the engine can produce a structured stream suitable for UI (NDJSON/SSE/WS).
   - Confirm we can represent partial assistant output as `assistant_delta`.
2. **Permissions gate**
   - Prove permissions are structured as `permission_request` and can be answered programmatically (no TTY-only prompt loops).
3. **Workspace safety gate**
   - Prove we can enforce workspace boundaries even in edge cases:
     - `..` traversal
     - symlink escape
     - new-file writes (parent canonicalization)

If any gate fails, pause and adjust the engine adapter before adding more UI features.

---

## Stage 0 — Architecture + contract spike

**Code tasks**

- Lock the command + event schema (above).
- Implement a fake in-memory engine that emits a deterministic scripted stream (for UI work).
- Decide the MVP engine transport:
  - Preferred: **NDJSON** (one JSON object per line) with explicit event types.

**Testing tasks**

- Contract test: replay a recorded event stream into the UI reducer/renderer.
- Backend parser test: handles partial lines, invalid JSON, stderr noise.

**Exit criteria**

- Event schema is versioned and used end-to-end with the fake engine.
- “Reality gates” are executable and repeatable.

**Do / Don’t**

- Do: treat the event schema as a product API.
- Don’t: ship UI behavior that depends on terminal output formatting.

---

