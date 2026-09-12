import { describe, expect, it } from 'vitest'
import type { CodingSession } from '@/stores/coding-agent-store'
import { buildCodingAgentPrompt } from './conversation-context'

const MAX_CONTEXT_CHARS = 6000

const ollamaSession: CodingSession = {
  id: 'ollama-session',
  prompt: 'Fix the login bug',
  source: 'manual',
  backend: 'direct-ollama',
  projectDir: '/path/project-a',
  planText: 'Login bug fixed by validating tokens.',
  execLog: [
    { type: 'text_delta', content: '> remember 5', timestamp: 1 },
    { type: 'text_delta', content: 'I will remember 5.', timestamp: 2 },
    { type: 'tool_start', content: '{"path":"src/login.ts"}', toolName: 'edit_file', timestamp: 3 },
  ],
  pendingDiffs: [],
  timestamp: 1,
}

const clineSession: CodingSession = {
  id: 'cline-session',
  prompt: 'Start the Cline work',
  source: 'manual',
  backend: 'cline-acp',
  externalSessionId: 'acp-session-123',
  projectDir: '/path/project-a',
  planText: 'Cline session plan output.',
  execLog: [
    { type: 'text_delta', content: '> cline user request', timestamp: 1 },
    { type: 'text_delta', content: 'cline assistant answer', timestamp: 2 },
  ],
  pendingDiffs: [],
  timestamp: 2,
}

describe('provider switching and context lifecycle', () => {
  it('seeds context when switching from Ollama to Cline', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Continue with Cline',
      projectDir: '/path/project-a',
      sessions: [ollamaSession],
      seedFromSessionId: 'ollama-session',
      backend: 'cline-acp',
      source: 'manual',
    })

    expect(result).toContain('Coding-agent context from previous provider session follows.')
    expect(result).toContain('First request: Fix the login bug')
    expect(result).toContain('User: remember 5')
    expect(result).toContain('Assistant: I will remember 5.')
    expect(result).toContain('Edited: src/login.ts')
    expect(result).toContain('Current request:\nContinue with Cline')
  })

  it('includes conversational context on Cline multi-turn continuation', () => {
    const prompt = 'Second turn in the same Cline conversation'
    const result = buildCodingAgentPrompt({
      prompt,
      projectDir: '/path/project-a',
      sessions: [clineSession],
      seedFromSessionId: 'cline-session',
      backend: 'cline-acp',
      isContinuation: true,
      source: 'manual',
    })

    expect(result).toContain('Coding-agent context from previous provider session follows.')
    expect(result).toContain('Current request:\nSecond turn in the same Cline conversation')
  })

  it('seeds context when switching from Cline back to Ollama', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Back on Ollama',
      projectDir: '/path/project-a',
      sessions: [clineSession],
      seedFromSessionId: 'cline-session',
      backend: 'direct-ollama',
      source: 'manual',
    })

    expect(result).toContain('Coding-agent context from previous provider session follows.')
    expect(result).toContain('First request: Start the Cline work')
    expect(result).toContain('User: cline user request')
    expect(result).toContain('Assistant: cline assistant answer')
    expect(result).toContain('Current request:\nBack on Ollama')
  })

  it('strictly enforces project directory isolation during provider switch', () => {
    const prompt = 'New request in project-b'
    const result = buildCodingAgentPrompt({
      prompt,
      projectDir: '/path/project-b',
      sessions: [ollamaSession],
      seedFromSessionId: 'ollama-session',
      backend: 'cline-acp',
      source: 'manual',
    })

    expect(result).toBe(prompt)
  })

  it('strictly enforces manual vs loop isolation during provider switch', () => {
    const manualSession: CodingSession = {
      ...ollamaSession,
      id: 'manual-session',
      source: 'manual',
    }
    const loopSession: CodingSession = {
      ...clineSession,
      id: 'loop-session',
      source: 'loop',
    }

    const manualToLoop = buildCodingAgentPrompt({
      prompt: 'New loop request',
      projectDir: '/path/project-a',
      sessions: [manualSession],
      seedFromSessionId: 'manual-session',
      source: 'loop',
    })
    expect(manualToLoop).toBe('New loop request')

    const loopToManual = buildCodingAgentPrompt({
      prompt: 'New manual request',
      projectDir: '/path/project-a',
      sessions: [loopSession],
      seedFromSessionId: 'loop-session',
      source: 'manual',
    })
    expect(loopToManual).toBe('New manual request')
  })

  it('prefers structured conversation summary over raw logs when seeding across providers', () => {
    const result = buildCodingAgentPrompt({
      prompt: 'Continue from the summary',
      projectDir: '/path/project-a',
      sessions: [{
        ...ollamaSession,
        conversationSummary: '## Conversation Goal\nValidate tokens before login.',
      }],
      seedFromSessionId: 'ollama-session',
      backend: 'cline-acp',
      source: 'manual',
    })

    expect(result).toContain('Saved conversation summary:')
    expect(result).toContain('## Conversation Goal\nValidate tokens before login.')
    expect(result).not.toContain('User: remember 5')
    expect(result).not.toContain('Assistant: I will remember 5.')
    expect(result).not.toContain('Edited: src/login.ts')
  })

  it('bounds context size when previous provider session has large logs', () => {
    const largeSession: CodingSession = {
      ...ollamaSession,
      planText: 'x'.repeat(50_000),
      execLog: Array.from({ length: 200 }, (_, index) => ({
        type: 'text_delta' as const,
        content: `Assistant: iteration ${index} — ${'y'.repeat(200)}`,
        timestamp: index + 1,
      })),
    }

    const prompt = 'New request after very large session'
    const result = buildCodingAgentPrompt({
      prompt,
      projectDir: '/path/project-a',
      sessions: [largeSession],
      seedFromSessionId: 'ollama-session',
      backend: 'cline-acp',
      source: 'manual',
    })

    expect(result).toContain('[truncated]')
    expect(result.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + prompt.length)
    expect(result).toContain(`Current request:\n${prompt}`)
  })
})
