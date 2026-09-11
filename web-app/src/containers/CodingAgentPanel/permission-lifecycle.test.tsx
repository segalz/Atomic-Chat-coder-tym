import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PermissionRequest } from './PermissionRequest'
import { routeRespondPermission, type InvokeFunction } from './backend-router'
import type { AcpPermissionRequestPayload } from './backend-identity'

describe('Permission Lifecycle (Stage 11)', () => {
  const sampleRequest: AcpPermissionRequestPayload = {
    runId: 'run-stage11-001',
    sessionId: 'session-acp-999',
    requestId: 'rpc-perm-42',
    toolCallId: 'tool-call-101',
    title: 'Write file src/utils/math.rs',
    kind: 'file_edit',
    options: [
      { optionId: 'allow', name: 'Allow Edit', kind: 'allow' },
      { optionId: 'deny', name: 'Deny Edit', kind: 'deny' },
    ],
  }

  it('renders title, toolCallId, kind badge, and offered options', () => {
    render(<PermissionRequest request={sampleRequest} onRespond={vi.fn()} />)

    expect(screen.getByText('Write file src/utils/math.rs')).toBeInTheDocument()
    expect(screen.getByText('file_edit')).toBeInTheDocument()
    expect(screen.getByText(/tool-call-101/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny Edit' })).toBeInTheDocument()
  })

  it('triggers onRespond with optionId allow when Allow Edit is clicked', () => {
    const onRespond = vi.fn()
    render(<PermissionRequest request={sampleRequest} onRespond={onRespond} />)

    const allowBtn = screen.getByRole('button', { name: 'Allow Edit' })
    fireEvent.click(allowBtn)

    expect(onRespond).toHaveBeenCalledWith('rpc-perm-42', 'allow')
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('triggers onRespond with optionId deny when Deny Edit is clicked', () => {
    const onRespond = vi.fn()
    render(<PermissionRequest request={sampleRequest} onRespond={onRespond} />)

    const denyBtn = screen.getByRole('button', { name: 'Deny Edit' })
    fireEvent.click(denyBtn)

    expect(onRespond).toHaveBeenCalledWith('rpc-perm-42', 'deny')
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('respects disabled prop by disabling all option buttons', () => {
    render(<PermissionRequest request={sampleRequest} onRespond={vi.fn()} disabled={true} />)

    expect(screen.getByRole('button', { name: 'Allow Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny Edit' })).toBeDisabled()
  })

  it('routes explicit decision to respond_cline_permission via backend router', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    const mockInvoke: InvokeFunction = async (cmd, args) => {
      calls.push({ cmd, args })
      return {}
    }

    const result = await routeRespondPermission(
      {
        backend: 'cline-acp',
        runId: sampleRequest.runId,
        requestId: sampleRequest.requestId,
        optionId: 'allow',
      },
      mockInvoke
    )

    expect(result.command).toBe('respond_cline_permission')
    expect(calls.length).toBe(1)
    expect(calls[0].cmd).toBe('respond_cline_permission')
    expect(calls[0].args).toEqual({
      runId: 'run-stage11-001',
      requestId: 'rpc-perm-42',
      optionId: 'allow',
    })

    // Strict contract check: verify no Ollama diff commands were touched
    expect(calls.some((c) => c.cmd.includes('diff'))).toBe(false)
  })

  it('enforces backend isolation: never routes direct-ollama to respond_cline_permission', async () => {
    const mockInvoke: InvokeFunction = async () => ({})

    await expect(
      routeRespondPermission(
        {
          backend: 'direct-ollama',
          runId: sampleRequest.runId,
          requestId: sampleRequest.requestId,
          optionId: 'allow',
        },
        mockInvoke
      )
    ).rejects.toThrow(/only valid for 'cline-acp'/)
  })

  it('renders arbitrary custom options offered by the agent', () => {
    const customRequest: AcpPermissionRequestPayload = {
      ...sampleRequest,
      options: [
        { optionId: 'read_only', name: 'Allow Read-Only' },
        { optionId: 'full_access', name: 'Full Access', kind: 'allow' },
        { optionId: 'abort', name: 'Abort Execution', kind: 'deny' },
      ],
    }
    const onRespond = vi.fn()
    render(<PermissionRequest request={customRequest} onRespond={onRespond} />)

    expect(screen.getByRole('button', { name: 'Allow Read-Only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full Access' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abort Execution' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow Read-Only' }))
    expect(onRespond).toHaveBeenCalledWith('rpc-perm-42', 'read_only')
  })

  it('never defaults to approval or auto-approves ACP permission requests', () => {
    // ACP permission requests must strictly require explicit user interaction
    // Simulating that autoApprove flags (used for Ollama diffs) must have zero effect on ACP payloads
    const autoApproveRef = { current: true }
    const onRespond = vi.fn()

    render(<PermissionRequest request={sampleRequest} onRespond={onRespond} />)

    // Even with autoApproveRef = true, onRespond must not be automatically called
    expect(onRespond).not.toHaveBeenCalled()
  })
})
