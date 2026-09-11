# Cline ACP integration progress

## Routing

- Target: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym`
- Plan: `docs/msp-plan/cline-acp/instructions.md`
- Created: 2026-09-10
- Overall status: IN_PROGRESS — stage 04 complete; stopped at the one-stage boundary
- Completed: **4 / 22**
- Current stage: none (04 DONE)
- Next eligible stage: **05** — Implement ACP transport (High, independent review required)
- Blocking issue: none
- Authorization: planning documents only; explain exact source edits and obtain approval as required by instructions.md.
- Planning snapshot branch: `feat/windows-cline-cli` (branched from `codex/ollama-agent-migration`); re-verify on every run.
- Medium/High independent-review gate: mandatory; no waiver for unavailable reviewer.

## Status meanings

PENDING = not started; IN_PROGRESS = selected stage underway; AWAITING_APPROVAL = concrete edit proposal waiting for user authorization; BLOCKED = acceptance blocked; BLOCKED_REVIEW = independent review unavailable or not passed; DONE = all acceptance and review gates satisfied.

Only the first non-DONE stage may be selected. A blocked or approval-waiting stage cannot be skipped.

## Stage table

| ID | Stage | Difficulty | Independent review | Status |
|---|---|---|---|---|
| 01 | Verify checkout and baseline | Easy | Optional | DONE |
| 02 | Probe installed ACP capabilities | Medium | Required | DONE |
| 03 | Freeze integration contract | Medium | Required | DONE |
| 04 | Add backend and model identity types | Low | Optional | DONE |
| 05 | Implement ACP transport | High | Required | PENDING |
| 06 | Implement cancellation and cleanup | High | Required | PENDING |
| 07 | Implement sessions and explicit model binding | Medium | Required | PENDING |
| 08 | Normalize streamed events | Medium | Required | PENDING |
| 09 | Wire backend-specific routing | Medium | Required | PENDING |
| 10 | Add provider-aware model picker | Low | Optional | PENDING |
| 11 | Implement permission request lifecycle | High | Required | PENDING |
| 12 | Integrate edit and command presentation | High | Required | PENDING |
| 13 | Persist Cline conversation identity | Medium | Required | PENDING |
| 14 | Handle provider switching context | Medium | Required | PENDING |
| 15 | Verify manual end-to-end workflow | Medium | Required | PENDING |
| 16 | Map Atomic-specific tool compatibility | Medium | Required | PENDING |
| 17 | Connect approved Atomic tool access | High | Required | PENDING |
| 18 | Route bounded Loop runs | High | Required | PENDING |
| 19 | Integrate Loop continuation and recovery | High | Required | PENDING |
| 20 | Verify adversarial lifecycle and regressions | High | Required | PENDING |
| 21 | Desktop acceptance and release readiness | High | Required | PENDING |
| 22 | Finalize documentation and handoff | Easy | Optional | PENDING |

## Evidence log

### Stage 01 — Verify checkout and baseline (2026-09-10)

- Stage / attempt / date: Stage 01 / attempt 1 / 2026-09-10
- Checkout: absolute root, branch, HEAD: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym`, `codex/ollama-agent-migration`, `6d94529997579cd6f2732003617b81ede0045ad3`
- Starting dirty files and preservation: clean working tree, untracked `docs/msp-plan/cline-acp/` preserved.
- Approved scope and exact files explained to user: Stage 01 read-only checkout and baseline verification; no product code modified.
- Changes or read-only findings:
  - Git repository root and branch verified clean on `codex/ollama-agent-migration`.
  - Installed Cline CLI verified: version `3.0.61` at `/Users/zvisegal/.nvm/versions/node/v24.11.1/bin/cline`.
  - Coding Agent panel entry points mapped:
    - Frontend: `web-app/src/containers/CodingAgentPanel/index.tsx`, `agent-event-adapter.ts`, `code-model-compat.ts`, `conversation-context.ts`, `web-app/src/stores/coding-agent-store.ts`.
    - Rust Backend: `src-tauri/src/core/ollama_agent.rs`, loop supervision modules, MCP commands.
    - Scope bounded to Coding Agent panel; ordinary non-coding chat confirmed out-of-scope.
- Acceptance criteria verified: Checkout, branch, clean status, Cline CLI installation, entry points, and test commands verified.
- Test commands / outcomes / relevant output:
  - `yarn workspace @janhq/web-app test`: PASSED (95 test files passed, 1214 tests passed, 1 skipped).
  - `cargo check` (in `src-tauri`): PASSED (0 errors).
  - `cargo test --lib` (in `src-tauri`): PASSED (199 passed, 0 failed, finished in 0.45s).
- Skipped checks and reason: None.
- Reviewer name/tool and availability result: N/A (Easy difficulty; independent review optional per instructions.md).
- Review round 1 verdict and findings: N/A
- Findings reproduced / rejected with evidence: N/A
- Fixes and rerun results: N/A
- Closure review verdict (High always; Medium after fixes): N/A (Self-check PASSED).
- Remaining issues / blocker / accepted limitation: None.
- Final diff self-check: Read-only stage, only tracker updated.
- Final stage status: DONE
- Completed count: 1 / 22
- Next eligible stage: 02 — Probe installed ACP capabilities (Medium, independent review required)

### Stage 02 — Probe installed ACP capabilities (2026-09-10)

- Stage / attempt / date: Stage 02 / attempt 1 / 2026-09-10
- Checkout: absolute root, branch, HEAD: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym`, `codex/ollama-agent-migration`, `6d94529997579cd6f2732003617b81ede0045ad3`
- Starting dirty files and preservation: clean working tree, untracked `docs/msp-plan/cline-acp/` preserved.
- Approved scope and exact files explained to user: Stage 02 read-only ACP capability probe using disposable fixture; no product code modified.
- Changes or read-only findings:
  - Disposable fixture used: `/Users/zvisegal/.gemini/antigravity-ide/brain/324ce234-9846-48ea-b854-1b0c5e764cc7/scratch/stage02_fixture`.
  - Cline CLI binary: `cline` v3.0.61 (`/Users/zvisegal/.nvm/versions/node/v24.11.1/bin/cline`).
  - Protocol: JSON-RPC 2.0 over stdio (`cline --acp`).
  - Methods tested and confirmed supported:
    - `initialize`: returns `protocolVersion: 1`, `agentInfo: { name: 'cline', version: '3.0.61' }`, `agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } }`.
    - `session/new`: creates session, returns `sessionId`, `modes` (`plan`, `act`), `models`, `configOptions`.
    - `session/set_model`: accepts `{ sessionId, modelId }`, verified with `modelId: "zai/glm-5.3-flash"`.
    - `session/set_config_option`: accepts `{ sessionId, configId: "model", value: "zai/glm-5.3-flash" }`, updates `currentValue` to `"zai/glm-5.3-flash"`.
    - `session/prompt`: sends prompt content array, streams notifications (`agent_thought_chunk`, `agent_message_chunk`, `session_info_update`), returns terminal response with `stopReason: "end_turn"`.
    - `session/cancel`: client notification cancels active turn, prompt response returns `stopReason: "cancelled"`.
    - `session/load`: restores previous session state by `sessionId`.
    - `session/request_permission`: client rejection guardrail confirmed.
- Acceptance criteria verified:
  - Exact provider/model verified: provider `"cline"`, model `"zai/glm-5.3-flash"` (display name "GLM 5.3 Flash").
  - Harmless math prompt (`17 + 25`) streamed answer `42` with thoughts.
  - Zero project files modified, zero git commits made.
- Test commands / outcomes / relevant output:
  - Probe suite (`scratch/stage02_full_probe.mjs`): All probes passed (exit code 0).
- Skipped checks and reason: None.
- Reviewer name/tool and availability result: `agy` CLI (`/Users/zvisegal/.local/bin/agy` v1.1.28). Availability probe confirmed (`AGY_OK`).
- Review round 1 verdict and findings: PASS. Verified all 9 acceptance criteria with zero regressions and clean protocol adherence.
- Findings reproduced / rejected with evidence: N/A (clean PASS).
- Fixes and rerun results: N/A.
- Closure review verdict (High always; Medium after fixes): PASS on Round 1.
- Remaining issues / blocker / accepted limitation: None.
- Final diff self-check: Read-only stage, only tracker updated, no git commit.
- Final stage status: DONE
- Completed count: 2 / 22
- Next eligible stage: 03 — Freeze integration contract (Medium, independent review required)

#### Stage 02 evidence reconciliation recorded during Stage 03 (2026-09-10)

- The disposable probe installed a deny handler for `session/request_permission`, but the harmless prompt did not cause Cline to send that request. The handler policy was armed; live rejection and zero-side-effect denial were not exercised.
- `session/set_mode`, `session/close`, `session/list`, `session/fork`, and `session/resume` were not exercised by the retained probe evidence and are not treated as supported implementation inputs.
- `session/set_model` was observed against Cline 3.0.61 but is a nonstandard extension absent from the stable-v1 typed SDK. It is observation-only; the implementation contract uses `session/set_config_option` and forbids fallback to `session/set_model`.
- Identity is reconciled as backend `cline-acp`, ACP agent `cline`, exact model `zai/glm-5.3-flash`, and optional provider `zai` only after catalog/config metadata verifies the namespace mapping. The earlier phrase provider `cline` conflated agent and provider identity.

### Stage 03 — Freeze integration contract (2026-09-10)

- Stage / attempt / date: Stage 03 / attempt 1 / 2026-09-10
- Checkout: absolute root, branch, HEAD: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym`, `codex/ollama-agent-migration`, `6d94529997579cd6f2732003617b81ede0045ad3`
- Starting dirty files and preservation: untracked `docs/msp-plan/cline-acp/instructions.md`, `progress.md`, and `prompt.md` preserved; no unrelated tracked changes at Stage 03 start.
- Approved scope and exact files explained to user: user authorized Stage 03. Contract/tracker edits were explained before change. User separately authorized the small Rust 1.88 compatibility update in `src-tauri/Cargo.toml`; no implementation dependency was added.
- Changes or read-only findings:
  - Added `docs/msp-plan/cline-acp/integration-contract.md` freezing stable ACP v1 mapping, Tauri/SDK/Cline/UI ownership, permissions, identity, restoration fencing, compatibility limits, and supported/pending/unavailable capabilities.
  - Selected official `agent-client-protocol` 2.1.0 with `default-features = false`, using `AcpAgentConfig`/`AcpAgent` rather than current-process `Stdio`; production dependency addition remains deferred to Stage 05.
  - Resolved dependency impact with Cargo metadata: native async/process graph includes `async-io`, `async-process`, `blocking`, `rustix`, and `shell-words`; all resolved third-party packages declared permissive or compatible license choices. Recheck is required against the production lockfile when added.
  - Raised only the main Tauri crate `rust-version` from 1.77.2 to 1.88.0. Plugin crates remain at their independent lower MSRV.
  - CodeHelper was used serially before manual analysis. One broad call timed out (`Errno 60`); focused calls then succeeded for `agent-event-adapter.ts`, panel routing, and coding-agent persistence.
  - Current Atomic event/routing/store gaps were mapped without changing runtime behavior. No Stage 04 implementation was started.
- Acceptance criteria verified: discovery gaps corrected; Cline owns its agent/tool loop; Atomic owns UI/history/permission routing; every initial feature is classified supported, pending, observation-only, or unavailable; transport choice and dependency/license impact are recorded.
- Test commands / outcomes / relevant output:
  - `cargo +1.88.0 check` in `src-tauri`: PASSED; only two pre-existing dead-field warnings in the llamacpp plugin.
  - `cargo +1.88.0 test --lib` in `src-tauri`: PASSED, 199 passed, 0 failed, 0 ignored.
  - `cargo +1.88.0 add agent-client-protocol@2.1.0 --dry-run --manifest-path src-tauri/Cargo.toml`: dependency resolved; dry run made no manifest or lockfile change.
  - Disposable Cargo metadata resolution for exact `agent-client-protocol = 2.1.0`, default features disabled: PASSED; license and native dependency footprint inspected.
- Skipped checks and reason: frontend suite not rerun because Stage 03 changed documentation and the Rust MSRV declaration only; the earlier 1,214-test frontend baseline remains unchanged. Packaging/mobile acceptance is explicitly deferred to Stage 21.
- Reviewer name/tool and availability result: independent subagent reviewer `stage03_review`. Initial AGY and Antigravity file-review attempts were blocked by their own headless command-permission policy; Grok responded to availability but did not produce a trustworthy file verdict. No permission bypass was used. After the fixes, the complete document contents were supplied directly to AGY in plan mode, avoiding filesystem tools; AGY returned an explicit supplementary `PASS`.
- Review round 1 verdict and findings: CHANGES_REQUIRED. Six findings: wrong SDK component ownership, nonstandard/untested method claims, overstated permission evidence, provider identity conflation, initialize/session field placement, and undefined load replay deduplication.
- Findings reproduced / rejected with evidence: all six reproduced. Local SDK source confirmed `Stdio` uses current-process stdio and `AcpAgent` owns external process lifecycle; retained Stage 02 probe confirmed the permission handler was installed but not invoked.
- Fixes and rerun results: contract and tracker corrected for all six findings; exact SDK transitive metadata and lifecycle source were rechecked.
- Closure review verdict (High always; Medium after fixes): PASS from independent `stage03_review`; all six findings resolved and Stage 03 acceptance confirmed. Supplementary second-review verdict from AGY: PASS.
- Remaining issues / blocker / accepted limitation: live permission denial remains intentionally pending Stages 11-12; production lockfile/license recheck waits for dependency addition in Stage 05; packaged discovery remains Stage 21. None blocks Stage 03.
- Final diff self-check: `git diff --check` PASSED; final checkout/status and Rust regressions rechecked; no Stage 04 implementation present.
- Final stage status: DONE
- Completed count: 3 / 22
- Next eligible stage: 04 — Add backend and model identity types (Low, independent review optional).

### Stage 04 — Add backend and model identity types (2026-09-11)

- Stage / attempt / date: Stage 04 / attempt 1 / 2026-09-11
- Checkout: absolute root, branch, HEAD: `C:\Develop\Atomic-Chat-coder-tym`, `feat/windows-cline-cli`, `a49ccd69623e1644e59ef6e8a049f7e522e84732`
- Starting dirty files and preservation: clean tree upon branch checkout; untracked Stage 04 modules created.
- Approved scope and exact files explained to user: User explicitly reviewed and approved Stage 04 files and scope in conversation.
- Changes or read-only findings:
  - Created `web-app/src/containers/CodingAgentPanel/backend-identity.ts` defining:
    - `CodingAgentBackend = 'direct-ollama' | 'legacy-claude' | 'cline-acp'`
    - `DEFAULT_CODING_AGENT_BACKEND: CodingAgentBackend = 'direct-ollama'`
    - `CODING_AGENT_BACKEND_STORAGE_KEY = 'coding-agent-backend'`
    - `CLINE_ACP_BACKEND: CodingAgentBackend = 'cline-acp'`
    - `CLINE_ACP_AGENT_NAME = 'cline'`
    - `CLINE_DEFAULT_MODEL_ID = 'zai/glm-5.3-flash'`
    - `CLINE_DEFAULT_MODEL_DISPLAY_NAME = 'GLM 5.3 Flash'`
    - `CLINE_DEFAULT_PROVIDER_ID = 'zai'`
    - `BackendCapabilities` matrix for each backend
    - Predicate `isCodingAgentBackend(value)` and safe resolver `resolveCodingAgentBackend(value, fallback)`
    - Storage helper `getInitialCodingAgentBackend()` falling back conservatively to `direct-ollama`
  - Updated `web-app/src/containers/CodingAgentPanel/agent-event-adapter.ts` to re-export types and helpers from `backend-identity.ts` for full backward compatibility.
  - Created `web-app/src/containers/CodingAgentPanel/backend-identity.test.ts` with 16 focused unit tests covering predicate checks, legacy values, invalid values, default fallback, storage retrieval, model identity, and backend capability mappings.
  - Verified no active execution route or visible UI dropdown is exposed yet for `cline-acp` (reserved for subsequent stages).
- Acceptance criteria verified:
  - Focused tests for old values, invalid values, and default resolution pass.
  - `direct-ollama` remains the strict default.
  - Zero regressions across existing CodingAgentPanel test suite (37/37 tests pass).
  - TypeScript type check (`tsc --noEmit`) passes cleanly with 0 errors.
- Test commands / outcomes / relevant output:
  - `corepack yarn workspace @janhq/web-app test run src/containers/CodingAgentPanel/backend-identity.test.ts`: PASSED (16/16 tests passed).
  - `corepack yarn workspace @janhq/web-app test run src/containers/CodingAgentPanel/`: PASSED (5 test files, 37/37 tests passed).
  - `corepack yarn workspace @janhq/web-app tsc --noEmit`: PASSED (0 errors).
- Skipped checks and reason: Independent external review (Low difficulty, optional per instructions.md; self-check passed).
- Reviewer name/tool and availability result: N/A (Low difficulty, self-check passed).
- Review round 1 verdict and findings: N/A
- Findings reproduced / rejected with evidence: N/A
- Fixes and rerun results: N/A
- Closure review verdict (High always; Medium after fixes): N/A (Self-check PASSED).
- Remaining issues / blocker / accepted limitation: None.
- Final diff self-check: Checked git status and diff; only targeted Stage 04 files and tracker updated.
- Final stage status: DONE
- Completed count: 4 / 22
- Next eligible stage: 05 — Implement ACP transport (High, independent review required).

Append one entry per execution/review attempt; retain earlier entries when resuming a stage.

### Entry template

- Stage / attempt / date:
- Checkout: absolute root, branch, HEAD:
- Starting dirty files and preservation:
- Approved scope and exact files explained to user:
- Changes or read-only findings:
- Acceptance criteria verified:
- Test commands / outcomes / relevant output:
- Skipped checks and reason:
- Reviewer name/tool and availability result:
- Review round 1 verdict and findings:
- Findings reproduced / rejected with evidence:
- Fixes and rerun results:
- Closure review verdict (High always; Medium after fixes):
- Remaining issues / blocker / accepted limitation:
- Final diff self-check:
- Final stage status:
- Completed count:
- Next eligible stage:

Use N/A with a reason for optional review stages. Do not write PASS for a check that was not executed.

## Decisions and capability matrix

- **CLI Version**: Cline CLI 3.0.61.
- **Backend, Agent, Provider & Model Identifiers**: backend `cline-acp`; ACP agent `cline`; exact model `zai/glm-5.3-flash` (display name "GLM 5.3 Flash"); optional provider `zai` only after returned catalog/config metadata verifies that namespace mapping.
- **Verified stable-v1 implementation methods**:
  - `initialize` (protocolVersion: 1)
  - `session/new`
  - `session/load`
  - `session/prompt`
  - `session/cancel`
  - `session/set_config_option`
- **Observation-only nonstandard method**: Cline 3.0.61 answered `session/set_model`; Atomic will not implement or fall back to it.
- **Not exercised / not initially enabled**: `session/set_mode`, `session/close`, `session/list`, `session/fork`, and `session/resume`.
- **Permission lifecycle**: `session/request_permission` is a stable agent-to-client method whose Atomic handler policy is defined, but Stage 02 did not exercise a live Cline request. It remains pending end-to-end verification in Stages 11-12.
- **Supported Stream Updates**:
  - `agent_thought_chunk`
  - `agent_message_chunk`
  - `session_info_update`
- **Execution Ownership**: Cline owns its internal tool execution loop; Atomic presents and correlates permissions but does not execute observed tool events. The SDK `AcpAgent` owns subprocess stdio/teardown while the Tauri service owns connection/session/run state.
