# Phase 6.1 Testing: Quick Reference Card

## Pre-Test Setup (Do This First!)
```bash
# 1. Install Cline CLI
npm install -g @anthropic-ai/claude-code

# 2. Start model server (in separate terminal)
# MLX:
python -m mlx_lm.server --model mistral-7b-instruct-4bit

# LlamaCpp:
./server -m models/mistral-7b-instruct-q4_0.gguf -ngl 1

# 3. Create test project
mkdir -p ~/test-cline-project
cd ~/test-cline-project
git init

# 4. Start app
cd /Users/zvisegal/devlope/Atomic-Chat-coder-tym
yarn dev
```

---

## Test Case Checklist

### TC-1: Happy Path (Ask Mode) ⏱️ 10 min
- [ ] **TC-1.1**: Code Mode panel appears
  - [ ] ModeToggle visible and clickable
  - [ ] CodeModePanel renders with all sub-components
- [ ] **TC-1.2**: Project selection works
  - [ ] Folder dialog opens
  - [ ] Selected path shows in Project Bar
  - [ ] Path persists on reload
- [ ] **TC-1.3**: Permission mode dropdown works
  - [ ] Dropdown opens with two options
  - [ ] Selection saves to store
- [ ] **TC-1.4**: Agent starts on Send
  - [ ] First output within 2-3 sec
  - [ ] Send button disabled, Stop enabled
  - [ ] Store shows `isAgentRunning: true`
- [ ] **TC-1.5**: Real-time output appears
  - [ ] Multiple message types visible (system, assistant, tool_use, tool_result, result)
  - [ ] Auto-scrolls to newest message
  - [ ] No UI freezing or jank
- [ ] **TC-1.6**: Permission request works (if applicable)
  - [ ] Permission UI appears
  - [ ] Approve/Deny buttons clickable
  - [ ] Agent resumes after approval
- [ ] **TC-1.7**: Agent completes cleanly
  - [ ] Final result shown
  - [ ] Stop disabled, Send enabled
  - [ ] `isAgentRunning: false` in store
  - [ ] Test file exists on disk

**Test Command:**
```bash
# Prompt: "create a file called test.txt with content 'hello world'"
# After completion, verify:
cat ~/test-cline-project/test.txt
# Expected output: hello world
```

---

### TC-2: Auto-Accept Mode ⏱️ 5 min
- [ ] **TC-2.1**: Auto-Accept mode works
  - [ ] Permission mode dropdown set to "Auto Accept"
  - [ ] **No** permission request UI appears
  - [ ] Operations complete automatically
  - [ ] Final output shows success

- [ ] **TC-2.2**: Setting persists
  - [ ] Close/reopen app
  - [ ] Permission mode still "Auto Accept"

**Test Command:**
```bash
# Prompt: "delete ~/test-cline-project/test.txt if it exists"
# Verify: file is deleted without permission prompts
ls -la ~/test-cline-project/test.txt 2>&1 | grep "No such file"
```

---

### TC-3: Stop/Cancel ⏱️ 5 min
- [ ] **TC-3.1**: Stop kills agent
  - [ ] Send a long-running prompt
  - [ ] Click Stop within 2-3 sec
  - [ ] Process terminates (check `ps aux`)
  - [ ] Send button re-enabled
  - [ ] Output shows completion/error

**Test Command:**
```bash
# Prompt: "list all files recursively in /"
# Wait 2 sec, click Stop
# Verify: ps aux | grep cline shows no process
```

---

### TC-4: Error Handling ⏱️ 10 min

#### TC-4.1: Cline Not Found
- [ ] **Step 1**: Uninstall cline: `npm uninstall -g @anthropic-ai/claude-code`
- [ ] **Step 2**: Try to send prompt
- [ ] **Step 3**: Error message appears (< 2 sec)
- [ ] **Step 4**: UI recoverable (Send clickable again)
- [ ] **Reinstall**: `npm install -g @anthropic-ai/claude-code`

#### TC-4.2: Server Unavailable
- [ ] **Step 1**: Stop model server
- [ ] **Step 2**: Send prompt
- [ ] **Step 3**: Error about connection/port
- [ ] **Step 4**: Restart server and retry works

#### TC-4.3: Directory Deleted
- [ ] **Step 1**: Select ~/test-cline-project
- [ ] **Step 2**: Delete it: `rm -rf ~/test-cline-project`
- [ ] **Step 3**: Send prompt
- [ ] **Step 4**: Error about missing directory
- [ ] **Step 5**: UI still responsive

#### TC-4.4: Input Validation
- [ ] **Empty prompt**: Send button disabled or error
- [ ] **Very long prompt** (10K chars): Either sent or truncated with warning

---

### TC-5: State Persistence ⏱️ 5 min

#### TC-5.1: Store Persistence
- [ ] **Step 1**: Select project directory
- [ ] **Step 2**: Set permission mode to "Auto Accept"
- [ ] **Step 3**: Type prompt (don't send)
- [ ] **Step 4**: Close app completely
- [ ] **Step 5**: Reopen app, switch to Code Mode
- [ ] **Step 6**: Verify:
  - [ ] Project directory still selected
  - [ ] Permission mode is "Auto Accept"
  - [ ] Prompt still in textarea (if implemented)

**Browser Console Verification:**
```javascript
JSON.parse(localStorage.getItem('code-mode-store'))
// Should show: { projectDir: "/path", permissionMode: "auto_accept", ... }
```

#### TC-5.2: Multi-Tab Isolation
- [ ] **Step 1**: Open app in two tabs
- [ ] **Step 2**: In Tab A: Select project A
- [ ] **Step 3**: In Tab B: Select project B
- [ ] **Step 4**: Switch back to Tab A
- [ ] **Step 5**: Verify project A still selected

---

## Edge Cases (Optional Advanced Testing)

### EC-1: Rapid Switching ⏱️ 3 min
```
Click mode toggle 5-10 times rapidly
→ No crash, UI responsive
```

### EC-2: Very Large Output ⏱️ 5 min
```
Prompt: "list all files recursively in /usr"
→ Wait 30+ seconds
→ UI smooth, memory reasonable, scrolling works
```

### EC-3: Network Interruption ⏱️ 5 min
```
During execution:
1. Disconnect WiFi
2. Output stops, error appears
3. Reconnect WiFi
4. UI recovers
```

---

## UI/UX Checks (Do During All Tests!)

- [ ] **Layout**: Responsive on different screen sizes
- [ ] **Colors**: Good contrast, readable text
- [ ] **Buttons**: Clear visual states (hover, pressed, disabled)
- [ ] **Scrolling**: Smooth auto-scroll, no jank
- [ ] **Responsiveness**: No freezing during output stream
- [ ] **Icons**: Correct icons in ModeToggle, ProjectBar
- [ ] **Keyboard Nav**: Can tab through buttons and inputs

---

## Performance Checks

```bash
# Monitor resource usage during test
while true; do
  ps aux | grep -E "node|cargo" | grep -v grep
  sleep 2
done
```

**Expected Observations:**
- [ ] CPU: Spikes during output processing, returns to 0-5% idle
- [ ] Memory: Stays stable (~200-300 MB), returns to baseline after
- [ ] No zombie processes after Stop
- [ ] Clean shutdown (no hung processes)

---

## Log Verification

### Tauri Logs
```bash
tail -f ~/Library/Logs/*/app.log
```

Look for:
- [ ] `spawn_code_agent` invoked
- [ ] Subprocess started (PID shown)
- [ ] Events emitted (`code-agent-output`, `code-agent-done`)
- [ ] No panics or segfaults

### Browser Console
DevTools → Console:
- [ ] No TypeScript errors (red text)
- [ ] No Tauri errors
- [ ] Event listeners logging properly

---

## Test Results Summary

Print this out and check boxes as you go!

```
┌─────────────────────────────────────────────────────────┐
│ CODE MODE PHASE 6.1 TEST RESULTS                        │
├─────────────────────────────────────────────────────────┤
│ Date: ________      Tester: ________                   │
│                                                         │
│ Test Case Results:                                      │
│ ☐ TC-1 Happy Path          [ Pass / Fail / Partial ]    │
│ ☐ TC-2 Auto-Accept         [ Pass / Fail / Partial ]    │
│ ☐ TC-3 Stop/Cancel         [ Pass / Fail / Partial ]    │
│ ☐ TC-4 Error Handling      [ Pass / Fail / Partial ]    │
│ ☐ TC-5 State Persistence   [ Pass / Fail / Partial ]    │
│                                                         │
│ Edge Cases (if tested):                                 │
│ ☐ EC-1 Rapid Switching     [ Pass / Fail / Partial ]    │
│ ☐ EC-2 Large Output        [ Pass / Fail / Partial ]    │
│ ☐ EC-3 Network Loss        [ Pass / Fail / Partial ]    │
│                                                         │
│ Overall Status: [ ✅ PASS / ⚠️  PARTIAL / ❌ FAIL ]     │
│                                                         │
│ Critical Issues Found:                                  │
│ ___________________________________________________     │
│ ___________________________________________________     │
│ ___________________________________________________     │
│                                                         │
│ Notes:                                                  │
│ ___________________________________________________     │
│ ___________________________________________________     │
└─────────────────────────────────────────────────────────┘
```

---

## Common Issues & Fixes

### 🔴 Agent doesn't start
- [ ] Check Cline CLI installed: `npm list -g @anthropic-ai/claude-code`
- [ ] Check model server running: `curl http://localhost:8000/v1/models`
- [ ] Check terminal for error messages in Tauri logs

### 🔴 No output appears
- [ ] Wait 3-5 seconds (agent is loading)
- [ ] Check browser console for errors
- [ ] Check Tauri logs for subprocess issues

### 🔴 Permission request doesn't work
- [ ] Normal for current phase (stdin not implemented yet)
- [ ] Approved/Denied behavior may not work
- [ ] Planned for Phase 6.2

### 🔴 Stop button stuck
- [ ] Try closing app and reopening
- [ ] In Terminal: `pkill cline` to force kill
- [ ] Check `ps aux | grep cline` for zombie processes

### 🔴 Settings don't persist
- [ ] Check browser has localStorage enabled
- [ ] Look in DevTools: Application → LocalStorage
- [ ] Should show entry: `code-mode-store` (as JSON)

### 🔴 UI freezes during output
- [ ] Close browser DevTools (they slow performance)
- [ ] Close other tabs/applications
- [ ] Try with smaller output first (test in EC-2 last)

---

## Quick Cleanup After Testing

```bash
# Remove test project
rm -rf ~/test-cline-project

# Optional: Clear app cache
rm -rf ~/Library/Application\ Support/Atomic-Chat-coder*

# Check no zombie processes
ps aux | grep cline
# (should show no processes)
```

---

## Next Steps After Testing

✅ If all tests PASS:
- [ ] Archive test results
- [ ] Move to Phase 6.2 (stdin implementation)
- [ ] Prepare for production release

⚠️ If PARTIAL pass (some tests fail):
- [ ] Document which tests failed
- [ ] Create issues for failing tests
- [ ] Fix blocking issues before Phase 6.2
- [ ] Re-run Phase 6.1 after fixes

❌ If tests FAIL (critical issues):
- [ ] Document all issues
- [ ] Do NOT proceed to Phase 6.2
- [ ] Fix critical issues first
- [ ] Full re-test required

---

## Testing Support

**Questions?** Check:
1. [CODE_MODE_PHASE6_TESTING_GUIDE.md](CODE_MODE_PHASE6_TESTING_GUIDE.md) - Detailed test procedures
2. [CODE_MODE_PHASE6_VERIFICATION.md](CODE_MODE_PHASE6_VERIFICATION.md) - Implementation verification
3. Tauri logs: `~/Library/Logs/Atomic-Chat-coder*/app.log`
4. Browser console: DevTools → Console

---

**Time Estimate**: 60-90 minutes for full test suite
**Smoke Test Only**: 5-10 minutes (TC-1 + TC-2 only)

Good luck! 🚀
