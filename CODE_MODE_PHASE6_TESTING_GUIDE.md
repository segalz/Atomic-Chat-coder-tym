# Code Mode Feature - Phase 6: End-to-End Testing Guide

## Overview
This guide provides comprehensive end-to-end testing procedures for the Code Mode feature implemented across Phases 1-5. The feature enables the Atomic Chat application to spawn and manage the Cline CLI agent with real-time output streaming, state management, and an interactive React UI.

---

## Part 1: Pre-requisites & Environment Setup

### 1.1 Required Dependencies
Verify the following are installed and accessible:

```bash
# Check Node.js and Yarn
node --version  # Should be v18+
yarn --version  # Should be v3.6+

# Check Cline CLI (or equivalent code agent)
npm list -g @anthropic-ai/claude-code  # Or check actual package name

# Check model server availability
# Either MLX or LlamaCpp must be running with a loaded model
curl http://localhost:8000/v1/models 2>/dev/null || curl http://localhost:8001/v1/models
```

### 1.2 Pre-test Setup
Before running any tests:

1. **Start the application in dev mode:**
   ```bash
   cd /Users/zvisegal/devlope/Atomic-Chat-coder-tym
   yarn dev  # Starts both frontend (Vite) and Tauri backend
   ```

2. **Verify model server is running:**
   ```bash
   # MLX server (default port 8000)
   python -m mlx_lm.server --model <model-name>
   
   # OR LlamaCpp server (fallback port 8001)
   ./server -m <model-path> -ngl 1
   ```

3. **Clear previous state (optional):**
   ```bash
   # Remove persisted store to reset to defaults
   rm ~/Library/Application\ Support/Atomic-Chat-coder*/code-mode-store.json
   ```

4. **Create test project directory:**
   ```bash
   mkdir -p ~/test-cline-project
   cd ~/test-cline-project
   git init  # Some agents expect a git repo
   ```

---

## Part 2: Test Scenarios

### Test Case TC-1: Happy Path - Interactive Ask Mode
**Objective:** Verify basic Code Mode functionality with user-controlled permission mode.

#### TC-1.1: Mode Toggle & Navigation
**Steps:**
1. Open the application
2. Click the mode toggle (should show "Chat" → "Code" icons)
3. Verify the UI switches from ChatInput to CodeModePanel
4. **Expected:** Code Mode panel appears with:
   - Project Bar (folder selector)
   - PermissionModeSelector dropdown
   - Input textarea with placeholder
   - Output container (empty)
   - Send/Stop buttons (Stop disabled, Send enabled)

**Validation Criteria:**
- ✓ ModeToggle component renders with correct icons
- ✓ CodeModePanel displays all sub-components
- ✓ Button states match store state (isAgentRunning = false)

---

#### TC-1.2: Project Selection
**Steps:**
1. Click the folder icon in Project Bar
2. Select `~/test-cline-project` directory
3. **Expected:** Project Bar shows selected path
4. Verify `PermissionModeSelector` is enabled (not grayed out)

**Validation Criteria:**
- ✓ Dialog opens and allows directory selection
- ✓ Selected path is displayed in Project Bar
- ✓ Path is persisted in Zustand store (check browser dev tools)
- ✓ Refreshing page retains selected project

**Console Check:**
```javascript
// Open browser DevTools console and check:
localStorage.getItem('code-mode-store')
// Should contain: "projectDir": "/path/to/test-cline-project"
```

---

#### TC-1.3: Permission Mode Selection
**Steps:**
1. Click PermissionModeSelector dropdown
2. Select **"Ask Mode"** (wait for each permission)
3. **Expected:** Dropdown shows selected value
4. Send button should remain enabled

**Validation Criteria:**
- ✓ Dropdown opens and shows options
- ✓ Selection is saved to store
- ✓ UI renders selected value

---

#### TC-1.4: Send Prompt (Agent Startup)
**Steps:**
1. Type a simple prompt: `"create a file called test.txt with content 'hello world'"`
2. Click Send button
3. **Expected (within 2-3 seconds):**
   - Input textarea clears
   - Send button becomes disabled
   - Stop button becomes enabled
   - Output container shows first system message
   - `isAgentRunning: true` in store

**Validation Criteria:**
- ✓ Tauri `invoke('spawn_code_agent')` is called (check console)
- ✓ Process spawns (see Tauri logs for subprocess creation)
- ✓ First event received (system message appears in UI)
- ✓ Store updates: `isAgentRunning: true`, `agentOutput: [...]`

**Tauri Logs Check:**
```bash
# In another terminal, check Tauri logs
tail -f ~/Library/Logs/Atomic-Chat-coder*/app.log
# Should show: "spawn_code_agent called with project_dir: ..."
```

---

#### TC-1.5: Real-time Output Streaming
**Steps:**
1. Continue from TC-1.4, agent is running
2. Observe output container updates in real-time
3. **Expected:** See multiple message types:
   - `system`: Agent starting up
   - `assistant`: Agent thinking/analysis
   - `tool_use`: File creation requests
   - `tool_result`: Confirmation of completed actions
   - `result`: Final output from Cline

**Validation Criteria:**
- ✓ Output renders with proper formatting
- ✓ Messages appear sequentially (not all at once)
- ✓ Output auto-scrolls to newest message
- ✓ Each message includes timestamp/type indicator

**Output Example:**
```
[system] Starting agent...
[assistant] I'll create a test.txt file with the specified content.
[tool_use] mkdir /path/test-cline-project
[tool_result] Success
[tool_use] write /path/test-cline-project/test.txt ...
[tool_result] File created
[result] Task completed successfully
```

---

#### TC-1.6: Permission Request (Ask Mode)
**Steps:**
1. Continue from TC-1.5; when agent requests permission for file operation:
   - A `permission_request` output line appears
   - Shows: "Request permission for: [action]"
   - Displays Approve/Deny buttons
2. Click **Approve**
3. **Expected:** 
   - Permission request UI closes
   - Agent continues execution
   - Output resumes

**Validation Criteria:**
- ✓ Permission request renders with buttons
- ✓ Approve/Deny buttons are clickable
- ✓ Agent resumes after approval
- ✓ Denied requests stop operation (test in separate scenario)

**Browser DevTools Check:**
```javascript
// In console, verify event listener works:
// When "Approve" clicked, should see communication (confirm via logs)
document.querySelector('button[data-action="approve"]')?.click()
```

---

#### TC-1.7: Agent Completion
**Steps:**
1. Continue from TC-1.6; wait for agent to finish
2. **Expected:**
   - Output shows final `result` message
   - Final `error` message (if something failed)
   - Stop button becomes disabled
   - Send button becomes enabled
   - `isAgentRunning: false` in store

**Validation Criteria:**
- ✓ `code-agent-done` event received and handled
- ✓ Store state updates to `isAgentRunning: false`
- ✓ Button states revert to initial (Send enabled, Stop disabled)
- ✓ Test file exists: `cat ~/test-cline-project/test.txt`

**File Verification:**
```bash
cd ~/test-cline-project
ls -la test.txt
cat test.txt
# Should output: "hello world"
```

---

### Test Case TC-2: Auto-Accept Mode (Automated Execution)
**Objective:** Verify Code Mode executes without permission prompts.

#### TC-2.1: Configure Auto-Accept
**Steps:**
1. Switch to Code Mode (if not already there)
2. Select project directory
3. Click PermissionModeSelector dropdown
4. Select **"Auto Accept"** mode
5. Input prompt: `"delete ~/test-cline-project/test.txt if it exists"`
6. Click Send

**Expected (within 2-3 seconds):**
- Agent executes without showing permission requests
- All operations complete automatically
- Output shows tool_use + tool_result pairs without permission_request lines

**Validation Criteria:**
- ✓ No `permission_request` output lines appear
- ✓ Tool operations complete without manual approval
- ✓ Store shows `permissionMode: 'auto_accept'`

---

#### TC-2.2: Verify Auto-Accept Persistence
**Steps:**
1. Close the application completely
2. Reopen the application
3. Switch to Code Mode
4. **Expected:** PermissionModeSelector shows "Auto Accept" selected

**Validation Criteria:**
- ✓ Permission mode setting persists across app restarts
- ✓ Zustand persist middleware saved the setting

---

### Test Case TC-3: Stop/Cancel Agent
**Objective:** Verify graceful agent termination.

#### TC-3.1: Stop Mid-Execution
**Steps:**
1. Select project, set permission mode
2. Enter prompt: `"ls -la /"`  (long-running list operation)
3. Click Send button
4. After 2-3 seconds, click **Stop** button
5. **Expected:**
   - Stop button becomes disabled immediately
   - Agent process terminates (subprocess kill signal sent)
   - Output shows error or completion message
   - `isAgentRunning: false` in store

**Validation Criteria:**
- ✓ `stop_code_agent` command invoked
- ✓ Process killed gracefully (zombie processes cleaned up)
- ✓ Event listeners stop receiving events
- ✓ Output container shows final message (if any)

**Process Check:**
```bash
# Before stopping, in another terminal:
ps aux | grep cline
# Should see the agent process running

# After stopping:
ps aux | grep cline
# Process should be gone
```

---

### Test Case TC-4: Error Handling

#### TC-4.1: Cline Agent Not Found
**Steps:**
1. Uninstall or rename cline CLI temporarily:
   ```bash
   npm uninstall -g @anthropic-ai/claude-code
   ```
2. Switch to Code Mode, select project, enter any prompt
3. Click Send
4. **Expected (within 1-2 seconds):**
   - Error message in output container
   - Shows: "Cline agent not found" or "Command not found"
   - Send button re-enabled
   - `isAgentRunning: false`

**Validation Criteria:**
- ✓ Error handles gracefully (no app crash)
- ✓ Error message is descriptive
- ✓ User can retry or try different action
- ✓ Tauri logs show error details

---

#### TC-4.2: Model Server Unavailable
**Steps:**
1. Stop the model server (MLX or LlamaCpp)
2. Switch to Code Mode, select project, enter prompt
3. Click Send
4. **Expected (within 2-5 seconds):**
   - Output shows connection error
   - Shows port attempted (8000 for MLX, 8001 for LlamaCpp)
   - Suggests starting model server

**Validation Criteria:**
- ✓ Port discovery fallback chain attempted (MLX → LlamaCpp)
- ✓ Error message includes port information
- ✓ Clear guidance provided to user

---

#### TC-4.3: Project Directory Deleted
**Steps:**
1. Select a project directory: `~/test-cline-project`
2. Delete the directory: `rm -rf ~/test-cline-project`
3. Enter prompt: `"list files"`
4. Click Send
5. **Expected:**
   - Error shown in output (directory not found)
   - Agent handles gracefully
   - `isAgentRunning: false`

**Validation Criteria:**
- ✓ Error handling doesn't crash app
- ✓ Error message is specific
- ✓ Can select new project and continue

---

#### TC-4.4: Input Limit Validation
**Steps:**
1. Test with very long prompt (>10,000 characters)
2. Test with empty prompt
3. **Expected:**
   - Empty prompt: Send button disabled or error message
   - Long prompt: Either sent successfully or truncated with warning
   - No UI freezing

**Validation Criteria:**
- ✓ Input validation prevents invalid submissions
- ✓ User receives clear feedback

---

### Test Case TC-5: State Persistence

#### TC-5.1: Store Persistence
**Steps:**
1. Configure: Select project, set permission mode, enter draft prompt
2. Close the application
3. Reopen the application
4. Switch to Code Mode
5. **Expected:**
   - Project directory still selected
   - Permission mode preserved
   - Draft prompt still in textarea (if implemented)

**Validation Criteria:**
- ✓ Zustand persist middleware working
- ✓ All persisted state restored correctly
- ✓ Transient state (agentOutput, isAgentRunning) reset to defaults

**Store Verification:**
```javascript
// In browser console:
JSON.parse(localStorage.getItem('code-mode-store'))
// Should show: { projectDir, permissionMode, draftPrompt, mode }
```

---

#### TC-5.2: Modal Instance Isolation
**Steps:**
1. Open multiple windows/tabs of the application
2. In one tab: Select project A, Start agent
3. In another tab: Select project B
4. **Expected:**
   - Each tab maintains independent state for `projectDir` and `permissionMode`
   - Agent running state (`isAgentRunning`) may be shared (depending on backend)

**Validation Criteria:**
- ✓ Each instance has independent project selection
- ✓ No UI state cross-contamination

---

## Part 3: UI/UX Validation

### VE-1: Component Rendering
- [ ] ModeToggle displays correct active mode
- [ ] ProjectBar shows selected directory path (or placeholder)
- [ ] PermissionModeSelector dropdown aligned properly
- [ ] InputArea textarea expands appropriately
- [ ] Send/Stop buttons have clear visual states
- [ ] Output container has proper scrolling

### VE-2: Accessibility
- [ ] All buttons have proper focus states (keyboard nav)
- [ ] Error messages are readable and non-technical
- [ ] Color contrast meets WCAG standards
- [ ] Responsive layout on different screen sizes

### VE-3: Performance
- [ ] UI updates smoothly during output streaming (no jank)
- [ ] No memory leaks when running long operations
- [ ] Auto-scroll doesn't impact performance
- [ ] Event listeners properly cleaned up

```javascript
// Check for memory leaks in browser DevTools:
// 1. Take heap snapshot before agent
// 2. Run agent through complete cycle
// 3. Take heap snapshot after
// 4. Compare: should return to similar memory usage
```

---

## Part 4: Edge Cases & Advanced Scenarios

### EC-1: Rapid Project/Mode Switching
**Steps:**
1. Rapidly toggle between Chat ↔ Code modes (5-10 times)
2. Rapidly switch project directories
3. **Expected:** No errors, UI stays responsive

**Validation Criteria:**
- ✓ No crashed states
- ✓ Event listeners properly re-attached
- ✓ No zombies processes created

---

### EC-2: Concurrent Execution (May Not Be Supported)
**Steps:**
1. Start agent with prompt A
2. Before completion, try to start new agent with prompt B
3. **Expected:** Error or warning ("Agent already running")

**Validation Criteria:**
- ✓ Second invocation is prevented or queued
- ✓ User receives clear feedback

---

### EC-3: Very Large Output
**Steps:**
1. Request agent to generate large output (e.g., `"list all files recursively"` in /usr)
2. Let it run for 30+ seconds generating lots of output
3. **Expected:**
   - UI remains responsive
   - Scrolling smooth
   - Memory usage reasonable

**Monitor Resources:**
```bash
# In another terminal:
while true; do ps aux | grep -E "node|cargo" | grep -v grep; sleep 2; done
# Watch CPU/memory usage stays reasonable
```

---

### EC-4: Reconnection After Network Loss
**Steps:**
1. Start agent execution
2. Simulate network disconnect (disconnect WiFi/Ethernet)
3. **Expected:** 
   - Error event received
   - Agent stops gracefully
   - Error message shown

**Validation Criteria:**
- ✓ Timeout/error handling prevents hanging
- ✓ UI is responsive after network loss

---

## Part 5: Integration Testing

### IT-1: Tauri Command Invocation
**Steps:**
1. Open browser DevTools → Tauri Console
2. Perform Code Mode operations
3. **Expected:** Console logs showing:
   ```
   [INFO] spawning command: invoke
   [INFO] command: spawn_code_agent
   [INFO] arguments: { project_dir: "...", prompt: "..." }
   ```

**Validation Criteria:**
- ✓ All commands properly serialized
- ✓ Arguments passed correctly
- ✓ Response received

---

### IT-2: Event Streaming
**Steps:**
1. Start agent, observe output
2. Open Tauri console to see raw events
3. **Expected:** Events emitted as:
   ```json
   { event: 'code-agent-output', payload: { ... } }
   { event: 'code-agent-done', payload: {} }
   ```

**Validation Criteria:**
- ✓ Events properly serialized (valid JSON)
- ✓ Payload includes all required fields
- ✓ Events emit in correct sequence

---

### IT-3: Dialog Plugin Integration
**Steps:**
1. Click folder icon in Project Bar
2. **Expected:** Native file dialog opens
3. Select directory and confirm

**Validation Criteria:**
- ✓ Dialog plugin working (uses native OS dialog)
- ✓ Selection properly returned to frontend

---

## Part 6: Post-Test Checks

### Cleanup
After testing, clean up test artifacts:
```bash
# Remove test project
rm -rf ~/test-cline-project

# Clear app cache/logs (optional)
rm -rf ~/Library/Application\ Support/Atomic-Chat-coder*
rm -rf ~/Library/Logs/Atomic-Chat-coder*
```

### Verification
- [ ] No zombie processes left: `ps aux | grep cline`
- [ ] No disk space consumed by temp files
- [ ] App can be closed cleanly (no hung processes)

---

## Part 7: Known Limitations & Workarounds

### L-1: Permission Request stdin Not Fully Implemented
**Issue:** When agent requests permission, the Approve/Deny buttons render but stdin communication is stubbed with console.log.

**Workaround:** 
- In Ask mode, manually validate permission requests
- Full stdin integration planned for Phase 6.2

**Impact:** Code execution may pause waiting for stdin input even after clicking Approve.

---

### L-2: Long-Running Processes May Need Timeout
**Issue:** Very long-running agent operations may accumulate memory.

**Workaround:**
- Set reasonable task descriptions (5-10 minute operations)
- Use Stop button to cancel if needed

**Planned Fix:** Add configurable timeout parameter

---

### L-3: Agent Output Encoding
**Issue:** Some special characters from Cline output may not render correctly.

**Workaround:**
- Output is UTF-8 encoded; most standard output should display correctly
- Report specific encoding issues

---

## Test Results Template

Use this template to document test results:

```markdown
### Test Case: [TC-X.X Name]
**Date:** YYYY-MM-DD
**Tester:** [Name]
**Status:** PASS / FAIL / SKIPPED

**Observations:**
- [Observation 1]
- [Observation 2]

**Issues Found:**
- [Issue 1]
- [Issue 2]

**Follow-up Actions:**
- [Action 1]

---
```

---

## Quick Test Checklist

Use this quick checklist for smoke testing:

- [ ] Application starts without errors
- [ ] Mode toggle works (Chat ↔ Code)
- [ ] Can select project directory
- [ ] Can select permission mode
- [ ] Can type and send prompt
- [ ] Agent starts and output appears
- [ ] Stop button stops agent
- [ ] Permission request buttons work
- [ ] Agent completes and state resets
- [ ] No TypeScript errors in console
- [ ] No Tauri/Rust errors in logs

---

## Integration with CI/CD

For future automation, tests can be grouped:

**Smoke Tests** (5 min): TC-1.1 through TC-1.7, TC-3.1
**Full Test Suite** (20-30 min): All TCs except EC-* scenarios
**Extended Testing** (60+ min): All TCs including edge cases

Consider implementing automated UI testing with Tauri's built-in testing capabilities.

---

## Contact & Support

If issues are found during testing:
1. Document with the Test Results Template (Section 7)
2. Check Tauri logs: `~/Library/Logs/Atomic-Chat-coder*/`
3. Check browser console for TypeScript errors
4. Provide:
   - Exact steps to reproduce
   - Expected vs actual behavior
   - Relevant logs/screenshots

---

**Testing Complete Checklist (Final):**
- [ ] All test cases reviewed and documented
- [ ] No critical issues blocking feature release
- [ ] Performance acceptable for production use
- [ ] Known limitations documented and communicated
- [ ] Codebase ready for Phase 6.2+ enhancements
