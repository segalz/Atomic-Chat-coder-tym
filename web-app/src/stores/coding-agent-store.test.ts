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
