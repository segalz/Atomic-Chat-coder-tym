import { describe, expect, it } from 'vitest'
import {
  createRunEventFilter,
  normalizeAcpMessageChunk,
  normalizeAcpPromptDone,
  normalizeAcpSessionUpdate,
  normalizeAcpThoughtChunk,
  normalizeAcpToolCall,
  normalizeAcpToolCallUpdate,
} from './agent-event-adapter'

describe('agent-event-adapter (Stage 08 ACP stream normalization)', () => {
  const testContext = {
    runId: 'run-test-123',
    backend: 'cline-acp' as const,
    sessionId: 'session-acp-456',
  }

  it('preserves order of streamed message chunks', () => {
    const chunk1 = normalizeAcpSessionUpdate(
      {
        type: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello, ' },
      },
      testContext
    )
    const chunk2 = normalizeAcpSessionUpdate(
      {
        type: 'agent_message_chunk',
        content: { type: 'text', text: 'world!' },
      },
      testContext
    )

    expect(chunk1).toEqual([
      {
        type: 'text_delta',
        text: 'Hello, ',
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])
    expect(chunk2).toEqual([
      {
        type: 'text_delta',
        text: 'world!',
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])
  })

  it('maps agent_thought_chunk to thinking without fabricating missing reasoning', () => {
    const thought = normalizeAcpSessionUpdate(
      {
        type: 'agent_thought_chunk',
        content: { type: 'text', text: 'I need to check the file contents first.' },
      },
      testContext
    )

    expect(thought).toEqual([
      {
        type: 'thinking',
        text: 'I need to check the file contents first.',
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])

    // Ordinary message chunk does not include thinking
    const msg = normalizeAcpMessageChunk({ text: 'Done.' }, testContext)
    expect(msg.type).toBe('text_delta')
  })

  it('preserves opaque tool call IDs across start and update', () => {
    const start = normalizeAcpSessionUpdate(
      {
        type: 'tool_call',
        toolCallId: 'tool-call-abc-789',
        title: 'read_file',
        kind: 'filesystem',
        input: { path: 'src/main.rs' },
      },
      testContext
    )

    expect(start).toEqual([
      {
        type: 'tool_start',
        id: 'tool-call-abc-789',
        name: 'read_file',
        input: { path: 'src/main.rs' },
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])

    const update = normalizeAcpSessionUpdate(
      {
        type: 'tool_call_update',
        toolCallId: 'tool-call-abc-789',
        status: 'completed',
        output: 'file content here',
      },
      testContext
    )

    expect(update).toEqual([
      {
        type: 'tool_result',
        id: 'tool-call-abc-789',
        output: 'file content here',
        isError: false,
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])
  })

  it('suppresses session_info_update from visible chat text stream', () => {
    const infoUpdate = normalizeAcpSessionUpdate(
      {
        type: 'session_info_update',
        info: { mode: 'plan', model: 'zai/glm-5.3-flash' },
      },
      testContext
    )

    expect(infoUpdate).toEqual([])
  })

  it('normalizes prompt done terminal outcomes accurately', () => {
    const endTurn = normalizeAcpPromptDone({ stopReason: 'end_turn' }, testContext)
    expect(endTurn).toEqual({
      type: 'done',
      success: true,
      error: null,
      runId: 'run-test-123',
      backend: 'cline-acp',
      sessionId: 'session-acp-456',
    })

    const cancelled = normalizeAcpPromptDone({ stopReason: 'cancelled' }, testContext)
    expect(cancelled).toEqual({
      type: 'done',
      success: false,
      error: 'User cancelled turn',
      runId: 'run-test-123',
      backend: 'cline-acp',
      sessionId: 'session-acp-456',
    })

    const other = normalizeAcpPromptDone(
      { stopReason: 'max_tokens', error: 'Token limit exceeded' },
      testContext
    )
    expect(other).toEqual({
      type: 'done',
      success: false,
      error: 'Token limit exceeded',
      runId: 'run-test-123',
      backend: 'cline-acp',
      sessionId: 'session-acp-456',
    })
  })

  it('enforces run isolation by rejecting events from mismatched run IDs', () => {
    const filter = createRunEventFilter('run-active-1')

    const matching = normalizeAcpMessageChunk({ text: 'valid' }, { runId: 'run-active-1' })
    const stale = normalizeAcpMessageChunk({ text: 'late' }, { runId: 'run-old-0' })

    expect(filter.accept(matching)).toBe(true)
    expect(filter.accept(stale)).toBe(false)
  })

  it('suppresses duplicate terminal completion events and late events', () => {
    const filter = createRunEventFilter('run-active-1')

    const firstMsg = normalizeAcpMessageChunk({ text: 'working' }, { runId: 'run-active-1' })
    expect(filter.accept(firstMsg)).toBe(true)

    const firstDone = normalizeAcpPromptDone({ stopReason: 'end_turn' }, { runId: 'run-active-1' })
    expect(filter.accept(firstDone)).toBe(true)

    // Second terminal event MUST be rejected
    const secondDone = normalizeAcpPromptDone({ stopReason: 'cancelled' }, { runId: 'run-active-1' })
    expect(filter.accept(secondDone)).toBe(false)

    // Any late text chunk after completion MUST be rejected
    const lateMsg = normalizeAcpMessageChunk({ text: 'trailing text' }, { runId: 'run-active-1' })
    expect(filter.accept(lateMsg)).toBe(false)
  })

  it('unwraps nested update object from raw params', () => {
    const rawParams = {
      sessionId: 'session-acp-456',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Unwrapped message' },
      },
    }

    const events = normalizeAcpSessionUpdate(rawParams, testContext)
    expect(events).toEqual([
      {
        type: 'text_delta',
        text: 'Unwrapped message',
        runId: 'run-test-123',
        backend: 'cline-acp',
        sessionId: 'session-acp-456',
      },
    ])
  })

  it('allows error followed by done to complete the run in the UI, rejecting duplicate errors and late events', () => {
    const filter = createRunEventFilter('run-err-1')

    const errorEvent = {
      type: 'error' as const,
      message: 'Fatal process error',
      runId: 'run-err-1',
    }
    const doneEvent = {
      type: 'done' as const,
      success: false,
      error: 'Fatal process error',
      runId: 'run-err-1',
    }

    // First error accepted
    expect(filter.accept(errorEvent)).toBe(true)

    // Duplicate error rejected
    expect(filter.accept(errorEvent)).toBe(false)

    // Follow-up done event accepted so finishAgentRun is invoked
    expect(filter.accept(doneEvent)).toBe(true)

    // Events after done are rejected
    expect(filter.accept(errorEvent)).toBe(false)
    expect(filter.accept(doneEvent)).toBe(false)
  })

  it('normalizes permission_request with offered options, title, and toolCallId', () => {
    const rawPermission = {
      type: 'permission_request',
      sessionId: 'session-acp-456',
      requestId: 'req-perm-1',
      toolCall: {
        toolCallId: 'tool-call-777',
        title: 'Modify src-tauri/src/lib.rs',
        kind: 'edit',
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow' },
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
      ],
    }

    const events = normalizeAcpSessionUpdate(rawPermission, testContext)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'permission_request',
      runId: 'run-test-123',
      sessionId: 'session-acp-456',
      backend: 'cline-acp',
      requestId: 'req-perm-1',
      toolCallId: 'tool-call-777',
      title: 'Modify src-tauri/src/lib.rs',
      kind: 'edit',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow' },
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
      ],
    })
  })
})
