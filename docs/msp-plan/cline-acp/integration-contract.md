# Cline ACP integration contract

## Status and authority

This document freezes the Stage 03 contract for integrating the installed Cline CLI into Atomic Chat's Coding Agent panel. It constrains later implementation stages; it does not enable Cline or change product behavior by itself.

- Protocol target: stable ACP wire protocol version `1`, negotiated during `initialize`.
- Atomic backend ID: `cline-acp`.
- ACP agent identity: `cline`, currently observed as Cline CLI `3.0.61`.
- Selected ACP model ID: `zai/glm-5.3-flash` (display name `GLM 5.3 Flash`).
- Atomic's provider field must preserve a verified provider namespace separately from the backend. `zai` is currently derived from the selected model ID namespace, not from independently returned provider metadata. Persist `providerId: "zai"` only if Stage 07 verifies that mapping from returned catalog/config metadata; otherwise keep `providerId` absent while preserving the exact `modelId`. `cline` is the backend/agent, never the model provider ID.
- The actual IDs and capabilities returned by each new ACP connection remain authoritative. A mismatch must fail visibly; no fallback to Ollama or another Cline model is allowed.

The Stage 02 probe is the installed-version evidence for the items above. Later real-client stages must repeat capability negotiation rather than assuming every future Cline version has the same optional methods.

## Selected architecture and transport

Atomic's Tauri backend will own one official-SDK `AcpAgent` connection to a `cline --acp` subprocess. A dedicated Cline agent service owns the `AcpAgent` instance, connection/session/run state and Atomic-facing commands; the SDK owns subprocess stdio and process teardown. A thin adapter supplies a resolved absolute executable, fixed arguments, bounded logging policy and Tauri event/error mapping. The renderer never owns the child process and never writes ACP JSON directly.

The selected dependency is `agent-client-protocol` `2.1.0` with `default-features = false` (the crate's default feature set is empty). It is the maintained official ACP Rust client/runtime and is licensed Apache-2.0. Use `AcpAgentConfig` plus `AcpAgent` and the stable-v1 typed client/session APIs; do not use `Stdio` for this host because `Stdio` attaches to the current process's own stdin/stdout. `AcpAgent` spawns the external process with piped stdio, retains at most a 64 KiB stderr tail, and kills/reaps its process group when the SDK-managed connection ends. Draft-v2 and every `unstable_*` feature remain disabled.

The native SDK path adds async/process support including `async-io`, `async-process`, `blocking`, `rustix` and `shell-words`, in addition to its schema/serde/futures graph. A Cargo 1.88 metadata resolution on 2026-09-10 found declared permissive or compatible licenses across the entire resolved transitive graph (Apache-2.0, MIT, BSD-style equivalents, Unicode-3.0, Zlib or Unlicense combinations; `r-efi` also offers MIT/Apache options). License metadata must be rechecked against the production lockfile when the dependency is actually added.

The SDK requires Rust `1.88.0` and edition 2024 internally. Atomic's main Tauri crate now declares Rust `1.88.0` while retaining edition 2021; Rust editions can coexist across dependencies. The exact toolchain passed `cargo +1.88.0 check` and all 199 library tests on 2026-09-10. A Cargo 1.88 dry run also resolved `agent-client-protocol` `2.1.0` without modifying the manifest or lockfile. The plugin crates may retain their lower MSRV because they do not consume the SDK directly.

The SDK dependency itself is deferred to the ACP transport implementation stage so Stage 03 does not add unused production dependencies. Stage 05 remains bounded to Cline ACP v1, the SDK wrapper, owned-process/buffer limits and fake-child tests. If the SDK cannot satisfy a tested lifecycle requirement without unstable features, stop and record a bounded compatibility blocker instead of falling back silently to handwritten protocol behavior.

## Ownership boundaries

| Concern | Owner | Contract |
|---|---|---|
| Child process and stdio | SDK `AcpAgent` owned by the Tauri Cline service | Configure only the resolved absolute Cline executable and fixed `--acp`; use the SDK-managed connection so its guard kills/reaps the process group. |
| Connection, request IDs, run state and timeouts | Tauri Cline service plus official typed client | Own one connection/run state machine, add Atomic timeouts/fences, and never build a parallel JSON-RPC transport. |
| ACP session and model binding | Tauri Cline service | Negotiate v1, create/load the session, bind the exact model, and reject mismatches. |
| Agent reasoning and internal tool loop | Cline | Atomic must not execute a tool merely because a Cline tool event was observed. |
| User interaction and permission decision | Atomic UI plus Tauri Cline service | UI presents the request; the service correlates and returns exactly one ACP response. |
| File and command execution after approval | Cline | Initial client capabilities advertise no Atomic-owned filesystem or terminal execution. Cline performs its own approved operation. |
| Visible transcript and Atomic coding history | Atomic frontend store | Persist normalized visible events plus explicit backend/provider/model/external-session identity. |
| Cline conversation state | Cline | ACP `sessionId` is opaque and is used for `session/load`; Atomic does not reconstruct hidden Cline state. |
| Ollama lifecycle and model management | Existing Ollama path | Ollama health, installed-model, VRAM, pull and restart behavior never gates Cline. |
| Loop scheduling and supervision | Existing Atomic Loop services | Not connected to Cline until Stages 18-19; manual and Loop runs stay isolated. |

ACP is not an operating-system sandbox. Atomic must not advertise `fs/read_text_file`, `fs/write_text_file` or terminal client capabilities in the initial connection. Cline's own sandbox or command policies may be additional defense, but are not a replacement for explicit ACP permission handling.

## Connection and turn lifecycle

1. Resolve the Cline executable in the Tauri host without relying on the renderer's shell `PATH`.
2. Build `AcpAgentConfig` from that absolute path plus fixed argument `--acp`, then connect through `AcpAgent`; stdout is protocol-only and SDK stderr capture remains bounded to 64 KiB.
3. Send `initialize` with protocol version `1`, Atomic client identity, and conservative `clientCapabilities`: `fs.readTextFile = false`, `fs.writeTextFile = false`, `terminal = false`, and no authentication capability. MCP servers and working directories are session inputs, not initialize capabilities.
4. Reject an unsupported negotiated protocol version. Store the returned agent identity, capabilities, authentication methods and session capabilities for this connection.
5. Create with `session/new`, or restore with `session/load` only when the persisted external session belongs to the same canonical project directory and backend identity. Both requests use an absolute canonical `cwd`, `mcpServers: []`, and `additionalDirectories: []` where the stable request supports it; Atomic forwards no global MCP configuration.
6. Bind `zai/glm-5.3-flash` through the stable-v1 `session/set_config_option` route using the returned `model` config option. Require a successful response and matching returned/current config state before prompting. Cline 3.0.61 also answered a nonstandard `session/set_model` probe, but that method is not in the stable typed SDK and is observation-only: Atomic must not implement or fall back to it.
7. Send `session/prompt` with the external `sessionId` and supported content blocks. Keep one active prompt turn per Atomic run.
8. Process bidirectional messages until the matching prompt response returns a terminal `stopReason`, or until cancellation/transport failure closes the run.
9. Keep the child reusable only while its connection remains healthy. On shutdown, timeout, malformed framing or unrecoverable protocol error, reject pending permissions, emit one terminal result and reap the owned child.

Authentication is not part of the initial UI contract. Existing Cline credentials may be reused. If `initialize` or `session/new` reports authentication is required, Atomic must show a bounded unavailable/auth-required error and stop; it must not initiate login, copy credentials or persist secrets.

## ACP-to-Atomic method mapping

| ACP direction and method | Atomic action | Initial status |
|---|---|---|
| Client to agent `initialize` | Start connection and negotiate protocol/capabilities | Required |
| Client to agent `session/new` | Create a Cline conversation for a canonical project directory | Required |
| Client to agent `session/load` | Restore an explicitly matched persisted external session | Required when `loadSession` is advertised |
| Client to agent `session/set_config_option` | Bind the model through returned config metadata | Required stable-v1 route when the `model` option is returned |
| Client to agent `session/set_model` | Nonstandard Cline 3.0.61 observation | Not implemented and never a fallback |
| Client to agent `session/set_mode` | Plan/Act selection | Not exercised in Stage 02; not enabled initially |
| Client to agent `session/prompt` | Start one user turn | Required |
| Agent to client `session/update` | Normalize visible stream/tool/session updates | Required |
| Agent to client `session/request_permission` | Create a correlated pending permission and wait for explicit decision | Protocol handler required before tool acceptance; live Cline path unverified |
| Client to agent `session/cancel` | Cancel the active session turn | Required; notification, no response expected |
| Client to agent `session/close` | Graceful session cleanup if supported | Not exercised; do not rely on it for teardown |
| `session/list`, `session/fork`, `session/resume` | No Atomic UI behavior in the initial integration | Not exercised and not enabled |
| Client filesystem/terminal methods | No handler and no advertised capability | Unavailable initially |
| Authentication/logout methods | No automatic browser/login/logout flow | Unavailable initially |

Unknown methods that expect a response receive a standard JSON-RPC method-not-found error. Unknown notifications are ignored with bounded diagnostics. Unknown `session/update` variants do not fail the turn unless they violate framing or required identity fields.

## Stream and event mapping

Every incoming session-scoped message must match the active external `sessionId`. Every event sent to the renderer must also carry Atomic `runId` and backend identity so late events cannot mutate a newer run.

| ACP update/result | Atomic normalized meaning | Rules |
|---|---|---|
| `agent_message_chunk` | `text_delta` | Preserve order and visible text only. |
| `agent_thought_chunk` | `thinking` | Show only content explicitly delivered by ACP; never synthesize reasoning. |
| `tool_call` | `tool_start` | Preserve opaque `toolCallId`, title/kind, safe input summary and locations. Observation never executes a tool. |
| `tool_call_update` | update/result for the same tool | Preserve status transitions. Map completed/failed output only when visible and bounded. |
| diff/tool content | proposed/applied presentation | Do not claim a proposed diff was applied. Detailed mapping remains gated by Stage 12. |
| `session_info_update` and config/mode updates | session metadata/capability state | Must not be appended as invented assistant text. |
| matching `session/prompt` response | `done` | `end_turn` is success; `cancelled` is user stop; other stop reasons are mapped explicitly. Exactly one terminal event. |
| JSON-RPC error, malformed message, EOF or child exit | `error` then `done` | Preserve a sanitized reason, reject pending requests and terminate once. |

The existing normalized event union lacks run/backend/session identity and a generic permission lifecycle. Stages 08 and 11 may extend it narrowly. Existing Ollama diff approval commands must not be reused for ACP permission replies.

## Permission contract

- Default is ask/deny-safe. Atomic never launches Cline with auto-approval and never converts the existing Loop prompt permission shortcut into ACP approval.
- A pending permission is identified by Atomic `runId`, backend, external `sessionId`, JSON-RPC request ID and ACP `toolCallId`.
- The UI displays only the options supplied by the agent, with the operation title/kind, affected locations and a bounded safe summary.
- Atomic returns exactly the selected ACP permission outcome. Errors, missing IDs, stale/duplicate replies and unknown options never become approval.
- Cancelling a turn while a request is pending sends `session/cancel` and answers the permission request with the ACP cancelled outcome, as required by ACP v1.
- A permission response authorizes only that request. It does not authorize future tools, the entire session, Loop runs or a different backend.
- Cline owns the post-approval execution. Atomic treats later tool/diff updates as reports and does not apply the same change again.

## Identity and persistence contract

The following identities are distinct and must never be collapsed into one display string:

| Field | Meaning |
|---|---|
| `backend` | Atomic execution route: `direct-ollama`, legacy value, or `cline-acp`. |
| `providerId` | Optional verified provider namespace. `zai` is currently derived from `modelId`; persist it only after catalog/config verification. |
| `modelId` | Exact ACP model catalog ID, currently `zai/glm-5.3-flash`. |
| `atomicSessionId` | Existing Atomic history record ID. |
| `externalSessionId` | Opaque Cline ACP session ID used only with Cline session methods. |
| `runId` | One Atomic execution attempt; fences renderer events and stop/permission routing. |
| `requestId` | One JSON-RPC request/response correlation ID. |
| `toolCallId` | Opaque ACP tool lifecycle identity. |

The persisted coding-session schema will later add optional backend/provider/model/external-session metadata with a versioned migration. Missing metadata means a legacy session and must continue to load as visible history. Runtime runs are never auto-resumed after restart. A load failure preserves the visible Atomic history, marks the external session unavailable and requires an explicit new Cline session; it never silently submits the last prompt again.

`session/load` restoration and an active prompt are separate phases. Atomic allocates a restore epoch before load and buffers session-scoped updates under that epoch. Restored transcript/tool notifications validate the external session but are suppressed from the visible Atomic history, which remains canonical; they must never be appended blindly. Only session/config identity needed for the mapping is retained. After the load response completes, Atomic closes the restore epoch, verifies the session/model identity, and allocates a fresh `runId` for the next explicit prompt. Any late restore notification stays fenced to the restore epoch and cannot mutate that prompt run. If a future protocol provides stable message identities, a versioned migration may replace suppression with explicit identity-based reconciliation, but content comparison is never a dedupe key.

Canonical project directory matching is required before `session/load`. Provider switching creates a new provider session and uses bounded Atomic conversation context only as specified in Stage 14; it does not reuse an external session from another backend/provider/project.

## Capability matrix frozen for implementation

| Feature | Cline ACP state | Contract / later gate |
|---|---|---|
| Manual text prompt | Supported by installed probe | Implement in Stages 05-09. |
| Incremental visible text | Supported | Normalize in Stage 08. |
| Visible thought chunks | Supported when emitted | Preserve explicitly visible chunks only. |
| Exact GLM model binding | Supported by installed probe | Stage 07 must fail on mismatch; no fallback. |
| New/load session | Supported by installed probe | Stage 07 plus persistence in Stage 13. |
| Cancellation | Supported by installed probe | Process cleanup and late-event fencing in Stage 06. |
| Permission requests | Protocol handler policy defined; the Stage 02 reject handler was armed but never invoked | Live Cline request/response and zero-side-effect denial remain unverified until Stages 11-12. |
| Cline-owned edits and commands | Supported in principle, not accepted end to end | Stage 12 disposable-fixture acceptance required. |
| Images | Agent advertised support | Not part of initial text integration; UI support pending explicit scope. |
| Audio / embedded context | Agent advertised unsupported | Unavailable. |
| Atomic conversation history | Existing visible history only | Add explicit identity in Stage 13; switching rules in Stage 14. |
| Ollama health/model/pull/restart/VRAM | Not applicable | Must never gate or run for Cline. |
| Atomic LSP, planner, diagnostics, validators | Not inherited | Audit in Stage 16; advertise only verified integrations. |
| Atomic/global MCP tools | Not forwarded | Stage 16-17 decision; never copy machine-global config or secrets. |
| Bounded Loop runs | Not connected | Stages 18-19 only; no blanket auto-approval. |
| Packaged desktop executable discovery | Not yet verified | Stage 21 acceptance gate. |

## Compatibility and failure rules

- Preserve `direct-ollama` as the default and preserve legacy stored backend values.
- Cline basic manual use must not depend on an Ollama process. Optional Atomic features that still require Ollama must be labelled separately and disabled without blocking Cline.
- Do not use ClineMcp as the interactive transport; its final-result buffering does not satisfy bidirectional streaming, correlation or permissions.
- Do not import the OpenWork/Superset product architecture. Its examples remain reference material only.
- Reject oversized frames, duplicate terminal responses, response-ID mismatches, session-ID mismatches and concurrent cross-backend starts.
- Stop must target the backend/run that actually started, even if the selection changes in the UI.
- Never interpolate a shell command, inherit a renderer-supplied executable, install/update Cline automatically, alter global Cline configuration, or expose credentials in events/logs.
- Protocol additions are capability-gated. Stable ACP v1 behavior is the compatibility target; draft v2 behavior is out of scope.

## Planned implementation ownership

Names remain provisional until their implementation stage, but responsibilities are fixed:

- `src-tauri/src/core/cline_acp_transport.rs`: thin `AcpAgentConfig`/`AcpAgent` adapter, absolute executable resolution, fixed arguments, bounded diagnostic policy and transport errors.
- `src-tauri/src/core/cline_agent.rs`: owns the SDK connection plus session/run state, model binding, permissions, cancellation and Atomic event emission; the SDK guard owns subprocess teardown.
- `src-tauri/src/core/mod.rs` and `src-tauri/src/lib.rs`: module/state/command registration only.
- `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`: backend identity and ACP event normalization.
- `web-app/src/containers/CodingAgentPanel/index.tsx`: provider-aware routing and UI orchestration; Ollama-specific checks remain in the Ollama branch.
- `web-app/src/stores/coding-agent-store.ts`: versioned optional identity metadata and interrupted-session state.
- Any new provider selector styling must remain in a separate style file.

## References verified for Stage 03

- ACP v1 overview and method ownership: <https://agentclientprotocol.com/protocol/v1/overview>
- ACP v1 schema, including permission and tool update shapes: <https://agentclientprotocol.com/protocol/v1/schema>
- Official ACP Rust SDK and license: <https://github.com/agentclientprotocol/rust-sdk>
- Official SDK API and current crate version: <https://docs.rs/agent-client-protocol/latest/agent_client_protocol/>
- Official SDK toolchain metadata: <https://raw.githubusercontent.com/agentclientprotocol/rust-sdk/main/Cargo.toml>
- Cline ACP behavior and executable discovery guidance: <https://github.com/cline/cline/blob/main/docs/usage/acp.mdx>
- Cline CLI reference and command-policy environment: <https://docs.cline.bot/cli/cli-reference>
