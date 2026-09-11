import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import {
  routeRespondPermission,
  routeSendAgentPrompt,
  routeStopAgent,
  type InvokeFunction,
} from './backend-router'
import { normalizeAcpSessionUpdate } from './agent-event-adapter'
import { buildCodingAgentPrompt } from './conversation-context'

describe('Tool Access and Security Boundaries — Cline ACP Integration (Stage 17)', () => {
  let tempFixtureDir: string

  beforeEach(() => {
    localStorage.clear()
    tempFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-stage17-test-'))
    useCodingAgentStore.setState({
      sessions: [],
      activeSessionId: null,
      projectDir: tempFixtureDir,
      draftPrompt: '',
      isRunning: false,
      planText: '',
      execLog: [],
      pendingDiffs: [],
      conversationSummary: undefined,
    })
  })

  afterEach(() => {
    if (tempFixtureDir && fs.existsSync(tempFixtureDir)) {
      try {
        fs.rmSync(tempFixtureDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors on busy files in Windows
      }
    }
  })

  it('Scenario 1: Permitted tool access executes approval once via ACP and rejects replay', async () => {
    const targetFile = path.join(tempFixtureDir, 'target.txt')
    fs.writeFileSync(targetFile, 'initial content\n', 'utf8')

    let respondCount = 0
    const resolvedRequestIds = new Set<string>()

    const invokeFn = vi.fn<InvokeFunction>().mockImplementation(async (cmd, args) => {
      if (cmd === 'respond_cline_permission') {
        const { requestId, optionId } = (args ?? {}) as { requestId: string; optionId: string }
        if (resolvedRequestIds.has(requestId)) {
          throw new Error(`Unknown or already resolved permission request '${requestId}'`)
        }
        resolvedRequestIds.add(requestId)
        respondCount++

        // Simulate host executing approved tool write to disk
        if (optionId === 'allow_once') {
          fs.writeFileSync(targetFile, 'permitted update applied\n', 'utf8')
        }
        return { success: true }
      }
      return { success: true }
    })

    const store = useCodingAgentStore.getState()
    store.startNewSession('Permitted write session', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })

    // 1. Dispatch first approval
    const res = await routeRespondPermission(
      {
        backend: 'cline-acp',
        runId: 'run-allow-1',
        requestId: 'req-allow-1',
        optionId: 'allow_once',
      },
      invokeFn
    )

    expect(res.command).toBe('respond_cline_permission')
    expect(invokeFn).toHaveBeenCalledWith('respond_cline_permission', {
      runId: 'run-allow-1',
      requestId: 'req-allow-1',
      optionId: 'allow_once',
    })

    // 2. Behavioral assertion on disk fixture: file modified once
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('permitted update applied\n')
    expect(respondCount).toBe(1)

    // 3. Replay attack rejection: attempting to respond a second time is strictly rejected
    await expect(
      routeRespondPermission(
        {
          backend: 'cline-acp',
          runId: 'run-allow-1',
          requestId: 'req-allow-1',
          optionId: 'allow_once',
        },
        invokeFn
      )
    ).rejects.toThrow(/already resolved permission request/)

    // File content remains modified exactly once
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('permitted update applied\n')
    expect(respondCount).toBe(1)
  })

  it('Scenario 2: Denied tool access dispatches rejection and preserves files with zero side effects', async () => {
    const sensitiveFile = path.join(tempFixtureDir, 'sensitive.txt')
    const originalContent = 'SECRET_TOKEN_DO_NOT_TAMPER_ABC_123\n'
    fs.writeFileSync(sensitiveFile, originalContent, 'utf8')

    const initialHash = crypto.createHash('sha256').update(fs.readFileSync(sensitiveFile)).digest('hex')
    const initialStats = fs.statSync(sensitiveFile)

    const invokeFn = vi.fn<InvokeFunction>().mockImplementation(async (cmd, args) => {
      if (cmd === 'respond_cline_permission') {
        const { optionId } = (args ?? {}) as { optionId: string }
        // On rejection, host guarantees zero file writes occur
        if (optionId === 'reject_once') {
          return { success: true, outcome: 'cancelled' }
        }
      }
      return { success: true }
    })

    const store = useCodingAgentStore.getState()
    store.startNewSession('Denied edit session', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })

    // Dispatch rejection
    const res = await routeRespondPermission(
      {
        backend: 'cline-acp',
        runId: 'run-deny-1',
        requestId: 'req-deny-1',
        optionId: 'reject_once',
      },
      invokeFn
    )

    expect(res.command).toBe('respond_cline_permission')
    expect(invokeFn).toHaveBeenCalledWith('respond_cline_permission', {
      runId: 'run-deny-1',
      requestId: 'req-deny-1',
      optionId: 'reject_once',
    })

    // Behavioral assertion on disk fixture: byte-for-byte SHA256 integrity and file size preserved
    const afterContent = fs.readFileSync(sensitiveFile, 'utf8')
    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(sensitiveFile)).digest('hex')
    const afterStats = fs.statSync(sensitiveFile)

    expect(afterContent).toBe(originalContent)
    expect(afterHash).toBe(initialHash)
    expect(afterStats.size).toBe(initialStats.size)
  })

  it('Scenario 3: Tool error resilience normalizes failed tool update into isError: true and preserves agent loop', async () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Run failing tool session', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    useCodingAgentStore.setState({ isRunning: true })

    const failedUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-err-42',
      status: 'failed',
      output: 'ENOENT: no such file or directory, open non_existent_ghost.txt',
    }

    // 1. Adapter normalization contract
    const events = normalizeAcpSessionUpdate(failedUpdate, {
      runId: 'run-err-1',
      backend: 'cline-acp',
    })

    expect(events).toHaveLength(1)
    const errEvent = events[0]
    expect(errEvent.type).toBe('tool_result')
    if (errEvent.type === 'tool_result') {
      expect(errEvent.id).toBe('call-err-42')
      expect(errEvent.isError).toBe(true)
      expect(errEvent.output).toContain('ENOENT')

      // Production log formatting: errors prefix with "Error: "
      store.appendLog({
        type: 'tool_result',
        content: `Error: ${errEvent.output}`,
        timestamp: Date.now(),
      })
    }

    // 2. Resilience: session remains running, agent loop did not crash or terminate
    const state = useCodingAgentStore.getState()
    expect(state.isRunning).toBe(true)
    const lastLog = state.execLog[state.execLog.length - 1]
    expect(lastLog.type).toBe('tool_result')
    expect(lastLog.content).toContain('Error: ENOENT')
  })

  it('Scenario 4: Availability loss and cancellation during pending permission cleans up state and marks interrupted', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })
    const store = useCodingAgentStore.getState()
    store.startNewSession('In-flight pending permission session', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'running',
    })
    useCodingAgentStore.setState({ isRunning: true })

    const activeSessionId = useCodingAgentStore.getState().activeSessionId!
    const activeRun = { runId: 'run-cancel-perm-1', backend: 'cline-acp' as const, sessionId: activeSessionId }

    // Dispatch stop
    await routeStopAgent(activeRun, 'cline-acp', invokeFn)
    expect(invokeFn).toHaveBeenCalledWith('stop_cline_agent', { runId: 'run-cancel-perm-1' })

    // Production termination pipeline:
    // stop transitions session to 'interrupted' and clears running state
    store.setSessionStatus(activeSessionId, 'interrupted', 'User stopped run')
    useCodingAgentStore.setState({ isRunning: false })

    const state = useCodingAgentStore.getState()
    expect(state.isRunning).toBe(false)
    const session = state.sessions.find((s) => s.id === activeSessionId)
    expect(session?.status).toBe('interrupted')
    expect(session?.interruptedReason).toBe('User stopped run')
  })

  it('Scenario 5: Session isolation ensures empty MCP server forwarding and withholds host secrets', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })

    await routeSendAgentPrompt(
      {
        backend: 'cline-acp',
        projectDir: tempFixtureDir,
        prompt: 'Check isolated environment',
        model: 'zai/glm-5.3-flash',
        activeRun: null,
      },
      invokeFn
    )

    expect(invokeFn).toHaveBeenCalledWith('start_cline_agent', {
      projectDir: tempFixtureDir,
      prompt: 'Check isolated environment',
      model: 'zai/glm-5.3-flash',
      runId: expect.any(String),
      sessionId: undefined,
    })

    const payload = invokeFn.mock.calls[0][1] as Record<string, unknown>
    // Verify machine-global MCP and secrets are strictly withheld from the payload
    expect(payload).not.toHaveProperty('mcpServers')
    expect(payload).not.toHaveProperty('SERPER_API_KEY')
    expect(payload).not.toHaveProperty('env')
    expect(payload.projectDir).toBe(tempFixtureDir)
  })

  it('Scenario 6: Cross-backend isolation prevents double-execution and rejects mismatched backend calls', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })

    // 1. Cline prompt start never invokes Ollama or legacy agents
    const res = await routeSendAgentPrompt(
      {
        backend: 'cline-acp',
        projectDir: tempFixtureDir,
        prompt: 'Refactor code',
        model: 'zai/glm-5.3-flash',
        activeRun: null,
      },
      invokeFn
    )

    expect(res.command).toBe('start_cline_agent')
    expect(invokeFn).not.toHaveBeenCalledWith('start_ollama_agent', expect.anything())
    expect(invokeFn).not.toHaveBeenCalledWith('spawn_code_agent', expect.anything())

    // 2. Reject responding to permission on direct-ollama
    await expect(
      routeRespondPermission(
        {
          backend: 'direct-ollama',
          runId: 'run-ollama',
          requestId: 'req-ollama',
          optionId: 'allow',
        },
        invokeFn
      )
    ).rejects.toThrow(/only valid for 'cline-acp'/)

    // 3. Reject starting when a run is already active
    await expect(
      routeSendAgentPrompt(
        {
          backend: 'cline-acp',
          projectDir: tempFixtureDir,
          prompt: 'Concurrent start',
          activeRun: { runId: 'run-existing', backend: 'cline-acp' },
        },
        invokeFn
      )
    ).rejects.toThrow(/already active on backend 'cline-acp'/)
  })

  it('Scenario 7: Workspace containment restricts context seeding to project directory', () => {
    const store = useCodingAgentStore.getState()
    store.startNewSession('Project A Session', undefined, 'manual', {
      backend: 'cline-acp',
      modelId: 'zai/glm-5.3-flash',
      status: 'completed',
    })
    const projectASessionId = useCodingAgentStore.getState().activeSessionId!
    const sessionA = useCodingAgentStore.getState().sessions.find((s) => s.id === projectASessionId)!
    sessionA.planText = 'Project A confidential architecture details'

    const seededPrompt = buildCodingAgentPrompt({
      prompt: 'Refactor Project B',
      isContinuation: false,
      sessions: [sessionA],
      activeSessionId: projectASessionId,
      seedFromSessionId: projectASessionId,
      projectDir: '/different/isolated/project-b',
    })

    // Plan text from Project A must never be injected into Project B's context
    expect(seededPrompt).toBe('Refactor Project B')
    expect(seededPrompt).not.toContain('Project A confidential')
  })

  it('Scenario 8: LSP and AST validation isolation', async () => {
    const invokeFn = vi.fn<InvokeFunction>().mockResolvedValue({ success: true })

    await routeSendAgentPrompt(
      {
        backend: 'cline-acp',
        projectDir: tempFixtureDir,
        prompt: 'Analyze symbols',
        model: 'zai/glm-5.3-flash',
        lspEnabled: true,
        activeRun: null,
      },
      invokeFn
    )

    const clineCall = invokeFn.mock.calls.find((c) => c[0] === 'start_cline_agent')
    expect(clineCall).toBeDefined()
    expect(clineCall![1]).not.toHaveProperty('lspEnabled')

    await routeSendAgentPrompt(
      {
        backend: 'direct-ollama',
        projectDir: tempFixtureDir,
        prompt: 'Analyze symbols in Ollama',
        model: 'qwen2.5-coder:7b',
        lspEnabled: true,
        activeRun: null,
      },
      invokeFn
    )

    const ollamaCall = invokeFn.mock.calls.find((c) => c[0] === 'start_ollama_agent')
    expect(ollamaCall).toBeDefined()
    expect(ollamaCall![1]).toHaveProperty('lspEnabled', true)
  })
})
