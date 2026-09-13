import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkThreadHeader } from './WorkThreadHeader'
import type { AIPathStep } from '@/stores/coding-agent-store'

const MOCK_AI_PATH: AIPathStep[] = [
  {
    modelId: 'zai/glm-5.3-flash',
    displayName: 'GLM 5.3 Flash',
    provider: 'Zhipu AI',
    timestamp: 1000,
  },
  {
    modelId: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    timestamp: 2000,
  },
]

describe('WorkThreadHeader', () => {
  it('renders Work Thread title, status, and AI path', () => {
    render(
      <WorkThreadHeader
        title="Fix authentication refresh bug"
        status="free"
        activeAiName="DeepSeek V4 Flash"
        connectionMethod="Cline ACP"
        aiPath={MOCK_AI_PATH}
        isRunning={false}
        isRightPanelOpen={true}
        onToggleRightPanel={vi.fn()}
        onOpenSwitchAi={vi.fn()}
      />
    )

    expect(screen.getByText('Fix authentication refresh bug')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('AI Path:')).toBeInTheDocument()
    expect(screen.getByText('GLM 5.3 Flash')).toBeInTheDocument()
    expect(screen.getAllByText('DeepSeek V4 Flash')).toHaveLength(2)
    expect(screen.getByText('Active:')).toBeInTheDocument()
    expect(screen.getByText('Cline ACP')).toBeInTheDocument()
  })

  it('calls onOpenSwitchAi when Switch AI button is clicked', () => {
    const onOpenSwitchAi = vi.fn()

    render(
      <WorkThreadHeader
        title="Refactor payment gateway"
        status="free"
        activeAiName="DeepSeek V4 Flash"
        connectionMethod="Cline ACP"
        isRunning={false}
        isRightPanelOpen={true}
        onToggleRightPanel={vi.fn()}
        onOpenSwitchAi={onOpenSwitchAi}
      />
    )

    const switchAiButton = screen.getByRole('button', { name: /Switch AI/i })
    fireEvent.click(switchAiButton)

    expect(onOpenSwitchAi).toHaveBeenCalledTimes(1)
  })

  it('opens progressive diagnostics menu and handles session actions', () => {
    const onCopyLog = vi.fn()
    const onClearSession = vi.fn()

    render(
      <WorkThreadHeader
        title="Investigate query performance"
        status="free"
        activeAiName="DeepSeek V4 Flash"
        connectionMethod="Cline ACP"
        isRunning={false}
        isRightPanelOpen={true}
        onToggleRightPanel={vi.fn()}
        onOpenSwitchAi={vi.fn()}
        onCopyLog={onCopyLog}
        onClearSession={onClearSession}
        hasLogs={true}
      />
    )

    // Initially diagnostics menu is closed
    expect(screen.queryByText('Copy Turn Log')).not.toBeInTheDocument()

    // Click diagnostics toggle button
    const toggleButton = screen.getByTitle('Diagnostics & Session Tools')
    fireEvent.click(toggleButton)

    // Now diagnostics tools are visible
    expect(screen.getByText('Copy Turn Log')).toBeInTheDocument()
    expect(screen.getByText('Clear Current Session')).toBeInTheDocument()

    // Click copy log
    fireEvent.click(screen.getByText('Copy Turn Log'))
    expect(onCopyLog).toHaveBeenCalledTimes(1)

    // Click clear session
    fireEvent.click(screen.getByText('Clear Current Session'))
    expect(onClearSession).toHaveBeenCalledTimes(1)
  })
})
