import type { CodingAgentBackend } from './backend-identity'
import { routeStopAgent, type ActiveRun, type InvokeFunction } from './backend-router'

export interface LoopState {
  enabled: boolean
  loopId: string | null
  currentRun: number
  maxRuns: number
  intervalMinutes: number
  prompt: string
  countdownSeconds: number | null
  status: 'idle' | 'running' | 'countdown' | 'completed' | 'halted' | 'interrupted'
  haltReason?: string
}

export interface LoopIterationResult {
  nextRun: number | null
  shouldContinue: boolean
  status: 'countdown' | 'completed' | 'halted'
  reason?: string
}

/**
 * Determines whether a Loop run should advance, complete, or halt given the last turn outcome.
 * Enforces bounded maxRuns and immediate failure halting.
 */
export function evaluateLoopTurn(
  currentRun: number,
  maxRuns: number,
  success: boolean,
  errorMessage?: string | null
): LoopIterationResult {
  if (
    typeof maxRuns !== 'number' ||
    !Number.isFinite(maxRuns) ||
    !Number.isInteger(maxRuns) ||
    maxRuns <= 0 ||
    typeof currentRun !== 'number' ||
    !Number.isFinite(currentRun) ||
    !Number.isInteger(currentRun) ||
    currentRun < 0
  ) {
    return {
      nextRun: null,
      shouldContinue: false,
      status: 'halted',
      reason: `Invalid loop bounds: currentRun=${currentRun}, maxRuns=${maxRuns}. Loop sequence halted.`,
    }
  }

  if (!success) {
    return {
      nextRun: null,
      shouldContinue: false,
      status: 'halted',
      reason: errorMessage ?? 'Loop halted due to agent run failure.',
    }
  }

  if (currentRun >= maxRuns) {
    return {
      nextRun: null,
      shouldContinue: false,
      status: 'completed',
      reason: `Completed all ${maxRuns} bounded loop runs.`,
    }
  }

  return {
    nextRun: currentRun + 1,
    shouldContinue: true,
    status: 'countdown',
  }
}

/**
 * Strictly verifies whether blanket auto-approval of tool permissions is permitted.
 * In accordance with Stage 18 Criterion 6:
 * Blanket auto-approval is NEVER permitted for cline-acp under any circumstances (including Loop mode).
 */
export function isPermissionAutoApprovalAllowed(
  backend: CodingAgentBackend,
  _source: 'manual' | 'loop' = 'loop'
): boolean {
  if (backend === 'cline-acp') {
    return false
  }
  return false
}

/**
 * Validates that no cross-backend or concurrent run is currently active before scheduling/starting a Loop iteration.
 */
export function validateLoopConcurrency(
  activeRun: ActiveRun | null,
  targetBackend: CodingAgentBackend
): void {
  if (activeRun) {
    throw new Error(
      `Cannot start Loop iteration on '${targetBackend}': an agent run is already active on backend '${activeRun.backend}' (runId: ${activeRun.runId}).`
    )
  }
}

/**
 * Verifies that manual sessions and loop sessions maintain strict context isolation.
 */
export function isManualContextIsolatedFromLoop(
  sessionSource: string | undefined,
  targetSource: 'manual' | 'loop'
): boolean {
  if (targetSource === 'loop') {
    return sessionSource !== 'manual'
  }
  return sessionSource === 'manual'
}

/**
 * Formats a user-facing terminal message for a loop iteration.
 */
export function formatLoopTerminalMessage(
  currentRun: number,
  maxRuns: number,
  success: boolean,
  error?: string | null
): string {
  if (
    typeof maxRuns !== 'number' ||
    !Number.isFinite(maxRuns) ||
    !Number.isInteger(maxRuns) ||
    maxRuns <= 0 ||
    typeof currentRun !== 'number' ||
    !Number.isFinite(currentRun) ||
    !Number.isInteger(currentRun) ||
    currentRun < 0
  ) {
    return `[Loop] Invalid iteration bounds (currentRun=${currentRun}, maxRuns=${maxRuns}). Loop sequence halted.`
  }
  if (!success) {
    return `[Loop] Iteration ${currentRun}/${maxRuns} failed: ${error ?? 'Unknown error'}. Loop sequence halted.`
  }
  if (currentRun >= maxRuns) {
    return `[Loop] Iteration ${currentRun}/${maxRuns} completed. All ${maxRuns} bounded iterations finished successfully.`
  }
  return `[Loop] Iteration ${currentRun}/${maxRuns} completed successfully. Scheduling iteration ${currentRun + 1}/${maxRuns}.`
}

export interface StopLoopParams {
  activeRun: ActiveRun | null
  selectedBackend: CodingAgentBackend
  sessionId: string | null
  timerHandle?: {
    timeout?: ReturnType<typeof setTimeout> | null
    interval?: ReturnType<typeof setInterval> | null
  }
}

export interface StopLoopResult {
  stoppedCommand: string
  targetBackend: CodingAgentBackend
  sessionInterrupted: boolean
  timerCleared: boolean
}

/**
 * Unified stop handler for Loop runs (AC3):
 * 1. Cancels active Loop timer handles across both running and countdown phases.
 * 2. Stops the active backend run via routeStopAgent (stop_cline_agent for Cline runs).
 * 3. Transitions session status to 'interrupted' without test-side manual store writes.
 */
export async function stopLoopExecution(
  params: StopLoopParams,
  invokeFn: InvokeFunction,
  storeApi?: {
    markSessionInterrupted: (id: string, reason: string) => void
    setRunning?: (running: boolean) => void
  }
): Promise<StopLoopResult> {
  let timerCleared = false
  if (params.timerHandle) {
    if (params.timerHandle.timeout) {
      clearTimeout(params.timerHandle.timeout)
      params.timerHandle.timeout = null
      timerCleared = true
    }
    if (params.timerHandle.interval) {
      clearInterval(params.timerHandle.interval)
      params.timerHandle.interval = null
      timerCleared = true
    }
  }

  let stopRes: { command: string; targetBackend: CodingAgentBackend }
  let sessionInterrupted = false
  try {
    stopRes = await routeStopAgent(params.activeRun, params.selectedBackend, invokeFn)
  } finally {
    const targetSessionId = params.activeRun?.sessionId ?? params.sessionId
    if (targetSessionId && storeApi?.markSessionInterrupted) {
      storeApi.markSessionInterrupted(targetSessionId, 'User stopped run')
      sessionInterrupted = true
    }
    if (storeApi?.setRunning) {
      storeApi.setRunning(false)
    }
  }

  return {
    stoppedCommand: stopRes.command,
    targetBackend: stopRes.targetBackend,
    sessionInterrupted,
    timerCleared,
  }
}

export interface LoopPermissionValidationResult {
  allowed: boolean
  reason: string
}

/**
 * Validates whether an incoming permission request can be processed in the current Loop state (AC5).
 * Lingering or late permission requests arriving during countdown, after completion, or after halt
 * are strictly rejected and cannot advance the loop or execute mutating tools.
 */
export function validateLoopPermissionProcessing(
  loopPhase: 'idle' | 'running' | 'countdown' | 'completed' | 'halted' | 'interrupted',
  activeRun: ActiveRun | null,
  permissionRunId: string
): LoopPermissionValidationResult {
  if (loopPhase !== 'running') {
    return {
      allowed: false,
      reason: `Permission rejected: Loop is in '${loopPhase}' phase, not actively running.`,
    }
  }
  if (!activeRun || activeRun.runId !== permissionRunId) {
    return {
      allowed: false,
      reason: `Permission rejected: runId mismatch (active: '${activeRun?.runId ?? 'none'}', request: '${permissionRunId}').`,
    }
  }
  return {
    allowed: true,
    reason: 'Permission valid for active in-flight run.',
  }
}
