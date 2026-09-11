import { describe, expect, it, vi } from 'vitest'
import {
  createRunEventFilter,
  normalizeAcpSessionUpdate,
} from './agent-event-adapter'
import {
  isOllamaHealthCheckRequired,
  isOllamaRestartRequired,
  isSendBlockedByOllamaError,
  routeRespondPermission,
  routeSendAgentPrompt,
  routeStopAgent,
  type ActiveRun,
  type InvokeFunction,
} from './backend-router'
import {
  evaluateLoopTurn,
  formatLoopTerminalMessage,
  isManualContextIsolatedFromLoop,
  isPermissionAutoApprovalAllowed,
  stopLoopExecution,
  validateLoopConcurrency,
  validateLoopPermissionProcessing,
} from './loop-lifecycle'
import {
  validateContinuationSafety,
  type LoopCheckpointData,
} from './loop-continuation'
import { migrateCodingAgentState } from '@/stores/coding-agent-store'

describe('Adversarial Lifecycle and Regression Verification (Stage 20)', () => {
  // ── Scenario 1: Missing CLI / executable not found (spawn failure) ──────
  describe('Scenario 1: Missing CLI / executable not found', () => {
    it('handles spawn failure gracefully when cline executable is missing or unexecutable', async () => {
      const mockInvoke: InvokeFunction = async (cmd) => {
        if (cmd === 'start_cline_agent') {
          throw new Error('Failed to spawn cline.cmd: program not found or access denied')
        }
        return {}
      }

      await expect(
        routeSendAgentPrompt(
          {
            backend: 'cline-acp',
            projectDir: '/test/workspace',
            prompt: 'Test prompt',
            model: 'zai/glm-5.3-flash',
            sessionId: 'session-fail-1',
            activeRun: null,
          },
          mockInvoke
        )
      ).rejects.toThrow('Failed to spawn cline.cmd: program not found or access denied')
    })
  })

  // ── Scenario 2: Missing auth / ACP handshake rejection ──────────────────
  describe('Scenario 2: Missing auth / ACP handshake rejection', () => {
    it('propagates ACP handshake or authentication rejection cleanly without hanging', async () => {
      const mockInvoke: InvokeFunction = async (cmd) => {
        if (cmd === 'start_cline_agent') {
          throw new Error('ACP initialization handshake rejected: code -32000 (Authentication token missing or expired)')
        }
        return {}
      }

      await expect(
        routeSendAgentPrompt(
          {
            backend: 'cline-acp',
            projectDir: '/test/workspace',
            prompt: 'Test prompt',
            model: 'zai/glm-5.3-flash',
            sessionId: 'session-auth-err',
            activeRun: null,
          },
          mockInvoke
        )
      ).rejects.toThrow(/ACP initialization handshake rejected/)
    })
  })

  // ── Scenario 3: Malformed stream JSON and truncated chunks ──────────────
  describe('Scenario 3: Malformed stream JSON and truncated chunks', () => {
    const testContext = {
      runId: 'run-malformed-1',
      backend: 'cline-acp' as const,
      sessionId: 'sess-malformed-1',
    }

    it('suppresses or safely ignores malformed, partial, or unrecognized session update chunks', () => {
      // 1. null / undefined update
      expect(normalizeAcpSessionUpdate(null, testContext)).toEqual([])
      expect(normalizeAcpSessionUpdate(undefined, testContext)).toEqual([])

      // 2. Unknown or corrupted event type
      expect(normalizeAcpSessionUpdate({ type: 'corrupted_random_event', foo: 123 }, testContext)).toEqual([])

      // 3. Message chunk with null / non-text content
      expect(normalizeAcpSessionUpdate({ type: 'agent_message_chunk', content: null }, testContext)).toEqual([])
      expect(normalizeAcpSessionUpdate({ type: 'agent_message_chunk', content: { type: 'binary', data: '1010' } }, testContext)).toEqual([])

      // 4. Thought chunk with missing text
      expect(normalizeAcpSessionUpdate({ type: 'agent_thought_chunk', content: {} }, testContext)).toEqual([])

      // 5. Tool call with missing toolCallId or toolName
      expect(normalizeAcpSessionUpdate({ type: 'tool_call', toolCallId: '', toolName: '' }, testContext)).toEqual([])

      // 6. Metadata events (session_info_update, mode_update) must be suppressed from chat stream
      expect(normalizeAcpSessionUpdate({ type: 'session_info_update', title: 'New Title' }, testContext)).toEqual([])
      expect(normalizeAcpSessionUpdate({ type: 'mode_update', mode: 'code' }, testContext)).toEqual([])
    })
  })

  // ── Scenario 4: Abrupt process disconnect / crash mid-stream ────────────
  describe('Scenario 4: Abrupt process disconnect / crash during streaming', () => {
    it('forwards abrupt process exit error and prevents late phantom chunks', () => {
      const filter = createRunEventFilter('run-crash-test')

      // First chunk succeeds
      const chunkAccepted = filter.accept({
        type: 'text_delta',
        text: 'Working on solution...',
        runId: 'run-crash-test',
        backend: 'cline-acp',
      })
      expect(chunkAccepted).toBe(true)

      // Process dies abruptly with error event
      const crashAccepted = filter.accept({
        type: 'error',
        error: 'Process terminated abruptly: SIGKILL or unexpected exit code 1',
        runId: 'run-crash-test',
        backend: 'cline-acp',
      })
      expect(crashAccepted).toBe(true)

      // Terminal done is accepted to unfreeze and finalize the run
      const doneAccepted = filter.accept({
        type: 'done',
        runId: 'run-crash-test',
        backend: 'cline-acp',
      })
      expect(doneAccepted).toBe(true)

      // Subsequent duplicate error or trailing phantom chunks must be suppressed
      const phantomAccepted = filter.accept({
        type: 'text_delta',
        text: 'phantom chunk after crash',
        runId: 'run-crash-test',
        backend: 'cline-acp',
      })
      expect(phantomAccepted).toBe(false)

      const dupErrorAccepted = filter.accept({
        type: 'error',
        error: 'duplicate error',
        runId: 'run-crash-test',
        backend: 'cline-acp',
      })
      expect(dupErrorAccepted).toBe(false)
    })
  })

  // ── Scenario 5: Orphaned / pending permissions on disconnect ────────────
  describe('Scenario 5: Orphaned / pending permissions on disconnect', () => {
    it('strictly isolates permission responses to cline-acp and rejects direct-ollama', async () => {
      const mockInvoke: InvokeFunction = async () => ({})

      // Must reject direct-ollama
      await expect(
        routeRespondPermission(
          {
            backend: 'direct-ollama',
            runId: 'run-perm-1',
            requestId: 'req-perm-1',
            optionId: 'allow',
          },
          mockInvoke
        )
      ).rejects.toThrow(/routeRespondPermission is only valid for 'cline-acp'/)

      // For cline-acp, invokes respond_cline_permission
      const clineResult = await routeRespondPermission(
        {
          backend: 'cline-acp',
          runId: 'run-perm-2',
          requestId: 'req-perm-2',
          optionId: 'allow_once',
        },
        mockInvoke
      )
      expect(clineResult.command).toBe('respond_cline_permission')
      expect(clineResult.backend).toBe('cline-acp')
    })

    it('enforces that permission auto-approval is NEVER allowed for cline-acp under any circumstances', () => {
      expect(isPermissionAutoApprovalAllowed('cline-acp', 'manual')).toBe(false)
      expect(isPermissionAutoApprovalAllowed('cline-acp', 'loop')).toBe(false)
    })

    it('fails closed when attempting to respond to permission after run terminates or activeRun is cleared', async () => {
      const mockInvoke = vi.fn<InvokeFunction>().mockResolvedValue({})

      // 1. activeRun is null (run has terminated or stopped)
      await expect(
        routeRespondPermission(
          {
            backend: 'cline-acp',
            runId: 'run-dead-1',
            requestId: 'req-dead-1',
            optionId: 'allow_once',
            activeRun: null,
          },
          mockInvoke
        )
      ).rejects.toThrow(/Cannot respond to permission: active run is no longer active/)

      // 2. activeRun has mismatched runId (different run)
      await expect(
        routeRespondPermission(
          {
            backend: 'cline-acp',
            runId: 'run-stale-1',
            requestId: 'req-dead-2',
            optionId: 'allow_once',
            activeRun: { runId: 'run-active-other', backend: 'cline-acp' },
          },
          mockInvoke
        )
      ).rejects.toThrow(/Cannot respond to permission: runId mismatch/)

      // Verify invoke was NEVER dispatched to dead or mismatched runs
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('strictly rejects permission processing across non-running Loop phases and mismatched runId', () => {
      const activeRun: ActiveRun = { runId: 'run-loop-valid', backend: 'cline-acp' }

      // 1. Inactive phases
      expect(validateLoopPermissionProcessing('countdown', activeRun, 'run-loop-valid').allowed).toBe(false)
      expect(validateLoopPermissionProcessing('completed', activeRun, 'run-loop-valid').allowed).toBe(false)
      expect(validateLoopPermissionProcessing('halted', activeRun, 'run-loop-valid').allowed).toBe(false)
      expect(validateLoopPermissionProcessing('interrupted', activeRun, 'run-loop-valid').allowed).toBe(false)
      expect(validateLoopPermissionProcessing('idle', activeRun, 'run-loop-valid').allowed).toBe(false)

      // 2. Missing or mismatched activeRun
      expect(validateLoopPermissionProcessing('running', null, 'run-loop-valid').allowed).toBe(false)
      expect(validateLoopPermissionProcessing('running', activeRun, 'run-mismatched').allowed).toBe(false)

      // 3. Only allowed when running and runId matches
      const valid = validateLoopPermissionProcessing('running', activeRun, 'run-loop-valid')
      expect(valid.allowed).toBe(true)
      expect(valid.reason).toBe('Permission valid for active in-flight run.')
    })

    it('clears timers, stops backend, and marks session interrupted on stopLoopExecution', async () => {
      const mockInvoke = vi.fn<InvokeFunction>().mockResolvedValue({})
      const mockMarkInterrupted = vi.fn()
      const mockSetRunning = vi.fn()

      const timerHandle = {
        timeout: setTimeout(() => {}, 10000),
        interval: setInterval(() => {}, 10000),
      }

      const activeRun: ActiveRun = {
        runId: 'run-stop-test',
        backend: 'cline-acp',
        sessionId: 'sess-stop-test',
      }

      const res = await stopLoopExecution(
        {
          activeRun,
          selectedBackend: 'cline-acp',
          sessionId: 'sess-stop-test',
          timerHandle,
        },
        mockInvoke,
        {
          markSessionInterrupted: mockMarkInterrupted,
          setRunning: mockSetRunning,
        }
      )

      expect(res.stoppedCommand).toBe('stop_cline_agent')
      expect(res.targetBackend).toBe('cline-acp')
      expect(res.timerCleared).toBe(true)
      expect(res.sessionInterrupted).toBe(true)
      expect(mockMarkInterrupted).toHaveBeenCalledWith('sess-stop-test', 'User stopped run')
      expect(mockSetRunning).toHaveBeenCalledWith(false)
    })
  })

  // ── Scenario 6: Rapid project directory switch mid-execution ────────────
  describe('Scenario 6: Rapid project directory switch mid-execution & Loop safety', () => {
    it('detects directory drift in Loop continuation and halts with clear error', () => {
      const checkpoint: LoopCheckpointData = {
        loop_id: 'loop-drift-1',
        run_number: 1,
        max_runs: 3,
        project_dir: 'C:/projects/original-repo',
        current_goal: 'Refactor utils',
        current_stage: 'complete',
        completed_actions: ['read_file index.ts'],
        files_seen: ['index.ts'],
        files_changed: [],
        tool_results: [],
        known_findings: [],
        verification: [],
        next_action: 'Edit index.ts',
        do_not_repeat: [],
        risks: [],
      }

      // User changed active directory to a different folder
      const result = validateContinuationSafety({
        activeLoopId: 'loop-drift-1',
        currentRun: 2,
        maxRuns: 3,
        projectDir: 'C:/projects/other-repo-switched',
        targetBackend: 'cline-acp',
        checkpoint,
      })

      expect(result.safe).toBe(false)
      expect(result.error).toContain('Stale checkpoint projectDir mismatch')
      expect(result.error).toContain('C:/projects/original-repo')
      expect(result.error).toContain('C:/projects/other-repo-switched')
    })

    it('prevents starting a concurrent run when a project run is already active', () => {
      const activeRun: ActiveRun = {
        runId: 'run-active-1',
        backend: 'cline-acp',
        sessionId: 'sess-1',
      }

      expect(() => {
        validateLoopConcurrency(activeRun, 'cline-acp')
      }).toThrow(/Cannot start Loop iteration on 'cline-acp': an agent run is already active/)

      expect(() => {
        validateLoopConcurrency(activeRun, 'direct-ollama')
      }).toThrow(/Cannot start Loop iteration on 'direct-ollama': an agent run is already active/)
    })
  })

  // ── Scenario 7: Corrupt / invalid persisted history resilience ──────────
  describe('Scenario 7: Corrupt / invalid persisted history resilience', () => {
    it('safely recovers from malformed, null, or corrupted persisted state without crashing', () => {
      // 1. null or non-object state
      expect(migrateCodingAgentState(null)).toEqual({})
      expect(migrateCodingAgentState('corrupt string' as any)).toEqual({})

      // 2. Corrupt sessions array with nulls, invalid objects, and bad types
      const corruptPayload = {
        projectDir: 12345, // invalid type
        isRunning: true,   // crashed while running
        activeSessionId: 'sess-corrupt-1',
        sessions: [
          null,
          'not-a-session',
          {
            id: 'sess-corrupt-1',
            prompt: 12345, // non-string prompt
            source: 'invalid_source',
            backend: 'invalid_backend_enum',
            status: 'unknown_status',
            timestamp: 'not-a-timestamp',
            execLog: 'not-an-array',
            pendingDiffs: [null, { filePath: 42, status: 'invalid_status' }],
          },
        ],
      }

      const migrated = migrateCodingAgentState(corruptPayload)
      expect(migrated.sessions).toBeDefined()
      expect(migrated.sessions?.length).toBe(1)

      const recoveredSession = migrated.sessions![0]
      expect(recoveredSession.id).toBe('sess-corrupt-1')
      expect(recoveredSession.prompt).toBe('Session') // safe default fallback for non-string
      expect(recoveredSession.source).toBe('manual') // safe default
      expect(recoveredSession.backend).toBeUndefined() // filtered invalid backend
      expect(typeof recoveredSession.timestamp).toBe('number') // recovered timestamp
      expect(Array.isArray(recoveredSession.execLog)).toBe(true) // normalized to empty array
      expect(Array.isArray(recoveredSession.pendingDiffs)).toBe(true)
      // Was running when saved -> must be marked interrupted
      expect(recoveredSession.status).toBe('interrupted')
      expect(recoveredSession.interruptedReason).toBe('Application restarted while run was active')
    })
  })

  // ── Scenario 8: Adversarial concurrency flooding ────────────────────────
  describe('Scenario 8: Adversarial concurrency flooding', () => {
    it('strictly rejects concurrent execution requests across all backends', async () => {
      const mockInvoke = vi.fn<InvokeFunction>().mockResolvedValue({})
      const activeRun: ActiveRun = {
        runId: 'run-flood-owner',
        backend: 'cline-acp',
      }

      // Attempting to start another cline-acp run while active
      await expect(
        routeSendAgentPrompt(
          {
            backend: 'cline-acp',
            projectDir: '/test/workspace',
            prompt: 'Concurrent prompt 1',
            model: 'zai/glm-5.3-flash',
            sessionId: 'sess-flood-2',
            activeRun,
          },
          mockInvoke
        )
      ).rejects.toThrow(/An agent run is already active on backend 'cline-acp'/)

      // Attempting to start direct-ollama while cline-acp is active
      await expect(
        routeSendAgentPrompt(
          {
            backend: 'direct-ollama',
            projectDir: '/test/workspace',
            prompt: 'Concurrent prompt 2',
            model: 'qwen2.5-coder:7b',
            sessionId: 'sess-flood-3',
            activeRun,
          },
          mockInvoke
        )
      ).rejects.toThrow(/An agent run is already active on backend 'cline-acp'/)

      // Verify no invoke calls were dispatched
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  // ── Scenario 9: Adversarial Loop bounds & infinite loop defense ─────────
  describe('Scenario 9: Adversarial Loop bounds & infinite loop defense', () => {
    it('halts immediately when maxRuns or currentRun is invalid, negative, 0, or NaN', () => {
      // maxRuns is 0
      const resZeroMax = evaluateLoopTurn(1, 0, true)
      expect(resZeroMax.shouldContinue).toBe(false)
      expect(resZeroMax.status).toBe('halted')
      expect(resZeroMax.reason).toContain('Invalid loop bounds')

      // maxRuns is negative
      const resNegMax = evaluateLoopTurn(1, -5, true)
      expect(resNegMax.shouldContinue).toBe(false)
      expect(resNegMax.status).toBe('halted')

      // currentRun is negative
      const resNegCurrent = evaluateLoopTurn(-1, 5, true)
      expect(resNegCurrent.shouldContinue).toBe(false)
      expect(resNegCurrent.status).toBe('halted')

      // NaN inputs
      const resNan = evaluateLoopTurn(NaN, 5, true)
      expect(resNan.shouldContinue).toBe(false)
      expect(resNan.status).toBe('halted')

      const resNanMax = evaluateLoopTurn(1, NaN, true)
      expect(resNanMax.shouldContinue).toBe(false)
      expect(resNanMax.status).toBe('halted')
    })

    it('formats safe failure messages for invalid loop bounds without throwing', () => {
      const msg = formatLoopTerminalMessage(NaN, 5, true)
      expect(msg).toContain('Invalid iteration bounds')

      const msgNeg = formatLoopTerminalMessage(1, -2, true)
      expect(msgNeg).toContain('Invalid iteration bounds')
    })

    it('halts immediately on run failure regardless of remaining runs', () => {
      const result = evaluateLoopTurn(2, 10, false, 'Connection terminated')
      expect(result.shouldContinue).toBe(false)
      expect(result.status).toBe('halted')
      expect(result.reason).toBe('Connection terminated')
    })

    it('halts immediately when maxRuns or currentRun is non-finite (Infinity) or non-integer', () => {
      // Infinity as maxRuns
      const resInf = evaluateLoopTurn(1, Number.POSITIVE_INFINITY, true)
      expect(resInf.shouldContinue).toBe(false)
      expect(resInf.status).toBe('halted')
      expect(resInf.reason).toContain('Invalid loop bounds')

      // -Infinity as maxRuns
      const resNegInf = evaluateLoopTurn(1, Number.NEGATIVE_INFINITY, true)
      expect(resNegInf.shouldContinue).toBe(false)
      expect(resNegInf.status).toBe('halted')

      // Non-integer maxRuns
      const resFloatMax = evaluateLoopTurn(1, 3.5, true)
      expect(resFloatMax.shouldContinue).toBe(false)
      expect(resFloatMax.status).toBe('halted')

      // Non-integer currentRun
      const resFloatCur = evaluateLoopTurn(1.2, 5, true)
      expect(resFloatCur.shouldContinue).toBe(false)
      expect(resFloatCur.status).toBe('halted')
    })
  })

  // ── Scenario 10: Ollama regression integrity ────────────────────────────
  describe('Scenario 10: Ollama regression integrity', () => {
    it('ensures Ollama routing and health gating are completely isolated from Cline ACP', async () => {
      // 1. Health check gating
      expect(isOllamaHealthCheckRequired('direct-ollama')).toBe(true)
      expect(isOllamaHealthCheckRequired('cline-acp')).toBe(false)

      // 2. Restart gating
      expect(isOllamaRestartRequired('direct-ollama')).toBe(true)
      expect(isOllamaRestartRequired('cline-acp')).toBe(false)

      // 3. Error blocking
      const ollamaErr = 'Ollama connection failed: port 11434 closed'
      expect(isSendBlockedByOllamaError('direct-ollama', ollamaErr)).toBe(true)
      expect(isSendBlockedByOllamaError('cline-acp', ollamaErr)).toBe(false)

      const mockInvoke = vi.fn<InvokeFunction>().mockResolvedValue({})

      // 4. Stop command routing targets backend accurately
      const ollamaStop = await routeStopAgent(
        { runId: 'run-ollama-1', backend: 'direct-ollama' },
        'cline-acp', // user switched dropdown mid-run
        mockInvoke
      )
      expect(ollamaStop.targetBackend).toBe('direct-ollama')
      expect(ollamaStop.command).toBe('stop_ollama_agent')

      const clineStop = await routeStopAgent(
        { runId: 'run-cline-1', backend: 'cline-acp' },
        'direct-ollama', // user switched dropdown mid-run
        mockInvoke
      )
      expect(clineStop.targetBackend).toBe('cline-acp')
      expect(clineStop.command).toBe('stop_cline_agent')

      // 5. Context isolation
      expect(isManualContextIsolatedFromLoop('manual', 'manual')).toBe(true)
      expect(isManualContextIsolatedFromLoop('loop', 'manual')).toBe(false)
      expect(isManualContextIsolatedFromLoop('loop', 'loop')).toBe(true)
      expect(isManualContextIsolatedFromLoop('manual', 'loop')).toBe(false)
    })
  })
})
