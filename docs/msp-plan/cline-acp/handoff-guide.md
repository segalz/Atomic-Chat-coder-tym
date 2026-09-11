# Cline ACP Integration: Handoff & Operations Guide

## 1. Overview & Architectural Summary

This document serves as the final operations and handoff reference for the **Cline ACP (Agent Control Protocol)** integration in **Atomic Chat** (`Atomic-Chat-coder-tym`).

The integration introduces a selectable backend, **`cline-acp`**, alongside the pre-existing **`direct-ollama`** in the Coding Agent Panel. Cline runs as a local CLI child process communicating over JSON-RPC 2.0 stdio using the official Agent Control Protocol (protocolVersion: 1).

### Core Architectural Principles
- **Strict Backend Isolation**: Cline operates 100% independently of Ollama. When Cline is selected, Ollama health checks, model list checks, VRAM checks, download triggers, and error banner blocking are completely bypassed. Cline runs normally even if Ollama is offline or not installed.
- **Explicit Permission Lifecycle**: Cline proposes file edits and shell commands via ACP `session/request_permission`. Atomic gates these operations through the panel UI, requiring explicit user approval (`allow_once`) or denial (`cancelled` / reject). Blanket auto-approval is forbidden (`isPermissionAutoApprovalAllowed` returns `false`).
- **Bounded Multi-Turn & Loop**: Supports both manual conversational turns and bounded automated Loop iterations (with finite integer bounds and checkpoint resume). Turn artifacts are verified on disk, and completed actions are not re-executed.
- **Fail-Closed Security**: Denied permissions immediately stop tool execution with zero disk side effects. Missing runs, stale runs, or mismatched run IDs reject permission responses before dispatch.
- **Concurrency Mutex**: A global single-run lock in `backend-router.ts` and `loop-lifecycle.ts` strictly prevents concurrent runs across providers.
- **Clean Child Process Teardown**: On Windows, child process trees are terminated using `taskkill /F /T` to eliminate orphan node or cmd processes and release all workspace file handles.

---

## 2. Setup & Configuration

### Prerequisites
1. **Windows 10/11** x64.
2. **Node.js**: v18+ (tested with Node v24/v22).
3. **Cline CLI**: Version `3.0.61` installed globally:
   ```cmd
   npm install -g cline@3.0.61
   ```
4. **Model & Provider**:
   - Provider: Zhipu AI (`zai`).
   - Model ID: `zai/glm-5.3-flash`.
   - Display Name: `GLM 5.3 Flash`.
   - Model configuration is applied during ACP session initialization via `session/set_config_option` (`configId: 'model'`, `value: 'zai/glm-5.3-flash'`).

### Executable Discovery
The desktop application discovers Cline automatically via:
1. System PATH lookup using `where.exe cline.cmd` on Windows (or `which cline` on Unix).
2. Fallback lookup at `%APPDATA%\npm\cline.cmd`.

Verify installation in PowerShell/CMD:
```powershell
where.exe cline.cmd
cline.cmd --version
```
Expected output: `3.0.61`.

---

## 3. Supported Capabilities & Tool Parity

| Feature / Area | Direct-Ollama | Cline ACP (`cline-acp`) | Integration Notes |
|---|---|---|---|
| **Protocol** | Custom HTTP / Tauri IPC | ACP stdio JSON-RPC 2.0 | Standardized ACP v1 wire protocol |
| **Model Selection** | Installed Ollama models | Curated catalog (`zai/glm-5.3-flash`) | Provider-aware dropdown picker |
| **Streaming** | Delta chunks via IPC | `agent_message_chunk`, `agent_thought_chunk` | Preserves order; explicit reasoning mapped to thinking |
| **File Editing** | Diff blocks parsed by Atomic | Native Cline editor tool | Diffs inspected in panel; gated via `session/request_permission` |
| **File Creation** | `write_file` tool | Native Cline write tool | Gated via `session/request_permission` |
| **Shell Commands** | `run_shell` tool | Native Cline command execution | Gated via `session/request_permission` |
| **Cancellation** | Stop IPC command | In-flight `session/cancel` notification | Prompt cancellation in <100ms; child teardown |
| **Loop Execution** | Supported (bounded) | Supported (bounded) | Shared lifecycle, checkpoint resume, and failure halting |
| **Diff Rejection** | Marked `rejected` in store | ACP permission deny | Both fail-closed; zero disk side effects on denial |

---

## 4. Troubleshooting Guide

### 1. "Failed to spawn cline.cmd: program not found"
- **Cause**: Cline CLI is not installed or `%APPDATA%\npm` is not in the user's `PATH`.
- **Remedy**:
  1. Open PowerShell and run `npm install -g cline@3.0.61`.
  2. Ensure `C:\Users\<User>\AppData\Roaming\npm` is in the environment `PATH`.
  3. Restart Atomic Chat.

### 2. "Handshake rejected" or Authentication Errors
- **Cause**: The configured model provider (`zai`) requires API credentials or tokens.
- **Remedy**:
  1. Verify Cline CLI configuration directly in the terminal:
     ```cmd
     cline.cmd
     ```
  2. Ensure the API key for `zai/glm-5.3-flash` is configured and valid.

### 3. Hung or Unresponsive Run
- **Cause**: Child process blocked or pending permission awaiting user response.
- **Remedy**:
  1. Check the UI for a pending permission banner and click Approve or Reject.
  2. Click the **Stop** button in the Coding Agent panel. The stop action will send `session/cancel` and terminate the process tree.
  3. If needed, kill orphan processes manually via:
     ```powershell
     taskkill /F /IM cline.cmd /T
     taskkill /F /IM node.exe /FI "WINDOWTITLE eq cline*"
     ```

---

## 5. Rollback & Disable Route

The integration is designed with **zero vendor lock-in** and a frictionless rollback route:

1. **Switching Backend in UI**:
   - Change the **Backend** dropdown in the Coding Agent Panel from `Cline (ACP)` back to `Ollama (Local)`.
   - Ollama becomes active immediately with all pre-existing capabilities (local models, VRAM check, health monitoring).
2. **Session History Preservation**:
   - Coding Agent session persistence (`coding-agent-store.ts`) uses backward-compatible schema fields:
     - `backend?: 'direct-ollama' | 'cline-acp'`
     - `providerId?: string`
     - `modelId?: string`
     - `externalSessionId?: string`
   - Existing Ollama sessions continue to load seamlessly. Any unknown session status or diff status defaults to safe fail-closed values (`'rejected'`).
3. **Disabling Cline Completely**:
   - If desired, uninstall the Cline CLI (`npm uninstall -g cline`).
   - The UI will simply notify the user if Cline is selected that the executable was not found, while Ollama continues to function normally.

---

## 6. Accepted Limitations & Host Blocker Record

1. **Native Host Packaging Blocker**:
   - On the current Windows development machine, `rustc` and `cargo` (1.98.1) are installed, but the MSVC C++ Linker (`link.exe`) and GNU MinGW (`dlltool.exe`) are not present.
   - **Status**: Production frontend bundling is verified (`web-app/dist` built cleanly in 24.19s). Native desktop packaging (`cargo tauri build`) is documented as an environmental blocker per Stage 21 criteria. No publishing or installer replacement was attempted.
   - **Next Action for Release**: Install Microsoft Visual Studio C++ Build Tools on the target build machine before producing installer binaries.
2. **Operational Trust Boundary**:
   - The CLI executable is resolved from the user's `%APPDATA%\npm\cline.cmd` shim. System integrity depends on the security of the local npm global directory.
3. **Strict Non-Auto-Approval**:
   - To prevent unintended filesystem modifications, automated permission auto-approval is disabled for Cline ACP. Every mutating tool call requires user confirmation in the panel.
