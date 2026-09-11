import { CodingAgentBackend, resolveCodingAgentBackend } from './backend-identity'
import { CodingSession } from '@/stores/coding-agent-store'

export interface ToolResultRecord {
  tool: string
  summary: string
}

export interface VerificationResultRecord {
  command: string
  success: boolean
}

/**
 * Deterministic snapshot of a loop run derived from loop event logs and checkpoints.
 */
export interface LoopCheckpointData {
  loop_id: string
  run_number: number
  max_runs: number
  project_dir: string
  current_goal: string
  current_stage: 'running' | 'complete' | 'failed' | 'unknown'
  completed_actions: string[]
  files_seen: string[]
  files_changed: string[]
  tool_results: ToolResultRecord[]
  known_findings: string[]
  verification: VerificationResultRecord[]
  next_action: string
  do_not_repeat: string[]
  risks: string[]
}

export interface ContinuationValidationParams {
  activeLoopId: string | null
  currentRun: number
  maxRuns: number
  projectDir: string
  targetBackend: CodingAgentBackend
  activeSession?: CodingSession | null
  checkpoint?: LoopCheckpointData | null
  isPriorRunInterrupted?: boolean
  isRestart?: boolean
}

export interface ContinuationSafetyResult {
  safe: boolean
  error?: string
  resumePrompt?: string | null
  shouldStartNewExternalSession: boolean
  isClineContinuation: boolean
}

/**
 * Parses a textual checkpoint resume prompt (from get_loop_resume_prompt) into
 * a structured LoopCheckpointData object for validation.
 */
export function parseResumePromptToCheckpoint(
  promptText: string,
  loopId: string,
  projectDir: string,
  maxRuns: number
): LoopCheckpointData | null {
  if (!promptText || !promptText.includes('[CHECKPOINT RESUME')) {
    return null
  }

  const runMatch = promptText.match(/\[CHECKPOINT RESUME — run (\d+)\]/)
  const runNumber = runMatch ? parseInt(runMatch[1], 10) : 1

  const goalMatch = promptText.match(/Goal:\s*([^\r\n]+)/)
  const currentGoal = goalMatch ? goalMatch[1].trim() : ''

  const completedMatch = promptText.match(/Completed(?: actions \(DO NOT REPEAT\))?:\s*([^\r\n]+)/)
  const completedActions = completedMatch
    ? completedMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    : []

  const filesChangedMatch = promptText.match(/Files changed so far:\s*([^\r\n]+)/)
  const filesChanged = filesChangedMatch
    ? filesChangedMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    : []

  const nextActionMatch = promptText.match(/Next action:\s*([^\r\n]+)/)
  const nextAction = nextActionMatch ? nextActionMatch[1].trim() : ''

  const doNotRepeatMatch = promptText.match(/Do not repeat:\s*([^\r\n]+)/)
  const doNotRepeat = doNotRepeatMatch
    ? doNotRepeatMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    : []

  return {
    loop_id: loopId,
    run_number: runNumber,
    max_runs: maxRuns,
    project_dir: projectDir,
    current_goal: currentGoal,
    current_stage: 'complete',
    completed_actions: completedActions,
    files_seen: [],
    files_changed: filesChanged,
    tool_results: [],
    known_findings: [],
    verification: [],
    next_action: nextAction,
    do_not_repeat: doNotRepeat,
    risks: [],
  }
}

/**
 * Builds a schema-driven resume prompt from a Loop checkpoint.
 * Highlights completed actions and do_not_repeat constraints to prevent
 * duplicate execution of already-completed actions.
 */
export function buildLoopResumePrompt(cp: LoopCheckpointData): string {
  const lines: string[] = [
    `[CHECKPOINT RESUME — run ${cp.run_number}]`,
    `Goal: ${cp.current_goal || 'Continue automated tasks'}`,
  ]

  if (cp.completed_actions && cp.completed_actions.length > 0) {
    lines.push(`Completed actions (DO NOT REPEAT): ${cp.completed_actions.join(', ')}`)
  }

  if (cp.files_changed && cp.files_changed.length > 0) {
    lines.push(`Files changed so far: ${cp.files_changed.join(', ')}`)
  }

  if (cp.next_action && cp.next_action.trim()) {
    lines.push(`Next action: ${cp.next_action.trim()}`)
  }

  if (cp.do_not_repeat && cp.do_not_repeat.length > 0) {
    lines.push(`Do not repeat: ${cp.do_not_repeat.join(', ')}`)
  }

  if (cp.known_findings && cp.known_findings.length > 0) {
    lines.push(`Known findings: ${cp.known_findings.slice(0, 3).join('; ')}`)
  }

  if (cp.risks && cp.risks.length > 0) {
    lines.push(`Risks: ${cp.risks.join(', ')}`)
  }

  lines.push(
    'Continue from the checkpoint above. Do not re-read files already in files_changed. Do not repeat completed_actions. Proceed directly with next_action.'
  )

  return lines.join('\n')
}

/**
 * Validates continuation safety for a Loop run (AC for Stage 19).
 * Evaluates:
 * 1. Interruption before vs after terminal result
 * 2. Stale checkpoint detection (loopId, projectDir, run sequence)
 * 3. App restart recovery (defunct externalSessionId handling)
 * 4. Provider mismatch handling
 *
 * In accordance with the Stage 19 contract:
 * "Fail visibly when continuation safety cannot be established."
 */
export function validateContinuationSafety(
  params: ContinuationValidationParams
): ContinuationSafetyResult {
  const {
    activeLoopId,
    currentRun,
    projectDir,
    targetBackend,
    activeSession,
    checkpoint,
    isPriorRunInterrupted = false,
    isRestart = false,
  } = params

  // Run 1 is an initial run, not a continuation.
  if (currentRun <= 1) {
    return {
      safe: true,
      resumePrompt: null,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // 1. Missing activeLoopId for continuation
  if (!activeLoopId) {
    return {
      safe: false,
      error: 'Cannot continue Loop: activeLoopId is missing for multi-turn run.',
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // 2. Interruption before terminal result
  if (isPriorRunInterrupted || (checkpoint && checkpoint.current_stage !== 'complete')) {
    const priorStage = checkpoint?.current_stage ?? 'interrupted'
    return {
      safe: false,
      error: `Cannot continue Loop: run ${currentRun - 1} did not reach a terminal complete result (stage: '${priorStage}').`,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // 3. Checkpoint existence
  if (!checkpoint) {
    return {
      safe: false,
      error: `Continuation safety failure: No checkpoint found for run ${currentRun - 1} of loop '${activeLoopId}'.`,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // 4. Stale checkpoint checks:
  // a) loop_id mismatch
  if (checkpoint.loop_id !== activeLoopId) {
    return {
      safe: false,
      error: `Continuation safety failure: Stale checkpoint loopId mismatch (expected '${activeLoopId}', found '${checkpoint.loop_id}').`,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // b) project_dir mismatch
  if (checkpoint.project_dir !== projectDir) {
    return {
      safe: false,
      error: `Continuation safety failure: Stale checkpoint projectDir mismatch (expected '${projectDir}', found '${checkpoint.project_dir}').`,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // c) run_number sequence mismatch
  const expectedPriorRun = currentRun - 1
  if (checkpoint.run_number !== expectedPriorRun) {
    return {
      safe: false,
      error: `Continuation safety failure: Stale checkpoint run sequence mismatch (expected run ${expectedPriorRun}, found run ${checkpoint.run_number}).`,
      shouldStartNewExternalSession: false,
      isClineContinuation: false,
    }
  }

  // 5. Provider mismatch detection
  const activeSessionBackend = activeSession ? resolveCodingAgentBackend(activeSession.backend) : null
  const isProviderMismatch = Boolean(
    activeSession &&
    activeSessionBackend &&
    activeSessionBackend !== targetBackend
  )

  let shouldStartNewExternalSession = false
  let isClineContinuation = false

  if (isRestart) {
    // After an app restart, external ACP processes are dead; must start a fresh external session.
    shouldStartNewExternalSession = true
    isClineContinuation = false
  } else if (isProviderMismatch) {
    // Switching providers mid-loop cannot reuse foreign externalSessionId.
    shouldStartNewExternalSession = true
    isClineContinuation = false
  } else if (targetBackend === 'cline-acp') {
    // For Cline ACP on the same provider without restart, if externalSessionId is valid, continuation is enabled.
    if (activeSession?.externalSessionId) {
      isClineContinuation = true
      shouldStartNewExternalSession = false
    } else {
      shouldStartNewExternalSession = true
      isClineContinuation = false
    }
  }

  const resumePrompt = buildLoopResumePrompt(checkpoint)

  return {
    safe: true,
    resumePrompt,
    shouldStartNewExternalSession,
    isClineContinuation,
  }
}
