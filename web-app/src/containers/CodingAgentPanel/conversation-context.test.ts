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

  it('prefers stored summary over raw active session history', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      activeSessionId: 'session-1',
      sessions: [{
        ...baseSession,
        conversationSummary: '## Conversation Goal\nContinue safely.',
        execLog: [
          { type: 'text_delta', content: '> raw prior request', timestamp: 1 },
          { type: 'text_delta', content: 'raw prior answer', timestamp: 2 },
        ],
      }],
    })

    expect(result).toContain('Coding-agent summary context from the active conversation')
    expect(result).toContain('Saved conversation summary:\n## Conversation Goal\nContinue safely.')
    expect(result).toContain('Current request:\nCurrent request')
    expect(result).not.toContain('Current conversation so far:')
    expect(result).not.toContain('First request: Previous request')
    expect(result).not.toContain('raw prior request')
    expect(result).not.toContain('raw prior answer')
  })

  it('does not include stored summary when summary context is disabled', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      activeSessionId: 'session-1',
      includeSummaryContext: false,
      sessions: [{
        ...baseSession,
        conversationSummary: 'Stored summary',
      }],
    })

    expect(result).toContain('Current conversation so far:')
    expect(result).toContain('Relevant result:\nPrevious result')
    expect(result).not.toContain('Stored summary')
  })

  it('can include stored summary without raw history', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      activeSessionId: 'session-1',
      includeHistory: false,
      includeSummaryContext: true,
      sessions: [{
        ...baseSession,
        conversationSummary: 'Stored summary',
        execLog: [
          { type: 'text_delta', content: '> raw prior request', timestamp: 1 },
        ],
      }],
    })

    expect(result).toContain('Saved conversation summary:\nStored summary')
    expect(result).not.toContain('raw prior request')
  })

  it('does not include loop sessions', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Current request',
      projectDir: '/repo',
      sessions: [{ ...baseSession, source: 'loop', conversationSummary: 'Loop summary' }],
      activeSessionId: 'session-1',
    })

    expect(result).toBe('Current request')
  })

  it('does not leak active manual context into a loop continuation', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Loop request',
      projectDir: '/repo',
      sessions: [{
        ...baseSession,
        conversationSummary: 'Manual summary',
        execLog: [
          { type: 'text_delta', content: '> manual prior request', timestamp: 1 },
          { type: 'text_delta', content: 'manual prior answer', timestamp: 2 },
        ],
      }],
      activeSessionId: 'session-1',
      includeHistory: false,
      includeSummaryContext: false,
    })

    expect(result).toBe('Loop request')
    expect(result).not.toContain('Manual summary')
    expect(result).not.toContain('manual prior request')
    expect(result).not.toContain('manual prior answer')
  })

  it('uses only the explicitly loaded active session summary', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Continue loaded session',
      projectDir: '/repo',
      activeSessionId: 'loaded-session',
      sessions: [
        {
          ...baseSession,
          id: 'newer-session',
          conversationSummary: 'Newer inactive summary',
        },
        {
          ...baseSession,
          id: 'loaded-session',
          prompt: 'Loaded prior request',
          conversationSummary: 'Loaded session summary',
        },
      ],
    })

    expect(result).toContain('Saved conversation summary:\nLoaded session summary')
    expect(result).toContain('Current request:\nContinue loaded session')
    expect(result).not.toContain('Newer inactive summary')
    expect(result).not.toContain('Loaded prior request')
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
