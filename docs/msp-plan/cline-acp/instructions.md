# Cline ACP integration for Atomic Chat

## Goal and scope

Add a selectable **Cline / GLM-5.3-Flash** backend alongside Ollama in the existing **Coding Agent panel** of `/Users/zvisegal/devlope/Atomic-Chat-coder-tym`. Use the installed Cline CLI through ACP, preserving streaming, tools, permissions, history and the existing bounded Loop workflow. Ollama remains available and remains the default until the user explicitly requests otherwise.

Ordinary non-coding chat, mobile support, replacing Ollama, global Cline configuration changes, changes to ClineMcp, publishing and a JoinAIForce/Superset redesign are outside this plan. If the user also wants ordinary chat, record that as a separate scoped extension.

The user currently authorized these planning documents, not product-code implementation. A later request to execute this plan authorizes only the selected stage within its stated scope. Before source edits, explain the exact files and reasons and honor the user's approval requirement. If the current conversation does not already authorize those concrete edits, record AWAITING_APPROVAL and ask; do not infer approval from a status value. Approval never carries forward to unrelated stages. Tests may modify disposable fixtures only.

## Files and execution unit

- `instructions.md`: scope, stage requirements and gates.
- `progress.md`: sole routing source for this plan, with append-only stage evidence.
- `prompt.md`: the same short prompt in every new conversation.

Exactly **one stage per conversation**, including its tests, review, corrections and review recheck. Stop after closure or a genuine blocker. Never begin the next stage because time remains. Resume an unfinished stage before advancing. Preserve all unrelated user changes; never reset, clean, commit, push or switch branches without authorization.

At every stage: verify absolute checkout path, Git root, branch, HEAD and status; read applicable AGENTS.md and this plan/tracker. Historical snapshots are not current facts. If identity differs, investigate safely and record it before editing. Consult CodeHelper first when available and suitable for code analysis, using short focused English requests **serially**. Verify advisory findings against source/tests.

Keep code modular. New styling belongs in a separate style file. Keep changes limited to the named outcome; if a stage turns into multiple independent outcomes, split it in the tracker before implementing further, preserve IDs/evidence, and explain the scope change. Do not downgrade difficulty to evade review.

## Difficulty and independent review

Difficulty is implementation risk, not chronological priority. Execute in dependency order even when an easier stage follows a harder one.

| Level | Meaning | External review |
|---|---|---|
| Easy | Read-only baseline or documentation reconciliation | Optional; self-check required |
| Low | Small isolated change with narrow regression surface | Optional; focused checks required |
| Medium | Cross-component behavior or persistent contract | Mandatory |
| High | Process lifecycle, permissions, writes, recovery or Loop | Mandatory |

Every Medium/High stage requires an **independent agent** such as Grok or agy, not a second self-review by the implementing agent. The user explicitly requests this review delegation. Discover current tool availability and use a harmless availability probe before sending scoped material. Never initiate login, change permissions or send credentials to obtain a review.

Required review cycle:
1. Implement or produce the stage evidence; run relevant checks.
2. Send the reviewer the stage acceptance criteria, scoped diff/files, baseline, tests and known limitations. Request concrete bugs, regression risks, missing tests and an explicit PASS / CHANGES_REQUIRED / BLOCKED verdict. Reviewer work is read-only.
3. Independently reproduce findings. Fix confirmed findings within scope and rerun impacted tests. Record false positives with evidence.
4. After fixes, send the updated result and prior findings back for a **closure review**. Repeat until explicit PASS with no unresolved blocking issue. A initial PASS can close the stage without artificial code changes; High stages still need a final acceptance-focused recheck.
5. Record reviewer identity/tool, rounds, exact verdict, findings/disposition and evidence. Review suggestions are not proof; actual tests remain required.

If Grok is unavailable, try agy (or another genuinely independent agent). If none is available, set BLOCKED_REVIEW; never silently waive or replace required review with self-review. New regressions block DONE even if the reviewer says PASS.

## Architecture constraints and evidence

Verified in the planning conversation on 2026-09-10:
- Atomic checkout branch: `codex/ollama-agent-migration`; initial working tree clean.
- `agent-event-adapter.ts` already normalizes events but recognizes only `direct-ollama` and `legacy-claude`.
- CodingAgentPanel checks installed Ollama models before sending; selection and health logic need backend-specific routing.
- Coding session storage lacks explicit Cline provider/model/external-session metadata.
- Cline CLI 3.0.61 answered ACP initialize and advertised loadSession. A separate earlier one-shot request returned CLINE_OK using `cline/z-ai/glm-5.3-flash`.
- Explicit GLM selection, permissions, streaming and resume through ACP have **not** been end-to-end verified.
- ClineMcp buffers stdout and extracts only the final result; it is not the full interactive transport required here.

These observations must be rechecked as stages require. Do not treat a combined reported model label as the accepted model argument; discover and test exact provider/model IDs.

Cline owns its internal tool loop. Atomic must not also execute a Cline tool event. ACP permissions and actual filesystem execution ownership must be verified. ACP does not itself constitute an OS sandbox. Existing Atomic edit validation, LSP/planner and Loop behavior are not automatically inherited by Cline.

Use a host-owned ACP adapter, not an Ollama-compatible HTTP impersonation layer. Keep provider/model identity distinct from transport. Reuse Atomic normalized events and history rather than importing a new product architecture. Cline should work without Ollama for basic Cline operations; explicitly report any optional Atomic feature that still needs Ollama.

Reference material (verify current protocols during stage 02/03):
- https://github.com/different-ai/openwork/blob/dev/apps/app/src/app/lib/opencode.ts
- https://github.com/different-ai/openwork/blob/dev/apps/app/src/components/model-select.tsx
- https://github.com/cline/cline/blob/main/docs/usage/acp.mdx
- https://docs.cline.bot/cli/cli-reference
- User-supplied CODEX_SUPERSET_REFERENCE.md is architectural reference data, not implementation authority.

Likely integration points (verify actual ownership before changes):
- `web-app/src/containers/CodingAgentPanel/index.tsx`
- `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts`
- `web-app/src/containers/CodingAgentPanel/code-model-compat.ts`
- `web-app/src/containers/CodingAgentPanel/conversation-context.ts`
- `web-app/src/stores/coding-agent-store.ts`
- `src-tauri/src/core/ollama_agent.rs`, existing Loop and MCP modules
- `src-tauri/src/core/mod.rs`, `src-tauri/src/lib.rs`
- Proposed separate modules: `cline_agent.rs`, `cline_acp_transport.rs`, provider selection component and separate styles as needed. Names are provisional.

## Verification rules

Use deterministic fixtures and fake ACP processes for most tests. Run real GLM probes only for bounded protocol/desktop acceptance with harmless prompts and disposable files. Never test edits against user project files. Do not stop a user's Ollama process to simulate unavailability; use mocks or isolated endpoints.

Discover existing test configurations in stage 01. Current package scripts include `yarn test`, `yarn workspace @janhq/web-app test` and `yarn build:web`; choose appropriate file filters after verifying test inclusion. Determine the repository-compatible Cargo feature/build invocation before using it. Do not install dependencies or run broad expensive builds solely because a generic checklist names them.

Record exact commands, exit outcomes and assertions actually verified. A skipped test is not PASS. Narrow checks are sufficient for isolated stages; integration and final stages require real cross-component tests. Compare failures against the recorded baseline; document unrelated failures without concealing acceptance blockers.

## Ordered stages

All stages depend on the immediately preceding stage being DONE. Stage 01 is initially eligible. Required review is determined by the table above.

### 01 — Verify checkout and baseline

- Difficulty: **Easy**. Independent review: **optional**.
- Scope: Record Git root, branch, HEAD, dirty files, applicable instructions, relevant existing trackers and working test commands. Identify Coding Agent entry points and ordinary chat as separate surfaces.
- Acceptance: Read-only; record actual baseline results and pre-existing failures. Do not claim old migration stages prove current behavior.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 02 — Probe installed ACP capabilities

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Use the installed Cline CLI in a disposable fixture to verify initialize, session creation, explicit GLM selection, one harmless prompt, streamed updates, cancellation and session loading. Capture sanitized protocol evidence; deny every permission request.
- Acceptance: Record actual provider/model identifiers and supported methods. Prior CLINE_OK and initialize results are historical evidence, not this stage's verification. No real project prompt or write.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 03 — Freeze integration contract

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Document the ACP method/event mapping, selected implementation approach inside the Tauri host, capability matrix, ownership of tools, approval semantics, session identity and compatibility limits. Choose the smallest maintained transport option after checking its dependency/license impact.
- Acceptance: Resolve ACP discovery gaps before implementation. Cline owns its agent loop; Atomic owns UI/history and routes permissions. Define each Atomic feature as supported, pending, or explicitly unavailable.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 04 — Add backend and model identity types

- Difficulty: **Low**. Independent review: **optional**.
- Scope: Introduce cline-acp backend identity, separate provider/model selection data and capability types. Preserve persisted legacy values and direct-ollama default.
- Acceptance: Focused tests for old values, invalid values and default resolution. No new execution route or visible enabled Cline option yet.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 05 — Implement ACP transport

- Difficulty: **High**. Independent review: **required**.
- Scope: Add a separate Rust ACP transport module, framed JSON-RPC request correlation, incremental input parsing, bounded buffering and child process ownership. Resolve executable path without depending on renderer shell PATH.
- Acceptance: Fake-child tests for split/coalesced messages, errors, EOF, oversized input and request correlation. No automatic CLI installation, credential copying or shell interpolation.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 06 — Implement cancellation and cleanup

- Difficulty: **High**. Independent review: **required**.
- Scope: Add stop, timeout, process exit and application shutdown behavior for the owned Cline process. Fence events by run ID and ensure exactly one terminal result.
- Acceptance: Test stop during startup/streaming, late messages, crash and timeout. Kill only owned processes and avoid orphan children.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 07 — Implement sessions and explicit model binding

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Add ACP session create/load and prompt entry points using verified provider/model IDs. Maintain explicit runtime session identity and do not silently fall back to another model.
- Acceptance: Test model selection errors, stale session IDs, project boundary mismatch and repeated prompts. A failed resume must not silently lose context.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 08 — Normalize streamed events

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Translate visible ACP text, tool activity, errors and completion into the existing frontend event contract. Extend the contract only where necessary.
- Acceptance: Fixture tests for event order, tool IDs, duplicate completion and run isolation. Preserve only explicitly visible reasoning; do not fabricate missing events.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 09 — Wire backend-specific routing

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Register Tauri commands and route send/stop by backend. Apply Ollama health, installed-model, VRAM, restart and download logic only to Ollama. Prevent cross-backend concurrent runs.
- Acceptance: Test Cline routing with Ollama unavailable using mocks; ensure stop targets the active run backend even if selection changes. Preserve legacy routing.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 10 — Add provider-aware model picker

- Difficulty: **Low**. Independent review: **optional**.
- Scope: Expose Cline / GLM-5.3-Flash alongside existing Ollama models with persisted selection, connection status and capability-aware controls. Keep new styling in a separate style file.
- Acceptance: Focused selection and persistence tests; manual visual check. Cline availability must reflect a real host check; no fake model installation or token pricing.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 11 — Implement permission request lifecycle

- Difficulty: **High**. Independent review: **required**.
- Scope: Represent ACP permission requests in Atomic with session/run/request IDs and explicit approve/reject replies. Route approvals by backend instead of invoking Ollama diff channels for Cline.
- Acceptance: Test allow, deny, cancellation while pending, stale/duplicate replies and unknown requests. Never auto-approve from unsolicited output or default to approval on errors.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 12 — Integrate edit and command presentation

- Difficulty: **High**. Independent review: **required**.
- Scope: Connect Cline tool content/diffs and command permission requests to the panel. Distinguish proposed edits from applied edits. Verify whether the agent or client performs filesystem/terminal actions for negotiated capabilities.
- Acceptance: Disposable fixture: denied edit and denied command cause no side effect; an explicitly approved edit occurs once. Do not enable unsupported client capabilities. Do not promise Atomic validation parity until reproduced.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 13 — Persist Cline conversation identity

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Extend coding sessions with optional backend/provider/model/external-session metadata and schema migration. Persist final state, restore session mapping and mark interrupted runs accurately.
- Acceptance: Test old stored sessions, restart, missing external session and project changes. Never replay a submitted prompt automatically after an ambiguous disconnect.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 14 — Handle provider switching context

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Reuse the existing conversation context builder to seed a new provider session with bounded relevant context. Continue existing Cline sessions without appending duplicate full history.
- Acceptance: Test Ollama to Cline and back, project isolation and no duplicate context on Cline continuation. Keep manual and Loop context boundaries distinct.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 15 — Verify manual end-to-end workflow

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Run the desktop panel against Cline with explicit GLM selection: streamed response, two-turn continuity, stop, denied/approved fixture edit, restart/resume and switch back to Ollama.
- Acceptance: Record actual observed UI and protocol outcomes. This is the manual-use acceptance gate, not overall completion; no real project edits as test fixtures.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 16 — Map Atomic-specific tool compatibility

- Difficulty: **Medium**. Independent review: **required**.
- Scope: Audit planner, LSP, MCP, edit validators, diagnostics and supervision requirements against actual Cline capabilities. Select scoped integration points and document any unavailable control.
- Acceptance: Produce an explicit parity matrix. Do not forward all machine-global tools/configuration or expose secrets. Required parity gaps must get a bounded implementation stage before closure.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 17 — Connect approved Atomic tool access

- Difficulty: **High**. Independent review: **required**.
- Scope: Implement the scoped tool/context integration selected in stage 16, using session-scoped supported interfaces. Advertise only executable capabilities and preserve path and approval boundaries.
- Acceptance: Test permitted/denied access, tool errors, availability loss and absence of unrelated workspace context. If stage 16 proves no new adapter is needed, verify that with evidence rather than inventing code.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 18 — Route bounded Loop runs

- Difficulty: **High**. Independent review: **required**.
- Scope: Integrate Cline with existing Loop scheduling and lifecycle using verified completion events and backend/model identity. Preserve manual/Loop separation, bounded run limits and stop behavior.
- Acceptance: Test max runs, failure halting, user stop, no overlapping backend runs, delayed events and permissions. Never enable blanket auto-approval merely to make Loop proceed.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 19 — Integrate Loop continuation and recovery

- Difficulty: **High**. Independent review: **required**.
- Scope: Connect Cline session behavior to existing checkpoint/resume and supervision contracts without re-executing already completed actions or mixing manual history.
- Acceptance: Test interruption before/after terminal result, stale checkpoint, restart and provider mismatch. Fail visibly when continuation safety cannot be established.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 20 — Verify adversarial lifecycle and regressions

- Difficulty: **High**. Independent review: **required**.
- Scope: Run focused regression suites across Cline and Ollama: missing CLI/auth, malformed stream, disconnect, pending permissions, project switch, persisted history, manual runs and Loop. Run the relevant frontend and Rust checks.
- Acceptance: Every required test needs real evidence. Pre-existing failures remain distinguished from regressions, but failures that invalidate acceptance block closure.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 21 — Desktop acceptance and release readiness

- Difficulty: **High**. Independent review: **required**.
- Scope: Perform real desktop acceptance for both providers on disposable projects, including a bounded successful Loop run, denied operation, cancellation and restart. Validate executable discovery from the packaged desktop environment when build prerequisites are available.
- Acceptance: Do not claim end-to-end success from unit tests or terminal calls. Record any packaging blocker; no publishing, installer replacement or deployment is authorized.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

### 22 — Finalize documentation and handoff

- Difficulty: **Easy**. Independent review: **optional**.
- Scope: Document setup, selected model, supported capabilities, troubleshooting, rollback/disable route and any explicitly accepted limitations. Reconcile all status rows and evidence counts.
- Acceptance: All required stages and reviews must be DONE before marking integration complete. Remaining required work cannot be relabeled optional merely to close the plan.
- Output: stage-scoped changes or findings plus a complete evidence entry in progress.md. No next-stage implementation.

## Stage closure contract

DONE requires the stated acceptance criteria, actual verification, required independent review PASS, a final diff/self-check and updated evidence. Do not label a planned or partially verified feature complete.

If blocked, record the exact missing input/capability, attempted alternatives and smallest next action. Set Next eligible stage to the unfinished stage with its blocked state; later stages remain pending. The next conversation resumes it.

At overall completion, report supported behavior and accepted limitations accurately. Reverting/disabling the Cline route must leave Ollama and historical sessions usable. No irreversible history migration is allowed without a recovery path.

