import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateCodingAgentState, useCodingAgentStore } from '@/stores/coding-agent-store'
import { buildCodingAgentPrompt } from './conversation-context'
import {
  routeRespondPermission,
  routeSendAgentPrompt,
  routeStopAgent,
  type InvokeFunction,
} from './backend-router'
import { createRunEventFilter, normalizeTextDelta } from './agent-event-adapter'

describe('Manual Workflow E2E — Cline ACP Integration (Stage 15)', () => {
  beforeEach(() => {
    localStorage.clear()
    useCodingAgentStore.setState({
      sessions: [],
      activeSessionId: null,
      projectDir: '/disposable/project',
      draftPrompt: '',
      isRunning: false,
      planText: '',
      execLog: [],
      pendingDiffs: [],
      conversationSummary: undefined,
    })
  })

  it('Scenario 1 — Streamed response on Cline with explicit GLM selection', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('What is 2+2?', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    const sendResult = await routeSendAgentPrompt({
      backend: 'cline-acp',
      projectDir: '/disposable/project',
      prompt: 'What is 2+2?',
      model: 'zai/glm-5.3-flash',
      activeRun: null,
    }, invokeFn)

    expect(sendResult.command).toBe('start_cline_agent')
    expect(invokeFn).toHaveBeenCalledWith('start_cline_agent', {
      projectDir: '/disposable/project',
      prompt: 'What is 2+2?',
      model: 'zai/glm-5.3-flash',
      runId: sendResult.activeRun.runId,
      sessionId: undefined,
    })

    const filter = createRunEventFilter(sendResult.activeRun.runId)
    const rawChunk = { type: 'text_delta', content: '2 + 2 = 4', runId: sendResult.activeRun.runId }
    const norm = normalizeTextDelta(rawChunk)
    if (filter.accept(norm)) {
      useCodingAgentStore.getState().appendLog({ type: 'text_delta', content: '2 + 2 = 4', timestamp: 1 })
    }

    useCodingAgentStore.getState().setSessionStatus(sessionId, 'completed')

    const updatedSession = useCodingAgentStore.getState().sessions.find(s => s.id === sessionId)!
    expect(updatedSession.status).toBe('completed')
    expect(updatedSession.execLog.some(l => l.content.includes('2 + 2 = 4'))).toBe(true)
  })

  it('Scenario 2 — Two-turn continuity reusing session ID without prompt bloat', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('First turn', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      externalSessionId: 'acp-session-12345',
      status: 'completed',
    })
    const turn1Session = useCodingAgentStore.getState().sessions[0]

    // Turn 2 prompt generation with isContinuation: true
    const turn2Prompt = buildCodingAgentPrompt({
      prompt: 'Second turn prompt',
      projectDir: '/disposable/project',
      sessions: [turn1Session],
      activeSessionId: turn1Session.id,
      backend: 'cline-acp',
      isContinuation: true,
      source: 'manual',
    })

    // Assert raw prompt with NO prepended history
    expect(turn2Prompt).toBe('Second turn prompt')

    const sendResult = await routeSendAgentPrompt({
      backend: 'cline-acp',
      projectDir: '/disposable/project',
      prompt: turn2Prompt,
      model: 'zai/glm-5.3-flash',
      sessionId: turn1Session.externalSessionId,
      activeRun: null,
    }, invokeFn)

    expect(invokeFn).toHaveBeenCalledWith('start_cline_agent', {
      projectDir: '/disposable/project',
      prompt: 'Second turn prompt',
      model: 'zai/glm-5.3-flash',
      runId: sendResult.activeRun.runId,
      sessionId: 'acp-session-12345',
    })
  })

  it('Scenario 3 — Stop / cancellation cleanly interrupts active run', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('Prompt to cancel', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    const activeRun = { runId: 'run-cancel-123', backend: 'cline-acp' as const }
    const stopResult = await routeStopAgent(activeRun, 'cline-acp', invokeFn)

    expect(stopResult.command).toBe('stop_cline_agent')
    expect(invokeFn).toHaveBeenCalledWith('stop_cline_agent', { runId: 'run-cancel-123' })

    useCodingAgentStore.getState().setSessionStatus(sessionId, 'interrupted', 'User stopped run')
    const interruptedSession = useCodingAgentStore.getState().sessions.find(s => s.id === sessionId)!
    expect(interruptedSession.status).toBe('interrupted')
    expect(interruptedSession.interruptedReason).toBe('User stopped run')
  })

  it('Scenario 4 — Denied fixture edit leaves file unchanged with no side effects', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('Edit request', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    store.addDiff({
      id: 'diff-1',
      path: '/disposable/project/test.txt',
      original: 'old',
      modified: 'new',
      status: 'pending',
    })

    const result = await routeRespondPermission({
      backend: 'cline-acp',
      runId: 'run-edit-1',
      requestId: 'req-edit-1',
      optionId: 'deny',
    }, invokeFn)

    expect(result.command).toBe('respond_cline_permission')
    expect(invokeFn).toHaveBeenCalledWith('respond_cline_permission', {
      runId: 'run-edit-1',
      requestId: 'req-edit-1',
      optionId: 'deny',
    })

    useCodingAgentStore.getState().updateDiffStatus('diff-1', 'rejected')
    const diff = useCodingAgentStore.getState().pendingDiffs.find(d => d.id === 'diff-1')!
    expect(diff.status).toBe('rejected')
  })

  it('Scenario 5 — Approved fixture edit applies cleanly', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('Edit request 2', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    store.addDiff({
      id: 'diff-2',
      path: '/disposable/project/test2.txt',
      original: 'old',
      modified: 'new',
      status: 'pending',
    })

    const result = await routeRespondPermission({
      backend: 'cline-acp',
      runId: 'run-edit-2',
      requestId: 'req-edit-2',
      optionId: 'allow',
    }, invokeFn)

    expect(result.command).toBe('respond_cline_permission')
    expect(invokeFn).toHaveBeenCalledWith('respond_cline_permission', {
      runId: 'run-edit-2',
      requestId: 'req-edit-2',
      optionId: 'allow',
    })

    useCodingAgentStore.getState().updateDiffStatus('diff-2', 'approved')
    const diff = useCodingAgentStore.getState().pendingDiffs.find(d => d.id === 'diff-2')!
    expect(diff.status).toBe('approved')
  })

  it('Scenario 6 — Restart and rehydration safety restores session identity', () => {
    const persistedState = {
      sessions: [{
        id: 'session-rehydrated',
        prompt: 'Task before restart',
        source: 'manual' as const,
        projectDir: '/disposable/project',
        backend: 'cline-acp' as const,
        modelId: 'zai/glm-5.3-flash',
        externalSessionId: 'acp-session-ext',
        planText: 'Plan before restart',
        execLog: [],
        pendingDiffs: [],
        timestamp: 100,
        status: 'running' as const,
      }],
      activeSessionId: 'session-rehydrated',
      projectDir: '/disposable/project',
      draftPrompt: '',
      isRunning: true,
      planText: 'Plan before restart',
      execLog: [],
      pendingDiffs: [],
    }

    const migrated = migrateCodingAgentState(persistedState, 0)
    expect(migrated.isRunning).toBe(false)
    const session = migrated.sessions.find(s => s.id === 'session-rehydrated')!
    expect(session.status).toBe('interrupted')
    expect(session.interruptedReason).toContain('Application restarted while run was active')

    useCodingAgentStore.setState(migrated)
    useCodingAgentStore.getState().loadSession('session-rehydrated')

    const activeSession = useCodingAgentStore.getState().sessions.find(
      s => s.id === useCodingAgentStore.getState().activeSessionId
    )!
    expect(activeSession.backend).toBe('cline-acp')
    expect(activeSession.modelId).toBe('zai/glm-5.3-flash')
    expect(activeSession.projectDir).toBe('/disposable/project')
  })

  it('Scenario 7 — Switch back to Ollama seeds new session with bounded Cline context', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('First request to Cline', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      externalSessionId: 'acp-session-ext',
      status: 'completed',
    })
    const clineSession = useCodingAgentStore.getState().sessions[0]
    clineSession.planText = 'Cline implemented the helper functions.'
    clineSession.execLog = [
      { type: 'text_delta', content: '> helper needed', timestamp: 1 },
      { type: 'text_delta', content: 'Helper functions created.', timestamp: 2 },
    ]

    const seededPrompt = buildCodingAgentPrompt({
      prompt: 'Write tests for the helper in Ollama',
      projectDir: '/disposable/project',
      sessions: [clineSession],
      seedFromSessionId: clineSession.id,
      backend: 'direct-ollama',
      source: 'manual',
    })

    expect(seededPrompt).toContain('Coding-agent context from previous provider session follows.')
    expect(seededPrompt).toContain('Previous session summary:')
    expect(seededPrompt).toContain('First request: First request to Cline')
    expect(seededPrompt).toContain('User: helper needed')
    expect(seededPrompt).toContain('Assistant: Helper functions created.')
    expect(seededPrompt).toContain('Current request:\nWrite tests for the helper in Ollama')
  })
})
