import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LogLine, getTurnIndices } from './index'
import type { ExecLogLine } from '@/stores/coding-agent-store'

describe('CodingAgentPanel User Prompt Card and Actions', () => {
  it('renders user prompt in a card with copy, edit, and delete action buttons', () => {
    const line: ExecLogLine = {
      type: 'text_delta',
      content: '> write a quick sort in python',
      timestamp: 1700000000000,
    }

    const onEditPrompt = vi.fn()
    const onDeleteTurn = vi.fn()

    render(
      <LogLine
        line={line}
        onEditPrompt={onEditPrompt}
        onDeleteTurn={onDeleteTurn}
        isRunning={false}
      />
    )

    // Verify user prompt text is rendered without the leading '>'
    expect(screen.getByText('write a quick sort in python')).toBeInTheDocument()

    // Verify edit button is present with title
    const editBtn = screen.getByTitle('Edit prompt')
    expect(editBtn).toBeInTheDocument()

    // Verify card wrapper styling
    const promptElement = screen.getByText('write a quick sort in python')
    expect(promptElement.closest('.bg-secondary')).toBeInTheDocument()
  })

  it('hides edit and delete buttons when isRunning is true to prevent concurrent mutations', () => {
    const line: ExecLogLine = {
      type: 'text_delta',
      content: '> write a quick sort in python',
      timestamp: 1700000000000,
    }

    render(
      <LogLine
        line={line}
        onEditPrompt={vi.fn()}
        onDeleteTurn={vi.fn()}
        isRunning={true}
      />
    )

    expect(screen.getByText('write a quick sort in python')).toBeInTheDocument()
    expect(screen.queryByTitle('Edit prompt')).not.toBeInTheDocument()
  })

  it('renders metadata lines as subtle badges', () => {
    const line: ExecLogLine = {
      type: 'text_delta',
      content: 'Backend: cline-acp',
      timestamp: 1700000000001,
    }

    render(<LogLine line={line} />)

    expect(screen.getByText('Backend: cline-acp')).toBeInTheDocument()
    const badge = screen.getByText('Backend: cline-acp')
    expect(badge.className).toContain('rounded')
  })

  it('renders assistant response with Markdown', () => {
    const line: ExecLogLine = {
      type: 'text_delta',
      content: 'Here is your **QuickSort** function:\n\n```python\ndef quicksort(arr):\n    return arr\n```',
      timestamp: 1700000000005,
    }

    render(<LogLine line={line} />)

    // Bold text is rendered inside a strong tag
    expect(screen.getByText('QuickSort')).toBeInTheDocument()
  })

  describe('getTurnIndices helper', () => {
    it('identifies turn bounds for a single-turn log', () => {
      const execLog: ExecLogLine[] = [
        { type: 'text_delta', content: '> hi', timestamp: 100 },
        { type: 'text_delta', content: 'Backend: cline-acp', timestamp: 101 },
        { type: 'text_delta', content: 'Hello there!', timestamp: 102 },
        { type: 'done', content: '✓ AGENT FINISHED', timestamp: 103 },
      ]

      const indices = getTurnIndices(execLog, 100)
      expect(indices).toEqual({ startIndex: 0, endIndex: 4 })
    })

    it('identifies turn bounds for multi-turn conversations', () => {
      const execLog: ExecLogLine[] = [
        { type: 'text_delta', content: '> turn 1', timestamp: 100 },
        { type: 'text_delta', content: 'Answer 1', timestamp: 101 },
        { type: 'text_delta', content: '> turn 2', timestamp: 200 },
        { type: 'text_delta', content: 'Answer 2', timestamp: 201 },
        { type: 'text_delta', content: '> turn 3', timestamp: 300 },
        { type: 'text_delta', content: 'Answer 3', timestamp: 301 },
      ]

      expect(getTurnIndices(execLog, 100)).toEqual({ startIndex: 0, endIndex: 2 })
      expect(getTurnIndices(execLog, 200)).toEqual({ startIndex: 2, endIndex: 4 })
      expect(getTurnIndices(execLog, 300)).toEqual({ startIndex: 4, endIndex: 6 })
    })

    it('returns null if the prompt timestamp is not found', () => {
      const execLog: ExecLogLine[] = [
        { type: 'text_delta', content: '> turn 1', timestamp: 100 },
      ]

      expect(getTurnIndices(execLog, 999)).toBeNull()
    })
  })
})
