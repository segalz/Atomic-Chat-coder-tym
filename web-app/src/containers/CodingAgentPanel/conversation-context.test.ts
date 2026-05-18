import { describe, expect, it } from 'vitest'
import type { CodingSession } from '@/stores/coding-agent-store'
import { buildCodingAgentPrompt } from './conversation-context'

const baseSession: CodingSession = {
  id: 'session-1',
  prompt: 'Previous request',
  source: 'manual',
  projectDir: '/repo',
  planText: 'Previous result',
  execLog: [],
  pendingDiffs: [],
  timestamp: 1,
}

describe('buildCodingAgentPrompt', () => {
  it('returns the current prompt when history is disabled', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [baseSession],
      activeSessionId: 'session-1',
      includeHistory: false,
    })

    expect(result).toBe('Current request')
  })

  it('includes the active manual session from the same project', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [baseSession],
      activeSessionId: 'session-1',
    })

    expect(result).toContain('Coding-agent context from the active conversation')
    expect(result).toContain('First request: Previous request')
    expect(result).toContain('Relevant result:\nPrevious result')
    expect(result).toContain('Current request:\nCurrent request')
  })

  it('does not include inactive manual sessions from the same project', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [baseSession],
      activeSessionId: null,
    })

    expect(result).toBe('Current request')
  })

  it('includes prior user turns from the active session log', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      activeSessionId: 'session-1',
      sessions: [{
        ...baseSession,
        execLog: [
          { type: 'text_delta', content: '> remember 5', timestamp: 1 },
          { type: 'text_delta', content: 'I will remember 5.', timestamp: 2 },
          { type: 'text_delta', content: '> add 3', timestamp: 3 },
          { type: 'text_delta', content: '5 + 3 = 8', timestamp: 4 },
        ],
      }],
    })

    expect(result).toContain('User: remember 5')
    expect(result).toContain('Assistant: I will remember 5.')
    expect(result).toContain('User: add 3')
    expect(result).toContain('Assistant: 5 + 3 = 8')
  })

  it('does not include loop sessions', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [{ ...baseSession, source: 'loop' }],
      activeSessionId: 'session-1',
    })

    expect(result).toBe('Current request')
  })

  it('does not include sessions from other projects', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [{ ...baseSession, projectDir: '/other' }],
      activeSessionId: 'session-1',
    })

    expect(result).toBe('Current request')
  })
})
