# Phase 6.1: Implementation Verification Checklist

## Overview
This document provides a quick reference to verify all Code Mode components are properly implemented and integrated.

---

## Component Verification Checklist

### Frontend Components

#### ✅ Store: `web-app/src/stores/code-mode-store.ts`
**Verification:**
```bash
# Check file exists and has correct structure
grep -E "type CodeModeStore|persist|projectDir|isAgentRunning" \
  web-app/src/stores/code-mode-store.ts
```

**Expected Output:**
- Store interface with: `mode`, `projectDir`, `draftPrompt`, `permissionMode`, `isAgentRunning`, `agentOutput`
- Zustand `create()` hook with `persist()` middleware
- Store import in `CodeModePanel.tsx`

**Integration Test:**
```javascript
// In browser console:
import { useCodeModeStore } from '@/stores/code-mode-store'
const store = useCodeModeStore()
console.log(store.projectDir)  // Should show selected directory
console.log(store.isAgentRunning)  // Should show current state
```

---

#### ✅ Component: `web-app/src/routes/index.tsx` - ModeToggle
**Verification:**
```bash
# Check ModeToggle component exists
grep -A 20 "function ModeToggle" web-app/src/routes/index.tsx
```

**Expected Output:**
```typescript
function ModeToggle() {
  const { mode, setMode } = useCodeModeStore()
  return (
    <button onClick={...}>
      {mode === 'chat' ? /* Chat icon */ : /* Code icon */}
    </button>
  )
}
```

**Visual Test:**
- Click toggle: UI switches between ChatInput and CodeModePanel
- Icon changes on toggle

---

#### ✅ Component: `web-app/src/containers/CodeModePanel.tsx` - Main Container
**Verification:**
```bash
# Check all key sections exist
grep -E "export function CodeModePanel|ProjectBar|PermissionModeSelector|InputArea|OutputLine|useEffect.*agentOutput" \
  web-app/src/containers/CodeModePanel.tsx | head -20
```

**Expected Structure:**
- EventListener setup for `code-agent-output`, `code-agent-done`, `code-agent-error`
- `handleSend()` function that invokes `spawn_code_agent`
- `handleStop()` function that invokes `stop_code_agent`
- OutputLine component with support for multiple message types
- Auto-scroll effect on agentOutput changes

**Integration Test:**
- Select project directory
- Type prompt and send
- Verify output appears in real-time

---

#### ✅ Component: `web-app/src/containers/ProjectBar.tsx`
**Verification:**
```bash
ls -lh web-app/src/containers/ProjectBar.tsx && \
  grep -E "dialog|openFile|projectDir" web-app/src/containers/ProjectBar.tsx
```

**Expected:**
- Component imports `@tauri-apps/plugin-dialog`
- Click handler opens native file dialog
- Selected path displayed in UI
- Path saved to store

**Visual Test:**
- Click folder icon
- Native dialog opens
- Select directory
- Path appears in Project Bar

---

#### ✅ Component: `web-app/src/containers/PermissionModeSelector.tsx`
**Verification:**
```bash
ls -lh web-app/src/containers/PermissionModeSelector.tsx && \
  grep -E "ask|auto_accept|permissionMode" web-app/src/containers/PermissionModeSelector.tsx
```

**Expected:**
- Dropdown with two options: "Ask Mode" and "Auto Accept"
- onChange handler updates store
- Disabled when agent is running

**Visual Test:**
- Click dropdown
- Select "Ask Mode" or "Auto Accept"
- Selection persists after reload

---

#### ✅ Component: `web-app/src/containers/InputArea.tsx`
**Verification:**
```bash
ls -lh web-app/src/containers/InputArea.tsx && \
  grep -E "textarea|Send|Stop" web-app/src/containers/InputArea.tsx
```

**Expected:**
- Textarea for prompt input
- Send button (enabled when `projectDir` selected and agent not running)
- Stop button (enabled only when agent running)
- Clear on submit

**Visual Test:**
- Type prompt, click Send → textarea clears
- During execution, Send disabled, Stop enabled
- After completion, Send re-enabled, Stop disabled

---

### Rust/Tauri Components

#### ✅ Command: `src-tauri/src/core/code_agent.rs` - spawn_code_agent
**Verification:**
```bash
grep -A 5 "pub async fn spawn_code_agent" src-tauri/src/core/code_agent.rs
```

**Expected Signature:**
```rust
pub async fn spawn_code_agent<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    permission_mode: String,
) -> Result<String, String>
```

**Verification Test:**
```bash
# Build Rust code
cd src-tauri && cargo build 2>&1 | grep "error"
# Should show zero errors (warnings OK)
```

**Integration Test:**
1. Enable browser DevTools → Console
2. Start Code Mode agent
3. Check console shows `invoke('spawn_code_agent')`
4. Check Tauri logs for subprocess creation

---

#### ✅ Command: `src-tauri/src/core/code_agent.rs` - stop_code_agent
**Verification:**
```bash
grep -A 5 "pub async fn stop_code_agent" src-tauri/src/core/code_agent.rs
```

**Expected Signature:**
```rust
pub async fn stop_code_agent<R: Runtime>(
    state: State<'_, CodeAgentState>
) -> Result<String, String>
```

**Integration Test:**
- Start agent
- Click Stop button
- Process termination in logs
- `ps aux | grep cline` shows no process

---

#### ✅ Integration: `src-tauri/src/lib.rs` - Command Registration
**Verification:**
```bash
grep -E "invoke_handler|spawn_code_agent|stop_code_agent" src-tauri/src/lib.rs
```

**Expected:**
- Both commands registered in `invoke_handler!` macro
- Dialog plugin registered
- Shell plugin registered (for subprocess)
- MLX/LlamaCpp plugins registered (for port discovery)

**Compilation Test:**
```bash
cd src-tauri && cargo check
```

Expected output: `Finished ... in X.XXs` (no errors)

---

### Event/Message Flow

#### ✅ Event: code-agent-output
**Verification:**
```bash
grep -E "emit.*code-agent-output|listen.*code-agent-output" \
  src-tauri/src/core/code_agent.rs web-app/src/containers/CodeModePanel.tsx
```

**Expected:**
- Emitted from Rust with JSON payload
- Listened in CodeModePanel with `listen<AgentOutput>()`
- Parsed and added to store

**Integration Test:**
- Monitor Tauri console during execution
- See raw JSON events
- Verify parsing in browser console

---

#### ✅ Event: code-agent-done
**Verification:**
```bash
grep -E "code-agent-done" \
  src-tauri/src/core/code_agent.rs web-app/src/containers/CodeModePanel.tsx
```

**Expected:**
- Emitted when subprocess completes
- Sets `isAgentRunning: false`
- Re-enables Send button

---

#### ✅ Event: code-agent-error
**Verification:**
```bash
grep -E "code-agent-error" \
  src-tauri/src/core/code_agent.rs web-app/src/containers/CodeModePanel.tsx
```

**Expected:**
- Emitted on errors (command not found, etc.)
- Adds error message to output
- Stops agent execution

---

## Data Flow Verification

### Happy Path Flow

```
User Input
    ↓
[1] PermissionModeSelector updates store (permissionMode)
[2] ProjectBar updates store (projectDir)
[3] InputArea updates store (draftPrompt) on change
[4] User clicks Send
    ↓
[5] handleSend() in CodeModePanel
    - Gets port from MLX (or fallback LlamaCpp)
    - Invokes spawn_code_agent with (projectDir, prompt, permissionMode)
    ↓
[6] Tauri backend (spawn_code_agent)
    - Builds command: cline ... --model localhost:PORT
    - Spawns subprocess
    - Pipes stdout/stderr
    - Background tasks emit code-agent-output events
    ↓
[7] Frontend listens to events
    - Parses JSON payload
    - Detects message type (system, assistant, tool_use, etc.)
    - Appends to store.agentOutput array
    ↓
[8] CodeModePanel re-renders
    - Maps agentOutput to OutputLine components
    - Auto-scrolls to latest
    ↓
[9] On permission_request type
    - Renders Approve/Deny buttons
    - Click handler invokes stdin communication
    ↓
[10] On code-agent-done event
    - Sets isAgentRunning: false
    - Re-enables Send button
```

**Verification Checklist:**
- [ ] All 10 steps can be traced through logs
- [ ] No events lost
- [ ] No UI state mismatches

---

## Configuration Verification

### Type Definitions
Check all interface definitions are complete:

```bash
# Check TypeScript interfaces
grep -E "interface|type.*=" web-app/src/stores/code-mode-store.ts | head -20
```

**Expected Interfaces:**
- `AgentOutputLine` - With type field supporting 9+ types
- `CodeModeStore` - With all store fields
- `Permission` modes - 'ask' | 'auto_accept'

---

### Tauri Manifest
Verify command registration:

```bash
grep -A 5 "invoke_handler" src-tauri/src/lib.rs
```

**Expected:**
- `spawn_code_agent` registered
- `stop_code_agent` registered

---

## Performance Verification

### Bundle Size Check
```bash
# After build, check web bundle
ls -lh web-app/dist/assets/*.js | awk '{print $5 "\t" $NF}'
```

**Expected:**
- Main bundle < 500KB (uncompressed)
- No excessive imports

---

### Build Time Check
```bash
time yarn build:web
```

**Expected:**
- < 10 seconds for incremental builds
- No TypeScript errors

---

## Dependency Verification

### Required npm Packages
```bash
# Verify key dependencies installed
cd web-app && npm ls zustand @tauri-apps/api lucide-react @radix-ui/react-dropdown-menu
```

**Expected:**
- zustand: ^4.x
- @tauri-apps/api: ^2.x
- lucide-react: ^latest
- @radix-ui/react-dropdown-menu: ^latest

---

### Required Tauri Features
```bash
# Check Tauri plugins
grep -E "plugin" Cargo.toml | head -10
```

**Expected:**
- tauri = { version = "2.0", features = [...] }
- tauri-plugin-dialog = "..."
- tauri-plugin-shell = "..."

---

## Test Execution Summary

### Quick Smoke Test (5 min)
```bash
# 1. Check builds
cd /path && cargo check && yarn build:web

# 2. Visual inspection
# - Run yarn dev
# - Toggle modes
# - Select project
# - Send simple prompt
# - Verify output appears

# 3. Check logs
tail -f ~/Library/Logs/Atomic-Chat-coder*/app.log
```

### Full Verification (30 min)
See [CODE_MODE_PHASE6_TESTING_GUIDE.md](CODE_MODE_PHASE6_TESTING_GUIDE.md) for comprehensive test cases.

---

## Sign-Off

### Phase 5 Implementation Complete ✅
- [x] Zustand store with persistence
- [x] All UI components
- [x] Tauri command skeleton
- [x] Subprocess execution with streaming
- [x] Event listeners and JSON parsing
- [x] OutputLine renderer for all types
- [x] Permission request UI
- [x] Stop functionality
- [x] Error handling
- [x] TypeScript compilation passing
- [x] Rust compilation passing

### Phase 6 Testing Ready ✅
- [x] All components verified
- [x] Data flow complete
- [x] Dependencies installed
- [x] Test guide created
- [x] Verification checklist ready

### Recommended Next Steps
1. **Phase 6.1 Testing**: Follow testing guide (30-60 min)
2. **Phase 6.2 Enhancement**: Implement stdin communication for permission requests
3. **Phase 6.3 Polish**: Add timeout handling, better error messages
4. **Phase 7 Release**: Package for distribution

---

## Notes & Known Issues

### Known Limitations
- Permission request stdin not fully implemented (uses console.log stub)
- Long-running processes may need timeout handling
- Some special characters in output may not render correctly

### Tested Configurations
- macOS (10.15+)
- Node.js 18+
- Rust 1.70+
- Chrome DevTools

### Future Enhancements
- [ ] Configure timeout for long-running operations
- [ ] Add progress indicators for slow operations
- [ ] Implement full stdin communication for permissions
- [ ] Add operation history/undo support
- [ ] Implement code execution sandboxing (security)

