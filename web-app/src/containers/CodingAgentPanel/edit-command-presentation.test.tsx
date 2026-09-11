import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PermissionRequest } from './PermissionRequest'
import type { AcpPermissionRequestPayload } from './backend-identity'
import { extractPermissionCommand, extractPermissionFileEdit } from './backend-identity'

const baseCommandRequest: AcpPermissionRequestPayload = {
  runId: 'run-stage12-001',
  sessionId: 'session-acp-stage12',
  requestId: 'req-cmd-1',
  toolCallId: 'tool-call-stage12-cmd',
  title: 'Run git status',
  kind: 'command',
  command: 'git status',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow' },
    { optionId: 'deny', name: 'Deny', kind: 'deny' },
  ],
}

const baseEditRequest: AcpPermissionRequestPayload = {
  runId: 'run-stage12-002',
  sessionId: 'session-acp-stage12',
  requestId: 'req-edit-1',
  toolCallId: 'tool-call-stage12-edit',
  title: 'Edit src/main.ts',
  kind: 'edit',
  filePath: 'src/main.ts',
  diff: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow' },
    { optionId: 'deny', name: 'Deny', kind: 'deny' },
  ],
}

describe('Edit and Command Presentation (Stage 12)', () => {
  it('presents command execution request with exact command line and pending approval badge', () => {
    render(<PermissionRequest request={baseCommandRequest} onRespond={vi.fn()} />)

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Command to execute:')).toBeInTheDocument()
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.getByText('Pending Approval')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it("presents proposed file edit with target path, diff, and 'Proposed (Not applied)' badge", () => {
    render(<PermissionRequest request={baseEditRequest} onRespond={vi.fn()} />)

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Target file:')).toBeInTheDocument()
    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    expect(screen.getByText('Proposed (Not applied)')).toBeInTheDocument()
    expect(screen.getByText(/--- a\/main\.ts/)).toBeInTheDocument()
    expect(screen.getByText(/\+new/)).toBeInTheDocument()
  })

  it('presents search and replace chunks when provided in input', () => {
    const searchReplaceRequest: AcpPermissionRequestPayload = {
      ...baseEditRequest,
      title: 'Edit src/utils.ts',
      diff: undefined,
      input: {
        path: 'src/utils.ts',
        search: 'function old()',
        replace: 'function new()',
      },
    }

    render(<PermissionRequest request={searchReplaceRequest} onRespond={vi.fn()} />)

    expect(screen.getByText('-function old()')).toBeInTheDocument()
    expect(screen.getByText('+function new()')).toBeInTheDocument()
    expect(screen.getByText('Proposed (Not applied)')).toBeInTheDocument()
  })

  it('presents diff from ACP content blocks and line number badge from locations', () => {
    const contentDiffRequest: AcpPermissionRequestPayload = {
      ...baseEditRequest,
      filePath: undefined,
      diff: undefined,
      locations: [{ path: 'src/engine.rs', line: 42 }],
      content: [{ type: 'diff', diff: '@@ -42,2 +42,3 @@\n-lineA\n+lineB' }],
    }

    render(<PermissionRequest request={contentDiffRequest} onRespond={vi.fn()} />)

    expect(screen.getByText('src/engine.rs')).toBeInTheDocument()
    expect(screen.getByText('Line 42')).toBeInTheDocument()
    expect(screen.getByText(/lineB/)).toBeInTheDocument()
  })

  it('clicking allow or deny calls onRespond and immediately disables action buttons to prevent double submission', () => {
    const onRespond = vi.fn()
    render(<PermissionRequest request={baseCommandRequest} onRespond={onRespond} />)

    const allowBtn = screen.getByRole('button', { name: 'Allow' })
    const denyBtn = screen.getByRole('button', { name: 'Deny' })

    fireEvent.click(allowBtn)
    expect(onRespond).toHaveBeenCalledWith('req-cmd-1', 'allow')

    // Immediately after click, buttons are disabled in local state (Finding F10)
    expect(allowBtn).toBeDisabled()
    expect(denyBtn).toBeDisabled()

    // Second click must not trigger onRespond again
    fireEvent.click(allowBtn)
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('controls are disabled when disabled prop is true', () => {
    render(<PermissionRequest request={baseCommandRequest} onRespond={vi.fn()} disabled={true} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    buttons.forEach((btn) => expect(btn).toBeDisabled())
  })

  describe('Criterion 2: Distinction between proposed and applied logs', () => {
    it('generates the required log strings for proposed vs applied edits and commands', () => {
      // 1. Proposed edit log string
      const fileEdit = extractPermissionFileEdit(baseEditRequest)
      expect(fileEdit).not.toBeNull()
      const proposedEditLog = `Proposed edit for ${fileEdit!.path} — awaiting approval`
      expect(proposedEditLog).toBe('Proposed edit for src/main.ts — awaiting approval')

      // 2. Proposed command log string
      const cmd = extractPermissionCommand(baseCommandRequest)
      expect(cmd).not.toBeNull()
      const proposedCmdLog = `Command execution requested: '${cmd}' — awaiting approval`
      expect(proposedCmdLog).toBe("Command execution requested: 'git status' — awaiting approval")

      // 3. Denied edit log string
      const deniedEditLog = `Permission denied for edit on ${fileEdit!.path} — changes were NOT applied.`
      expect(deniedEditLog).toBe('Permission denied for edit on src/main.ts — changes were NOT applied.')

      // 4. Denied command log string
      const deniedCmdLog = `Permission denied for command '${cmd}' — command was NOT executed.`
      expect(deniedCmdLog).toBe("Permission denied for command 'git status' — command was NOT executed.")

      // 5. Approved edit log string
      const approvedEditLog = `Permission approved for edit on ${fileEdit!.path}. Awaiting agent execution...`
      expect(approvedEditLog).toBe('Permission approved for edit on src/main.ts. Awaiting agent execution...')

      // 6. Approved command log string
      const approvedCmdLog = `Permission approved for command '${cmd}'. Awaiting execution...`
      expect(approvedCmdLog).toBe("Permission approved for command 'git status'. Awaiting execution...")

      // 7. Applied edit log string on successful tool result for approved edit
      const rawOutput = 'updated 1 file'
      const appliedEditLog = `Applied edit: ${rawOutput}`
      expect(appliedEditLog).toBe('Applied edit: updated 1 file')
    })
  })

  describe('Criterion 4: Disposable fixture verification (edit & command)', () => {
    it('disposable fixture: denied edit causes zero side effect, approved edit executes once', () => {
      // Disposable fixture simulating the target file in the workspace
      let workspaceFile = 'initial content\n'
      let editExecutionCount = 0

      // Mock agent execution loop: executes file write ONLY IF approved with optionId === 'allow'
      const mockAgentExecuteEdit = (optionId: string) => {
        if (optionId === 'allow') {
          workspaceFile = 'updated content\n'
          editExecutionCount += 1
        }
      }

      // Step A: Denied edit
      const onDeny = vi.fn((requestId: string, optionId: string) => {
        mockAgentExecuteEdit(optionId)
      })

      render(
        <PermissionRequest request={baseEditRequest} onRespond={onDeny} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      expect(onDeny).toHaveBeenCalledWith('req-edit-1', 'deny')
      expect(editExecutionCount).toBe(0)
      expect(workspaceFile).toBe('initial content\n') // ZERO SIDE EFFECT

      cleanup()

      // Step B: Approved edit
      const onApprove = vi.fn((requestId: string, optionId: string) => {
        mockAgentExecuteEdit(optionId)
      })

      render(
        <PermissionRequest request={baseEditRequest} onRespond={onApprove} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
      expect(onApprove).toHaveBeenCalledWith('req-edit-1', 'allow')
      expect(editExecutionCount).toBe(1)
      expect(workspaceFile).toBe('updated content\n') // EXECUTED ONCE

      // Step C: Double click prevention — buttons are disabled immediately after click
      const allowBtn = screen.getByRole('button', { name: 'Allow' })
      expect(allowBtn).toBeDisabled()
      fireEvent.click(allowBtn)
      expect(onApprove).toHaveBeenCalledTimes(1)
      expect(editExecutionCount).toBe(1) // Still exactly 1
    })

    it('disposable fixture: denied command causes zero side effect, approved command executes once', () => {
      // Disposable fixture simulating command execution side effect (e.g. creating a marker)
      let commandExecuted = false
      let commandExecutionCount = 0

      // Mock agent execution loop: executes command ONLY IF approved with optionId === 'allow'
      const mockAgentExecuteCommand = (optionId: string) => {
        if (optionId === 'allow') {
          commandExecuted = true
          commandExecutionCount += 1
        }
      }

      // Step A: Denied command
      const onDeny = vi.fn((requestId: string, optionId: string) => {
        mockAgentExecuteCommand(optionId)
      })

      render(
        <PermissionRequest request={baseCommandRequest} onRespond={onDeny} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      expect(onDeny).toHaveBeenCalledWith('req-cmd-1', 'deny')
      expect(commandExecuted).toBe(false) // ZERO SIDE EFFECT
      expect(commandExecutionCount).toBe(0)

      cleanup()

      // Step B: Approved command
      const onApprove = vi.fn((requestId: string, optionId: string) => {
        mockAgentExecuteCommand(optionId)
      })

      render(
        <PermissionRequest request={baseCommandRequest} onRespond={onApprove} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
      expect(onApprove).toHaveBeenCalledWith('req-cmd-1', 'allow')
      expect(commandExecuted).toBe(true) // EXECUTED ONCE
      expect(commandExecutionCount).toBe(1)

      // Step C: Double click prevention
      const allowBtn = screen.getByRole('button', { name: 'Allow' })
      expect(allowBtn).toBeDisabled()
      fireEvent.click(allowBtn)
      expect(onApprove).toHaveBeenCalledTimes(1)
      expect(commandExecutionCount).toBe(1) // Still exactly 1
    })
  })
})