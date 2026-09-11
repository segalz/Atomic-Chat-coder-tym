import { beforeEach, describe, expect, it } from 'vitest'
import {
  useCodingAgentStore,
  type CodingSession,
} from '@/stores/coding-agent-store'
import {
  CLINE_ACP_BACKEND,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_DEFAULT_PROVIDER_ID,
} from './backend-identity'

function resetStore() {
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
  })
}

describe('Stage 13 — Session Identity Persistence & Lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  it('persists Cline ACP session identity upon new session initialization', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('C:\\Develop\\TestProject')

    store.startNewSession('Implement feature with Cline', undefined, 'manual', {
      backend: CLINE_ACP_BACKEND,
      providerId: CLINE_DEFAULT_PROVIDER_ID,
      modelId: CLINE_DEFAULT_MODEL_ID,
      externalSessionId: 'acp-ext-uuid-1234',
      status: 'running',
    })

    const state = useCodingAgentStore.getState()
    const active = state.sessions.find((s) => s.id === state.activeSessionId)

    expect(active).toBeDefined()
    expect(active?.backend).toBe('cline-acp')
    expect(active?.providerId).toBe('zai')
    expect(active?.modelId).toBe('zai/glm-5.3-flash')
    expect(active?.externalSessionId).toBe('acp-ext-uuid-1234')
    expect(active?.status).toBe('running')
    expect(active?.projectDir).toBe('C:\\Develop\\TestProject')
  })

  it('records completed status and failure status on session finish', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')
    store.startNewSession('Run task', undefined, 'manual', {
      backend: 'cline-acp',
      status: 'running',
    })
    const id = useCodingAgentStore.getState().activeSessionId!

    // Mark completed
    store.setSessionStatus(id, 'completed')
    let session = useCodingAgentStore.getState().sessions.find((s) => s.id === id)
    expect(session?.status).toBe('completed')

    // Mark failed with error
    store.setSessionStatus(id, 'failed', 'Connection to agent was reset')
    session = useCodingAgentStore.getState().sessions.find((s) => s.id === id)
    expect(session?.status).toBe('failed')
    expect(session?.interruptedReason).toBe('Connection to agent was reset')
  })

  it('records interrupted status when stopped by user', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')
    store.startNewSession('Long task', undefined, 'manual', {
      backend: 'cline-acp',
      status: 'running',
    })
    const id = useCodingAgentStore.getState().activeSessionId!

    store.markSessionInterrupted(id, 'User stopped run')
    const session = useCodingAgentStore.getState().sessions.find((s) => s.id === id)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('User stopped run')
  })

  it('restores projectDir on loadSession across multiple projects', () => {
    const store = useCodingAgentStore.getState()

    // Create session in Project Alpha
    store.setProjectDir('/projects/alpha')
    store.startNewSession('Task in Alpha', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
    })
    const alphaId = useCodingAgentStore.getState().activeSessionId!

    // Create session in Project Beta
    store.setProjectDir('/projects/beta')
    store.startNewSession('Task in Beta', undefined, 'manual', {
      backend: 'direct-ollama',
      modelId: 'qwen2.5-coder:7b',
    })
    const betaId = useCodingAgentStore.getState().activeSessionId!

    expect(useCodingAgentStore.getState().projectDir).toBe('/projects/beta')

    // Loading Alpha restores /projects/alpha
    store.loadSession(alphaId)
    expect(useCodingAgentStore.getState().projectDir).toBe('/projects/alpha')
    expect(useCodingAgentStore.getState().activeSessionId).toBe(alphaId)

    // Loading Beta restores /projects/beta
    store.loadSession(betaId)
    expect(useCodingAgentStore.getState().projectDir).toBe('/projects/beta')
    expect(useCodingAgentStore.getState().activeSessionId).toBe(betaId)
  })

  it('gracefully handles missing external session without crash or prompt replay', () => {
    const store = useCodingAgentStore.getState()
    store.setProjectDir('/repo')

    // Session persisted without external session ID
    store.startNewSession('Task with no external ID', undefined, 'manual', {
      backend: 'cline-acp',
      status: 'completed',
    })
    const id = useCodingAgentStore.getState().activeSessionId!

    store.loadSession(id)
    const state = useCodingAgentStore.getState()

    expect(state.activeSessionId).toBe(id)
    expect(state.isRunning).toBe(false)
    const session = state.sessions.find((s) => s.id === id)
    expect(session?.externalSessionId).toBeUndefined()
  })

  it('preserves all execution history and plan during restart rehydration', async () => {
    const testSession: CodingSession = {
      id: 'sess-persist-test',
      prompt: 'Refactor database queries',
      source: 'manual',
      projectDir: '/repo/backend',
      planText: '1. Update models\n2. Run migrations',
      execLog: [
        { type: 'text_delta', content: 'Beginning migration...', timestamp: 100 },
        { type: 'thinking', content: 'Analyzing schema...', timestamp: 150 },
        { type: 'tool_start', content: '{"file":"db.ts"}', toolName: 'read_file', timestamp: 200 },
        { type: 'tool_result', content: 'export const db = ...', toolName: 'read_file', timestamp: 250 },
      ],
      pendingDiffs: [],
      timestamp: 100,
      backend: 'cline-acp',
      providerId: 'zai',
      modelId: 'zai/glm-5.3-flash',
      externalSessionId: 'ext-uuid-999',
      status: 'running',
    }

    const persistedState = {
      state: {
        projectDir: '/repo/backend',
        draftPrompt: 'Follow up prompt',
        sessions: [testSession],
        activeSessionId: testSession.id,
        isRunning: true,
        planText: testSession.planText,
        execLog: testSession.execLog,
        pendingDiffs: [],
        diagnostics: {},
      },
      version: 1,
    }

    localStorage.setItem('coding-agent-store', JSON.stringify(persistedState))

    // Rehydrate
    await useCodingAgentStore.persist.rehydrate()

    const state = useCodingAgentStore.getState()

    // 1. isRunning must be false on restart
    expect(state.isRunning).toBe(false)

    // 2. Session transitioned to interrupted with explicit reason
    const rehydrated = state.sessions.find((s) => s.id === testSession.id)
    expect(rehydrated).toBeDefined()
    expect(rehydrated?.status).toBe('interrupted')
    expect(rehydrated?.interruptedReason).toBe('Application restarted while run was active')

    // 3. Transcript and plan completely preserved
    expect(rehydrated?.planText).toBe('1. Update models\n2. Run migrations')
    expect(rehydrated?.execLog).toHaveLength(4)
    expect(rehydrated?.backend).toBe('cline-acp')
    expect(rehydrated?.modelId).toBe('zai/glm-5.3-flash')
    expect(rehydrated?.externalSessionId).toBe('ext-uuid-999')

    // 4. No prompt auto-replay
    expect(state.isRunning).toBe(false)
    expect(state.draftPrompt).toBe('Follow up prompt')
  })
})
