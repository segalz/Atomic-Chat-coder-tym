import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import {
  evaluateLoopTurn,
  formatLoopTerminalMessage,
  isManualContextIsolatedFromLoop,
  isPermissionAutoApprovalAllowed,
  stopLoopExecution,
  validateLoopConcurrency,
  validateLoopPermissionProcessing,
} from './loop-lifecycle'
import {
  routeRespondPermission,
  routeSendAgentPrompt,
  routeStopAgent,
  type ActiveRun,
  type InvokeFunction,
} from './backend-router'
import { buildCodingAgentPrompt } from './conversation-context'
import { createRunEventFilter } from './agent-event-adapter'

describe('Loop Lifecycle and Bounded Scheduling — Cline ACP Integration (Stage 18)', () => {
  beforeEach(() => {
    localStorage.clear()
    useCodingAgentStore.setState({
      sessions: [],
      activeSessionId: null,
      projectDir: '/disposable/loop-project',
      draftPrompt: '',
      isRunning: false,
      planText: '',
      execLog: [],
      pendingDiffs: [],
      conversationSummary: undefined,
    })
  })

  it('Scenario 1: Bounded run limits advance sequentially and cleanly terminate at maxRuns', () => {
    const maxRuns = 3

    // Run 1 of 3: success -> advance to run 2
    const res1 = evaluateLoopTurn(1, maxRuns, true)
    expect(res1.shouldContinue).toBe(true)
    expect(res1.nextRun).toBe(2)
    expect(res1.status).toBe('countdown')

    // Run 2 of 3: success -> advance to run 3
    const res2 = evaluateLoopTurn(2, maxRuns, true)
    expect(res2.shouldContinue).toBe(true)
    expect(res2.nextRun).toBe(3)
    expect(res2.status).toBe('countdown')

    // Run 3 of 3: success -> all bounded runs completed!
    const res3 = evaluateLoopTurn(3, maxRuns, true)
    expect(res3.shouldContinue).toBe(false)
    expect(res3.nextRun).toBeNull()
    expect(res3.status).toBe('completed')
    expect(res3.reason).toContain('Completed all 3 bounded loop runs')

    // Verifying terminal message formatting
    const msg = formatLoopTerminalMessage(3, maxRuns, true)
    expect(msg).toContain('All 3 bounded iterations finished successfully')
  })

  it('Scenario 2: Failure halting immediately stops Loop sequence without retries', () => {
    const maxRuns = 5

    // Run 1 fails due to tool or model failure
    const errorMsg = 'Process crashed unexpectedly (code 1)'
    const res = evaluateLoopTurn(1, maxRuns, false, errorMsg)

    expect(res.shouldContinue).toBe(false)
    expect(res.nextRun).toBeNull()
    expect(res.status).toBe('halted')
    expect(res.reason).toBe(errorMsg)

    const terminalMsg = formatLoopTerminalMessage(1, maxRuns, false, errorMsg)
    expect(terminalMsg).toContain('Loop sequence halted')
    expect(terminalMsg).toContain('Process crashed unexpectedly')
  })

  it('Scenario 3: Unified stopLoopExecution halts active backend, clears timer, and marks interrupted (AC3)', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('Loop task', undefined, 'loop', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    useCodingAgentStore.setState({ isRunning: true })

    const activeSessionId = useCodingAgentStore.getState().activeSessionId!
    const activeRun: ActiveRun = {
      runId: 'run-loop-stop-1',
      backend: 'cline-acp',
      sessionId: activeSessionId,
    }

    // Set up active timer handle in countdown/running phase
    const timerHandle = {
      timeout: setTimeout(() => {}, 60000),
      interval: setInterval(() => {}, 1000),
    }

    // 1. Invoke unified stopLoopExecution
    const stopResult = await stopLoopExecution(
      {
        activeRun,
        selectedBackend: 'cline-acp',
        sessionId: activeSessionId,
        timerHandle,
      },
      invokeFn,
      {
        markSessionInterrupted: (id, reason) => store.markSessionInterrupted(id, reason),
        setRunning: (r) => useCodingAgentStore.setState({ isRunning: r }),
      }
    )

    // 2. Verified assertions from stopLoopExecution without test-side manual writes
    expect(stopResult.stoppedCommand).toBe('stop_cline_agent')
    expect(stopResult.targetBackend).toBe('cline-acp')
    expect(stopResult.timerCleared).toBe(true)
    expect(stopResult.sessionInterrupted).toBe(true)
    expect(timerHandle.timeout).toBeNull()
    expect(timerHandle.interval).toBeNull()
    expect(invokeFn).toHaveBeenCalledWith('stop_cline_agent', { runId: 'run-loop-stop-1' })

    const state = useCodingAgentStore.getState()
    expect(state.isRunning).toBe(false)
    const session = state.sessions.find((s) => s.id === activeSessionId)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('User stopped run')

    // 3. Test stopping during COUNTDOWN phase (no activeRun, timer pending)
    const countdownTimer = {
      timeout: setTimeout(() => {}, 30000),
      interval: null,
    }
    const countdownStopRes = await stopLoopExecution(
      {
        activeRun: null,
        selectedBackend: 'cline-acp',
        sessionId: activeSessionId,
        timerHandle: countdownTimer,
      },
      invokeFn,
      {
        markSessionInterrupted: (id, reason) => store.markSessionInterrupted(id, reason),
      }
    )
    expect(countdownStopRes.timerCleared).toBe(true)
    expect(countdownTimer.timeout).toBeNull()
  })

  it('Scenario 4: Concurrency protection prevents overlapping runs across backends during Loop', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })

    // 1. Starting Loop iteration when a Cline run is already active is rejected
    const activeClineRun: ActiveRun = { runId: 'run-active-cline', backend: 'cline-acp' }
    expect(() => validateLoopConcurrency(activeClineRun, 'cline-acp')).toThrow(
      /already active on backend 'cline-acp'/
    )

    await expect(
      routeSendAgentPrompt(
        {
          backend: 'cline-acp',
          projectDir: '/disposable/loop-project',
          prompt: 'Next loop iteration',
          activeRun: activeClineRun,
        },
        invokeFn
      )
    ).rejects.toThrow(/already active on backend 'cline-acp'/)

    // 2. Starting Loop iteration when Ollama is running is also rejected
    const activeOllamaRun: ActiveRun = { runId: 'run-active-ollama', backend: 'direct-ollama' }
    expect(() => validateLoopConcurrency(activeOllamaRun, 'cline-acp')).toThrow(
      /already active on backend 'direct-ollama'/
    )

    await expect(
      routeSendAgentPrompt(
        {
          backend: 'cline-acp',
          projectDir: '/disposable/loop-project',
          prompt: 'Next loop iteration',
          activeRun: activeOllamaRun,
        },
        invokeFn
      )
    ).rejects.toThrow(/already active on backend 'direct-ollama'/)
  })

  it('Scenario 5: Blanket auto-approval is strictly prohibited for Cline ACP in Loop mode', () => {
    // Stage 18 Criterion 6: Never enable blanket auto-approval merely to make Loop proceed
    expect(isPermissionAutoApprovalAllowed('cline-acp', 'loop')).toBe(false)
    expect(isPermissionAutoApprovalAllowed('cline-acp', 'manual')).toBe(false)
  })

  it('Scenario 6: Manual sessions and Loop sessions maintain strict context isolation (AC7)', () => {
    const store = useCodingAgentStore.getState()

    // 1. Create a manual session with confidential plan text
    store.startNewSession('Manual architectural exploration', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'completed',
    })
    const manualSessionId = useCodingAgentStore.getState().activeSessionId!
    const manualSession = useCodingAgentStore.getState().sessions.find((s) => s.id === manualSessionId)!
    manualSession.planText = 'Manual private notes: do not leak to automated loop'

    // 2. Even if includeHistory and includeSummaryContext are passed as true,
    // when source === 'loop', getActiveContextSession rejects manual source,
    // so manual history/summary is NEVER inherited!
    const loopPromptWithHistoryRequested = buildCodingAgentPrompt({
      prompt: 'Automated test suite run',
      projectDir: '/disposable/loop-project',
      sessions: [manualSession],
      activeSessionId: manualSessionId,
      source: 'loop',
      includeHistory: true, // caller requested history
      includeSummaryContext: true, // caller requested summary
    })

    expect(loopPromptWithHistoryRequested).toBe('Automated test suite run')
    expect(loopPromptWithHistoryRequested).not.toContain('Manual private notes')

    // 3. Default loop prompt path with includeHistory: false
    const defaultLoopPrompt = buildCodingAgentPrompt({
      prompt: 'Automated test suite run',
      projectDir: '/disposable/loop-project',
      sessions: [manualSession],
      activeSessionId: manualSessionId,
      source: 'loop',
      includeHistory: false,
      includeSummaryContext: false,
    })
    expect(defaultLoopPrompt).toBe('Automated test suite run')

    // 4. Context isolation helper verifies source boundary
    expect(isManualContextIsolatedFromLoop('manual', 'loop')).toBe(false)
    expect(isManualContextIsolatedFromLoop('loop', 'loop')).toBe(true)
  })

  it('Scenario 7: Stop targets active Cline ACP backend even if dropdown backend selection changed', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const activeLoopRun: ActiveRun = {
      runId: 'run-loop-dropdown-1',
      backend: 'cline-acp',
    }

    // User changed the UI backend dropdown to 'direct-ollama' while Cline Loop was running
    const res = await routeStopAgent(activeLoopRun, 'direct-ollama', invokeFn)

    expect(res.command).toBe('stop_cline_agent')
    expect(res.targetBackend).toBe('cline-acp')
    expect(invokeFn).toHaveBeenCalledWith('stop_cline_agent', { runId: 'run-loop-dropdown-1' })
    expect(invokeFn).not.toHaveBeenCalledWith('stop_ollama_agent')
  })

  it('Scenario 8: Delayed and duplicate terminal events are filtered and do not trigger extra loop turns', () => {
    const filter = createRunEventFilter('run-loop-expected')

    // 1. Initial valid prompt done event passes through
    const firstDone = {
      type: 'done' as const,
      success: true,
      error: null,
      runId: 'run-loop-expected',
    }
    expect(filter.accept(firstDone)).toBe(true)

    // 2. Stale event from old run is rejected
    const staleEvent = {
      type: 'done' as const,
      success: true,
      error: null,
      runId: 'run-loop-old',
    }
    expect(filter.accept(staleEvent)).toBe(false)

    // 3. Duplicate done event for the same run is rejected (prevents double advancing Loop)
    const duplicateDone = {
      type: 'done' as const,
      success: true,
      error: null,
      runId: 'run-loop-expected',
    }
    expect(filter.accept(duplicateDone)).toBe(false)
  })

  it('Scenario 9: Lingering and late permission requests after terminal or stop are strictly rejected (AC5)', () => {
    const activeRun: ActiveRun = {
      runId: 'run-active-123',
      backend: 'cline-acp',
    }

    // 1. Valid permission request during active running phase
    const validCheck = validateLoopPermissionProcessing('running', activeRun, 'run-active-123')
    expect(validCheck.allowed).toBe(true)

    // 2. Late permission request arriving during COUNTDOWN phase is rejected
    const countdownCheck = validateLoopPermissionProcessing('countdown', null, 'run-active-123')
    expect(countdownCheck.allowed).toBe(false)
    expect(countdownCheck.reason).toContain("Loop is in 'countdown' phase")

    // 3. Late permission request arriving after Loop COMPLETED is rejected
    const completedCheck = validateLoopPermissionProcessing('completed', null, 'run-active-123')
    expect(completedCheck.allowed).toBe(false)
    expect(completedCheck.reason).toContain("Loop is in 'completed' phase")

    // 4. Late permission request arriving after Loop HALTED is rejected
    const haltedCheck = validateLoopPermissionProcessing('halted', null, 'run-active-123')
    expect(haltedCheck.allowed).toBe(false)
    expect(haltedCheck.reason).toContain("Loop is in 'halted' phase")

    // 5. Mismatched runId during running phase is rejected
    const mismatchedCheck = validateLoopPermissionProcessing('running', activeRun, 'run-stale-999')
    expect(mismatchedCheck.allowed).toBe(false)
    expect(mismatchedCheck.reason).toContain('runId mismatch')
  })
})
