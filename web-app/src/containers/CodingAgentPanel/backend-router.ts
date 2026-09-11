import type { CodingAgentBackend } from './backend-identity'

export type InvokeFunction = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface ActiveRun {
  runId: string
  backend: CodingAgentBackend
  sessionId?: string
}

export interface RouteSendParams {
  backend: CodingAgentBackend
  projectDir: string
  prompt: string
  model?: string
  sessionId?: string
  activeRun: ActiveRun | null
  // Ollama-specific optional params
  ollamaBaseUrl?: string
  editPermission?: string
  lspEnabled?: boolean
  source?: string
  currentRun?: number
  maxRuns?: number
  loopId?: string | null
}

export interface RouteSendResult {
  success: boolean
  activeRun: ActiveRun
  command: string
  error?: string
}

export interface RouteStopResult {
  command: string
  targetBackend: CodingAgentBackend
}

/**
 * Returns true only if Ollama pre-flight health check is required.
 * Cline ACP must never gate on or invoke Ollama health checks.
 */
export function isOllamaHealthCheckRequired(backend: CodingAgentBackend): boolean {
  return backend === 'direct-ollama'
}

/**
 * Returns true only if Ollama restart is required on agent finish.
 * Cline ACP runs must never restart Ollama.
 */
export function isOllamaRestartRequired(backend: CodingAgentBackend): boolean {
  return backend === 'direct-ollama'
}

/**
 * Returns true if an Ollama error should block the send button.
 * Cline ACP runs must not be disabled by Ollama errors.
 */
export function isSendBlockedByOllamaError(backend: CodingAgentBackend, ollamaError: string | null): boolean {
  return backend === 'direct-ollama' && Boolean(ollamaError)
}

/**
 * Routes the stop action to the active run backend even if the UI selection has changed.
 * If no active run is tracked, falls back to the selected backend.
 */
export async function routeStopAgent(
  activeRun: ActiveRun | null,
  selectedBackend: CodingAgentBackend,
  invokeFn: InvokeFunction
): Promise<RouteStopResult> {
  const targetBackend = activeRun?.backend ?? selectedBackend

  if (targetBackend === 'cline-acp') {
    await invokeFn('stop_cline_agent', { runId: activeRun?.runId })
    return { command: 'stop_cline_agent', targetBackend: 'cline-acp' }
  }

  if (targetBackend === 'direct-ollama') {
    await invokeFn('stop_ollama_agent')
    return { command: 'stop_ollama_agent', targetBackend: 'direct-ollama' }
  }

  await invokeFn('stop_code_agent')
  return { command: 'stop_code_agent', targetBackend }
}

/**
 * Routes prompt submission to the appropriate backend.
 * Enforces cross-backend concurrency prevention (rejects if activeRun is present).
 * Does not invoke Ollama APIs when routing to Cline ACP.
 */
export async function routeSendAgentPrompt(
  params: RouteSendParams,
  invokeFn: InvokeFunction
): Promise<RouteSendResult> {
  if (params.activeRun) {
    throw new Error(
      `An agent run is already active on backend '${params.activeRun.backend}'. Stop it first.`
    )
  }

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (params.backend === 'cline-acp') {
    await invokeFn('start_cline_agent', {
      projectDir: params.projectDir,
      prompt: params.prompt,
      model: params.model ?? 'zai/glm-5.3-flash',
      runId,
      sessionId: params.sessionId,
    })
    return {
      success: true,
      activeRun: { runId, backend: 'cline-acp', sessionId: params.sessionId },
      command: 'start_cline_agent',
    }
  }

  if (params.backend === 'direct-ollama') {
    await invokeFn('start_ollama_agent', {
      projectDir: params.projectDir,
      prompt: params.prompt,
      model: params.model,
      ollamaBaseUrl: params.ollamaBaseUrl ?? 'http://localhost:11434',
      editPermission: params.editPermission ?? 'allowed',
      lspEnabled: params.lspEnabled ?? false,
      source: params.source,
      currentRun: params.currentRun,
      maxRuns: params.maxRuns,
      loopId: params.loopId,
    })
    return {
      success: true,
      activeRun: { runId, backend: 'direct-ollama' },
      command: 'start_ollama_agent',
    }
  }

  // Legacy backend
  await invokeFn('spawn_code_agent', {
    projectDir: params.projectDir,
    prompt: params.prompt,
    ollamaModel: params.model,
    permissionMode: 'auto_accept',
  })
  return {
    success: true,
    activeRun: { runId, backend: params.backend },
    command: 'spawn_code_agent',
  }
}

export interface RouteRespondPermissionParams {
  backend: CodingAgentBackend
  runId: string
  requestId: string
  optionId: string
}

export interface RouteRespondPermissionResult {
  command: string
  backend: CodingAgentBackend
}

/**
 * Routes permission responses by backend.
 * - cline-acp: invokes respond_cline_permission({ runId, requestId, optionId })
 * - direct-ollama: rejected (Ollama uses diff approval channels instead of ACP permissions)
 * Strictly guarantees that Cline permissions are NEVER sent to Ollama diff channels and vice versa.
 */
export async function routeRespondPermission(
  params: RouteRespondPermissionParams,
  invokeFn: InvokeFunction
): Promise<RouteRespondPermissionResult> {
  if (params.backend === 'cline-acp') {
    await invokeFn('respond_cline_permission', {
      runId: params.runId,
      requestId: params.requestId,
      optionId: params.optionId,
    })
    return { command: 'respond_cline_permission', backend: 'cline-acp' }
  }

  throw new Error(
    `routeRespondPermission is only valid for 'cline-acp', but backend was '${params.backend}'. Ollama uses diff approval channels.`
  )
}

