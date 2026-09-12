import { beforeEach, describe, expect, it } from 'vitest'
import { useCodingAgentStore } from './coding-agent-store'

function resetCodingAgentStore() {
  useCodingAgentStore.setState({
    projectDir: '',
    draftPrompt: '',
    sessions: [],
    activeSessionId: null,
    isRunning: false,
    planText: '',
    execLog: [],
    pendingDiffs: [],
    diagnostics: {},
    conversationSummary: undefined,
    conversationSummaryUpdatedAt: undefined,
    showFree: false,
    autoApproveTools: false,
  })
}

describe('useCodingAgentStore conversation summary storage', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCodingAgentStore()
  })

  it('stores a summary on the active session only', () => {
    const store = useCodingAgentStore.getState()

    store.setProjectDir('/repo')
    store.startNewSession('First request', 'thread-1', 'manual')
    useCodingAgentStore.getState().setConversationSummary('  Compact summary  ')

    const state = useCodingAgentStore.getState()
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)

    expect(state.conversationSummary).toBe('Compact summary')
    expect(state.conversationSummaryUpdatedAt).toEqual(expect.any(Number))
    expect(activeSession?.conversationSummary).toBe('Compact summary')
    expect(activeSession?.conversationSummaryUpdatedAt).toEqual(expect.any(Number))
  })

  it('starts a new session without inheriting the previous summary', () => {
    const store = useCodingAgentStore.getState()

    store.setProjectDir('/repo')
    store.startNewSession('First request', 'thread-1', 'manual')
    useCodingAgentStore.getState().setConversationSummary('Previous summary')
    const firstSessionId = useCodingAgentStore.getState().activeSessionId

    useCodingAgentStore.getState().startNewSession('Second request', 'thread-2', 'manual')

    const state = useCodingAgentStore.getState()
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
    const previousSession = state.sessions.find((session) => session.id === firstSessionId)

    expect(activeSession?.prompt).toBe('Second request')
    expect(activeSession?.conversationSummary).toBeUndefined()
    expect(activeSession?.conversationSummaryUpdatedAt).toBeUndefined()
    expect(state.conversationSummary).toBeUndefined()
    expect(state.conversationSummaryUpdatedAt).toBeUndefined()
    expect(previousSession?.conversationSummary).toBe('Previous summary')
  })

  it('loads a summarized session into runtime state', () => {
    const store = useCodingAgentStore.getState()

    store.setProjectDir('/repo')
    store.startNewSession('First request', 'thread-1', 'manual')
    useCodingAgentStore.getState().setConversationSummary('Stored summary')
    const firstSessionId = useCodingAgentStore.getState().activeSessionId

    useCodingAgentStore.getState().startNewSession('Second request', 'thread-2', 'manual')
    useCodingAgentStore.getState().loadSession(firstSessionId!)

    const state = useCodingAgentStore.getState()

    expect(state.activeSessionId).toBe(firstSessionId)
    expect(state.conversationSummary).toBe('Stored summary')
    expect(state.conversationSummaryUpdatedAt).toEqual(expect.any(Number))
  })

  it('clears active summary state for a clean code mode session', () => {
    const store = useCodingAgentStore.getState()

    store.setProjectDir('/repo')
    store.startNewSession('First request', 'thread-1', 'manual')
    useCodingAgentStore.getState().setConversationSummary('Stored summary')

    useCodingAgentStore.getState().clearSession()

    const state = useCodingAgentStore.getState()

    expect(state.activeSessionId).toBeNull()
    expect(state.planText).toBe('')
    expect(state.execLog).toEqual([])
    expect(state.pendingDiffs).toEqual([])
    expect(state.conversationSummary).toBeUndefined()
    expect(state.conversationSummaryUpdatedAt).toBeUndefined()
  })

  it('does not store a summary on a loop session', () => {
    const store = useCodingAgentStore.getState()

    store.setProjectDir('/repo')
    store.startNewSession('Loop request', 'thread-1', 'loop')
    useCodingAgentStore.getState().setConversationSummary('Loop summary')

    const state = useCodingAgentStore.getState()
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)

    expect(activeSession?.conversationSummary).toBeUndefined()
    expect(activeSession?.conversationSummaryUpdatedAt).toBeUndefined()
    expect(state.conversationSummary).toBeUndefined()
    expect(state.conversationSummaryUpdatedAt).toBeUndefined()
  })
})

describe('useCodingAgentStore Stage 13 session identity persistence & migration', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCodingAgentStore()
  })

  it('starts a new session with Cline ACP identity metadata', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/path/to/project')

    store.startNewSession('Fix bug with Cline', undefined, 'manual', {
      backend: 'cline-acp',
      providerId: 'zai',
      modelId: 'zai/glm-5.3-flash',
      externalSessionId: 'acp-session-xyz',
      status: 'running',
    })

    const state = useCodingAgentStore.getState()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)

    expect(session).toBeDefined()
    expect(session?.backend).toBe('cline-acp')
    expect(session?.providerId).toBe('zai')
    expect(session?.modelId).toBe('zai/glm-5.3-flash')
    expect(session?.externalSessionId).toBe('acp-session-xyz')
    expect(session?.status).toBe('running')
    expect(session?.projectDir).toBe('/path/to/project')
  })

  it('updates session identity via setSessionIdentity', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')
    store.startNewSession('Initial prompt', undefined, 'manual')
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    store.setSessionIdentity(sessionId, {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      externalSessionId: 'bound-session-456',
    })

    const state = useCodingAgentStore.getState()
    const session = state.sessions.find((s) => s.id === sessionId)
    expect(session?.backend).toBe('cline-acp')
    expect(session?.modelId).toBe('zai/glm-5.3-flash')
    expect(session?.externalSessionId).toBe('bound-session-456')
  })

  it('updates lifecycle status via setSessionStatus and markSessionInterrupted', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')
    store.startNewSession('Testing status', undefined, 'manual', {
      backend: 'cline-acp',
      status: 'running',
    })
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    // Mark as completed
    store.setSessionStatus(sessionId, 'completed')
    expect(useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)?.status).toBe('completed')

    // Mark as failed
    store.setSessionStatus(sessionId, 'failed', 'Network error')
    let session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('failed')
    expect(session?.interruptedReason).toBe('Network error')

    // Mark as interrupted via user stop
    store.markSessionInterrupted(sessionId, 'User cancelled')
    session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('User cancelled')
  })

  it('safely migrates old stored sessions from version 0 without data loss', async () => {
    // Simulate legacy localStorage from version 0
    const legacySessionId = 'legacy-sess-1'
    const legacyState = {
      state: {
        projectDir: '/legacy/repo',
        draftPrompt: 'draft prompt',
        sessions: [
          {
            id: legacySessionId,
            prompt: 'Legacy task',
            source: 'manual',
            projectDir: '/legacy/repo',
            planText: 'Step 1: check files\nStep 2: fix',
            execLog: [
              { type: 'text_delta', content: 'Starting legacy agent', timestamp: 1000 },
              { type: 'done', content: 'Finished successfully', timestamp: 2000 },
            ],
            pendingDiffs: [
              { id: 'diff-1', filePath: 'a.txt', search: 'old', replace: 'new', status: 'approved' },
            ],
            conversationSummary: 'Legacy session summary',
            conversationSummaryUpdatedAt: 1500,
            timestamp: 1000,
          },
        ],
        activeSessionId: legacySessionId,
        planText: 'Step 1: check files\nStep 2: fix',
        execLog: [
          { type: 'text_delta', content: 'Starting legacy agent', timestamp: 1000 },
          { type: 'done', content: 'Finished successfully', timestamp: 2000 },
        ],
        pendingDiffs: [],
        diagnostics: {},
      },
      version: 0,
    }

    localStorage.setItem('coding-agent-store', JSON.stringify(legacyState))

    // Trigger rehydration / store reload
    await useCodingAgentStore.persist.rehydrate()

    const state = useCodingAgentStore.getState()
    expect(state.sessions).toHaveLength(1)
    const migrated = state.sessions[0]
    expect(migrated.id).toBe(legacySessionId)
    expect(migrated.prompt).toBe('Legacy task')
    expect(migrated.planText).toBe('Step 1: check files\nStep 2: fix')
    expect(migrated.execLog).toHaveLength(2)
    expect(migrated.pendingDiffs).toHaveLength(1)
    expect(migrated.pendingDiffs[0].status).toBe('approved')
    expect(migrated.conversationSummary).toBe('Legacy session summary')
    expect(migrated.conversationSummaryUpdatedAt).toBe(1500)
    expect(migrated.projectDir).toBe('/legacy/repo')
    // Legacy session has no backend explicitly set; resolves cleanly
    expect(migrated.backend).toBeUndefined()
    expect(migrated.externalSessionId).toBeUndefined()
    expect(state.isRunning).toBe(false)
  })

  it('safely migrates unversioned in-flight runs and marks active session interrupted on restart', async () => {
    // Unversioned legacy state (no version key) where app crashed mid-run
    const unversionedSessionId = 'unversioned-in-flight-1'
    const unversionedState = {
      state: {
        projectDir: '/unversioned/repo',
        draftPrompt: 'User prompt in flight',
        sessions: [
          {
            id: unversionedSessionId,
            prompt: 'In-flight task before versioning',
            source: 'manual',
            projectDir: '/unversioned/repo',
            planText: 'Working on code...',
            execLog: [
              { type: 'text_delta', content: 'Analyzing repo...', timestamp: 1000 },
            ],
            pendingDiffs: [],
            timestamp: 1000,
          },
        ],
        activeSessionId: unversionedSessionId,
        isRunning: true,
        planText: 'Working on code...',
        execLog: [
          { type: 'text_delta', content: 'Analyzing repo...', timestamp: 1000 },
        ],
        pendingDiffs: [],
        diagnostics: {},
      },
    }

    localStorage.setItem('coding-agent-store', JSON.stringify(unversionedState))

    await useCodingAgentStore.persist.rehydrate()

    const state = useCodingAgentStore.getState()
    expect(state.isRunning).toBe(false)
    const session = state.sessions.find((s) => s.id === unversionedSessionId)
    expect(session).toBeDefined()
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('Application restarted while run was active')
    expect(state.draftPrompt).toBe('User prompt in flight')
  })

  it('clears interruptedReason when a session transitions to completed or running', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')
    store.startNewSession('Testing status reason clearing', undefined, 'manual')
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    // First mark failed with an error
    store.setSessionStatus(sessionId, 'failed', 'Network timeout')
    let session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('failed')
    expect(session?.interruptedReason).toBe('Network timeout')

    // Transitioning to running clears the previous failure reason
    store.setSessionStatus(sessionId, 'running')
    session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('running')
    expect(session?.interruptedReason).toBeUndefined()

    // Interrupt again
    store.markSessionInterrupted(sessionId, 'Stopped by user')
    session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('Stopped by user')

    // Transitioning to completed clears the interrupted reason
    store.setSessionStatus(sessionId, 'completed')
    session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.status).toBe('completed')
    expect(session?.interruptedReason).toBeUndefined()
  })

  it('marks running sessions as interrupted on restart/rehydration without prompt replay', async () => {
    // Simulate application restart while a run was active
    const interruptedSessionId = 'interrupted-sess-1'
    const crashedState = {
      state: {
        projectDir: '/active/repo',
        draftPrompt: 'User prompt that was running',
        sessions: [
          {
            id: interruptedSessionId,
            prompt: 'In-progress task',
            source: 'manual',
            projectDir: '/active/repo',
            backend: 'cline-acp',
            modelId: 'zai/glm-5.3-flash',
            externalSessionId: 'ext-crashed-1',
            status: 'running',
            planText: 'Working on it...',
            execLog: [
              { type: 'text_delta', content: 'Generating code...', timestamp: 1000 },
            ],
            pendingDiffs: [],
            timestamp: 1000,
          },
        ],
        activeSessionId: interruptedSessionId,
        isRunning: true,
        planText: 'Working on it...',
        execLog: [
          { type: 'text_delta', content: 'Generating code...', timestamp: 1000 },
        ],
        pendingDiffs: [],
        diagnostics: {},
      },
      version: 1,
    }

    localStorage.setItem('coding-agent-store', JSON.stringify(crashedState))

    // Rehydrate
    await useCodingAgentStore.persist.rehydrate()

    const state = useCodingAgentStore.getState()
    // 1. isRunning must be reset to false (never keep running state on boot)
    expect(state.isRunning).toBe(false)

    // 2. Running session must be marked interrupted
    const session = state.sessions.find((s) => s.id === interruptedSessionId)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('Application restarted while run was active')

    // 3. Prompt is not auto-replayed (isRunning stays false, no active execution started)
    expect(state.isRunning).toBe(false)
    // Draft prompt text is preserved for user editing if needed
    expect(state.draftPrompt).toBe('User prompt that was running')
  })

  it('restores project directory on loadSession and enforces project isolation', () => {
    const store = useCodingAgentStore.getState()

    // Session 1 in /repo-a
    store.setProjectDir('/repo-a')
    store.startNewSession('Task in A', undefined, 'manual', {
      backend: 'cline-acp',
      externalSessionId: 'sess-a',
    })
    const sessAId = useCodingAgentStore.getState().activeSessionId!

    // Session 2 in /repo-b
    store.setProjectDir('/repo-b')
    store.startNewSession('Task in B', undefined, 'manual', {
      backend: 'direct-ollama',
    })
    const sessBId = useCodingAgentStore.getState().activeSessionId!

    // Currently in /repo-b
    expect(useCodingAgentStore.getState().projectDir).toBe('/repo-b')

    // Load Session A -> projectDir must switch back to /repo-a
    store.loadSession(sessAId)
    const stateA = useCodingAgentStore.getState()
    expect(stateA.activeSessionId).toBe(sessAId)
    expect(stateA.projectDir).toBe('/repo-a')

    // Load Session B -> projectDir must switch back to /repo-b
    store.loadSession(sessBId)
    const stateB = useCodingAgentStore.getState()
    expect(stateB.activeSessionId).toBe(sessBId)
    expect(stateB.projectDir).toBe('/repo-b')
  })

  it('gracefully handles loading a session with missing or undefined externalSessionId', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')

    // Start session without external session id (or one that was lost)
    store.startNewSession('Task with missing external session', undefined, 'manual', {
      backend: 'cline-acp',
      status: 'completed',
    })
    const sessId = useCodingAgentStore.getState().activeSessionId!

    // Load it
    store.loadSession(sessId)

    const state = useCodingAgentStore.getState()
    expect(state.activeSessionId).toBe(sessId)
    expect(state.isRunning).toBe(false)
    const session = state.sessions.find((s) => s.id === sessId)
    expect(session?.externalSessionId).toBeUndefined()
    expect(session?.status).toBe('completed')
  })
})

describe('useCodingAgentStore autoApproveTools', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCodingAgentStore()
  })

  it('defaults to false and can be toggled on and off', () => {
    expect(useCodingAgentStore.getState().autoApproveTools).toBe(false)

    useCodingAgentStore.getState().setAutoApproveTools(true)
    expect(useCodingAgentStore.getState().autoApproveTools).toBe(true)

    useCodingAgentStore.getState().setAutoApproveTools(false)
    expect(useCodingAgentStore.getState().autoApproveTools).toBe(false)
  })
})

describe('useCodingAgentStore session management (rename, delete, clear)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCodingAgentStore()
  })

  it('renames a session by id', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Original Prompt', undefined, 'manual')
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    useCodingAgentStore.getState().renameSession(sessionId, 'Updated Prompt Title')

    const session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.prompt).toBe('Updated Prompt Title')
  })

  it('ignores rename with empty or whitespace string', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Original Prompt', undefined, 'manual')
    const sessionId = useCodingAgentStore.getState().activeSessionId!

    useCodingAgentStore.getState().renameSession(sessionId, '   ')

    const session = useCodingAgentStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.prompt).toBe('Original Prompt')
  })

  it('deletes a non-active session without affecting active session', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Session 1', undefined, 'manual')
    const id1 = useCodingAgentStore.getState().activeSessionId!

    useCodingAgentStore.getState().startNewSession('Session 2', undefined, 'manual')
    const id2 = useCodingAgentStore.getState().activeSessionId!

    expect(useCodingAgentStore.getState().sessions).toHaveLength(2)

    useCodingAgentStore.getState().deleteSession(id1)

    const state = useCodingAgentStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].id).toBe(id2)
    expect(state.activeSessionId).toBe(id2)
  })

  it('deletes active session and resets active session state', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Active Session', undefined, 'manual')
    const id = useCodingAgentStore.getState().activeSessionId!
    store.appendPlanText('Some plan')

    useCodingAgentStore.getState().deleteSession(id)

    const state = useCodingAgentStore.getState()
    expect(state.sessions).toHaveLength(0)
    expect(state.activeSessionId).toBeNull()
    expect(state.planText).toBe('')
  })

  it('deletes all sessions and resets runtime state', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Session 1', undefined, 'manual')
    store.startNewSession('Session 2', undefined, 'manual')
    store.appendPlanText('Plan')

    expect(useCodingAgentStore.getState().sessions).toHaveLength(2)

    useCodingAgentStore.getState().deleteAllSessions()

    const state = useCodingAgentStore.getState()
    expect(state.sessions).toHaveLength(0)
    expect(state.activeSessionId).toBeNull()
    expect(state.planText).toBe('')
    expect(state.execLog).toEqual([])
  })

  it('clears session and resets draftPrompt', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Session 1', undefined, 'manual')
    store.setDraftPrompt('Some pending prompt')
    store.appendPlanText('Plan')

    useCodingAgentStore.getState().clearSession()

    const state = useCodingAgentStore.getState()
    expect(state.activeSessionId).toBeNull()
    expect(state.draftPrompt).toBe('')
    expect(state.planText).toBe('')
    expect(state.execLog).toEqual([])
  })
})

