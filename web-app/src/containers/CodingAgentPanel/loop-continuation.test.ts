import { describe, expect, it } from 'vitest'
import {
  validateContinuationSafety,
  buildLoopResumePrompt,
  parseResumePromptToCheckpoint,
  LoopCheckpointData,
} from './loop-continuation'
import { CodingSession } from '@/stores/coding-agent-store'
import { buildCodingAgentPrompt } from './conversation-context'

describe('Loop Continuation and Recovery (Stage 19)', () => {
  const baseCheckpoint: LoopCheckpointData = {
    loop_id: 'loop-alpha-123',
    run_number: 1,
    max_runs: 3,
    project_dir: '/test/workspace',
    current_goal: 'Refactor auth module',
    current_stage: 'complete',
    completed_actions: ['read_file src/auth.ts', 'editor: replace tokens in src/auth.ts'],
    files_seen: ['src/auth.ts', 'src/types.ts'],
    files_changed: ['src/auth.ts'],
    tool_results: [
      { tool: 'read_file', summary: 'read src/auth.ts' },
      { tool: 'editor', summary: 'updated JWT validation' },
    ],
    known_findings: ['Legacy session format deprecated'],
    verification: [{ command: 'yarn test auth', success: true }],
    next_action: 'Add refresh token rotation test in src/auth.test.ts',
    do_not_repeat: ['Do not edit src/auth.ts again; token replacement is already complete.'],
    risks: ['Token expiry may break legacy clients'],
  }

  // ── Scenario 1: Interruption before terminal result ─────────────────────
  it('Scenario 1: Fails visibly when prior run was interrupted before reaching terminal complete result', () => {
    // Checkpoint has current_stage: 'running' or 'failed'
    const incompleteCheckpoint: LoopCheckpointData = {
      ...baseCheckpoint,
      current_stage: 'running',
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: incompleteCheckpoint,
      isPriorRunInterrupted: true,
    })

    expect(result.safe).toBe(false)
    expect(result.error).toContain('did not reach a terminal complete result')
    expect(result.error).toContain('stage: \'running\'')
    expect(result.resumePrompt).toBeUndefined()
  })

  // ── Scenario 2: Interruption after terminal result ──────────────────────
  it('Scenario 2: Safely resumes next run when prior run reached terminal complete result', () => {
    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: baseCheckpoint,
      isPriorRunInterrupted: false,
    })

    expect(result.safe).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.resumePrompt).toContain('[CHECKPOINT RESUME — run 1]')
    expect(result.resumePrompt).toContain('Goal: Refactor auth module')
    expect(result.resumePrompt).toContain('Next action: Add refresh token rotation test in src/auth.test.ts')
  })

  // ── Scenario 3: Stale checkpoint — loopId mismatch ──────────────────────
  it('Scenario 3: Fails visibly when checkpoint loop_id does not match activeLoopId', () => {
    const mismatchedLoopCp: LoopCheckpointData = {
      ...baseCheckpoint,
      loop_id: 'loop-other-999',
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: mismatchedLoopCp,
    })

    expect(result.safe).toBe(false)
    expect(result.error).toContain('Stale checkpoint loopId mismatch')
    expect(result.error).toContain('loop-alpha-123')
    expect(result.error).toContain('loop-other-999')
  })

  // ── Scenario 4: Stale checkpoint — projectDir mismatch ──────────────────
  it('Scenario 4: Fails visibly when checkpoint project_dir does not match current workspace projectDir', () => {
    const mismatchedDirCp: LoopCheckpointData = {
      ...baseCheckpoint,
      project_dir: '/different/workspace',
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: mismatchedDirCp,
    })

    expect(result.safe).toBe(false)
    expect(result.error).toContain('Stale checkpoint projectDir mismatch')
    expect(result.error).toContain('/test/workspace')
    expect(result.error).toContain('/different/workspace')
  })

  // ── Scenario 5: Stale checkpoint — out-of-sequence run number ───────────
  it('Scenario 5: Fails visibly when checkpoint run_number does not match expected prior run', () => {
    // Trying to start run 3, but checkpoint is for run 1 (run 2 missing)
    const outOfSequenceCp: LoopCheckpointData = {
      ...baseCheckpoint,
      run_number: 1,
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 3,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: outOfSequenceCp,
    })

    expect(result.safe).toBe(false)
    expect(result.error).toContain('Stale checkpoint run sequence mismatch')
    expect(result.error).toContain('expected run 2')
    expect(result.error).toContain('found run 1')
  })

  // ── Scenario 6: App restart recovery ────────────────────────────────────
  it('Scenario 6: Discards defunct externalSessionId on app restart and requests fresh external session', () => {
    const activeSession: CodingSession = {
      id: 'session-loop-restarted',
      projectDir: '/test/workspace',
      prompt: 'Refactor auth',
      planText: '',
      conversationSummary: null,
      execLog: [],
      filesChanged: [],
      createdAt: Date.now() - 100000,
      updatedAt: Date.now() - 50000,
      status: 'idle',
      backend: 'cline-acp',
      externalSessionId: 'defunct-cline-session-from-prior-process',
      source: 'loop',
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      activeSession,
      checkpoint: baseCheckpoint,
      isRestart: true,
    })

    expect(result.safe).toBe(true)
    // On restart, external ACP session cannot be continued directly; must start fresh external session
    expect(result.shouldStartNewExternalSession).toBe(true)
    expect(result.isClineContinuation).toBe(false)
    // Checkpoint prompt is retained for continuous recovery
    expect(result.resumePrompt).toContain('[CHECKPOINT RESUME — run 1]')
  })

  // ── Scenario 7: Provider mismatch handling ──────────────────────────────
  it('Scenario 7: Prevents cross-backend session leakage on provider switch mid-loop', () => {
    // Loop run 1 was executed on direct-ollama, resuming run 2 on cline-acp
    const ollamaSession: CodingSession = {
      id: 'session-loop-ollama',
      projectDir: '/test/workspace',
      prompt: 'Refactor auth',
      planText: '',
      conversationSummary: null,
      execLog: [],
      filesChanged: [],
      createdAt: Date.now() - 100000,
      updatedAt: Date.now() - 50000,
      status: 'idle',
      backend: 'direct-ollama',
      source: 'loop',
    }

    const result = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 2,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      activeSession: ollamaSession,
      checkpoint: baseCheckpoint,
    })

    expect(result.safe).toBe(true)
    // Must NOT treat Ollama session as Cline ACP continuation
    expect(result.shouldStartNewExternalSession).toBe(true)
    expect(result.isClineContinuation).toBe(false)
    expect(result.resumePrompt).toContain('[CHECKPOINT RESUME — run 1]')
  })

  // ── Scenario 8: Action deduplication ────────────────────────────────────
  it('Scenario 8: Formats completed actions and do_not_repeat into resume prompt to prevent re-execution', () => {
    const resumePrompt = buildLoopResumePrompt(baseCheckpoint)

    // Asserts completed actions and do_not_repeat are prominently formatted
    expect(resumePrompt).toContain('Completed actions (DO NOT REPEAT): read_file src/auth.ts, editor: replace tokens in src/auth.ts')
    expect(resumePrompt).toContain('Files changed so far: src/auth.ts')
    expect(resumePrompt).toContain('Next action: Add refresh token rotation test in src/auth.test.ts')
    expect(resumePrompt).toContain('Do not repeat: Do not edit src/auth.ts again; token replacement is already complete.')
    expect(resumePrompt).toContain('Do not re-read files already in files_changed. Do not repeat completed_actions.')
  })

  // ── Scenario 9: Manual history isolation during Loop continuation ───────
  it('Scenario 9: Strictly isolates manual conversation history and plan text from Loop continuation prompts', () => {
    const manualSession: CodingSession = {
      id: 'session-manual-confidential',
      projectDir: '/test/workspace',
      prompt: 'Initial manual confidential request',
      planText: 'SUPER_SECRET_MANUAL_PLAN_DATA',
      conversationSummary: 'Manual session summary confidential',
      execLog: [{ type: 'text_delta', content: 'Secret log output', timestamp: 12345 }],
      filesChanged: ['secret.txt'],
      createdAt: 1000,
      updatedAt: 2000,
      status: 'idle',
      source: 'manual',
    }

    const resumePrompt = buildLoopResumePrompt(baseCheckpoint)

    // Build the agent prompt for loop continuation
    const finalPrompt = buildCodingAgentPrompt({
      prompt: `${resumePrompt}\n\nCurrent iteration task: write tests`,
      projectDir: '/test/workspace',
      sessions: [manualSession],
      activeSessionId: manualSession.id,
      source: 'loop',
      includeHistory: true, // Caller attempts to include history
      includeSummaryContext: true,
    })

    // Assert that manual plan text, summary, and secrets are completely absent
    expect(finalPrompt).not.toContain('SUPER_SECRET_MANUAL_PLAN_DATA')
    expect(finalPrompt).not.toContain('Manual session summary confidential')
    expect(finalPrompt).not.toContain('Secret log output')
    expect(finalPrompt).toContain('[CHECKPOINT RESUME — run 1]')
    expect(finalPrompt).toContain('Current iteration task: write tests')
  })

  // ── Scenario 10: Textual resume prompt parsing & validation ─────────────
  it('Scenario 10: Parses textual checkpoint resume prompt into structured object and validates continuation', () => {
    const rawResumePrompt = [
      '[CHECKPOINT RESUME — run 2]',
      'Goal: Implement loop recovery',
      'Completed: run tests, update router',
      'Files changed so far: src/router.ts',
      'Next action: Add integration verification',
      'Do not repeat: Do not re-run baseline tests.',
      'Continue from the checkpoint above. Do not re-read files already in files_changed.',
    ].join('\n')

    const parsed = parseResumePromptToCheckpoint(
      rawResumePrompt,
      'loop-alpha-123',
      '/test/workspace',
      3
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.run_number).toBe(2)
    expect(parsed?.current_goal).toBe('Implement loop recovery')
    expect(parsed?.completed_actions).toEqual(['run tests', 'update router'])
    expect(parsed?.files_changed).toEqual(['src/router.ts'])
    expect(parsed?.next_action).toBe('Add integration verification')
    expect(parsed?.do_not_repeat).toEqual(['Do not re-run baseline tests.'])

    // Validating continuation to run 3 with this parsed checkpoint succeeds
    const safety = validateContinuationSafety({
      activeLoopId: 'loop-alpha-123',
      currentRun: 3,
      maxRuns: 3,
      projectDir: '/test/workspace',
      targetBackend: 'cline-acp',
      checkpoint: parsed,
    })

    expect(safety.safe).toBe(true)
    expect(safety.resumePrompt).toContain('[CHECKPOINT RESUME — run 2]')
  })
})
