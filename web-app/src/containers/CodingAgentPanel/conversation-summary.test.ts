import { describe, expect, it } from 'vitest'
import type { CodingSession } from '@/stores/coding-agent-store'
import { buildConversationSummary } from './conversation-summary'

const baseSession: CodingSession = {
  id: 'session-1',
  prompt: 'Implement the checkout flow and keep changes scoped.',
  source: 'manual',
  projectDir: '/repo',
  planText: 'Edited web-app/src/checkout/index.tsx and web-app/src/checkout/summary.ts.',
  execLog: [
    { type: 'text_delta', content: '> Implement the checkout flow and keep changes scoped.', timestamp: 1 },
    { type: 'text_delta', content: 'Updated web-app/src/checkout/index.tsx to submit orders.', timestamp: 2 },
    { type: 'error', content: 'Failed attempt: first test run timed out.', timestamp: 3 },
    { type: 'done', content: 'Done.', timestamp: 4 },
  ],
  pendingDiffs: [],
  timestamp: 1,
}

describe('buildConversationSummary', () => {
  it('builds the required structured summary for a manual session', () => {
    const summary = buildConversationSummary(baseSession)

    expect(summary).toContain('## Conversation Goal')
    expect(summary).toContain('## Decisions Made')
    expect(summary).toContain('## Important Files')
    expect(summary).toContain('## Work Already Done')
    expect(summary).toContain('## Errors / Failed Attempts')
    expect(summary).toContain('## Constraints / Do Not Break')
    expect(summary).toContain('## Current State')
    expect(summary).toContain('## Recommended Next Step')
    expect(summary).toContain('Implement the checkout flow')
    expect(summary).toContain('web-app/src/checkout/index.tsx')
    expect(summary).toContain('Failed attempt: first test run timed out.')
  })

  it('does not summarize loop sessions', () => {
    expect(buildConversationSummary({ ...baseSession, source: 'loop' })).toBeNull()
  })
})
