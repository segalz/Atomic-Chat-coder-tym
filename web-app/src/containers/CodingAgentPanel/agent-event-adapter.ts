import type {
  CodingAgentBackend,
  PermissionOption,
  AcpPermissionRequestPayload,
} from './backend-identity'

export {
  type CodingAgentBackend,
  DEFAULT_CODING_AGENT_BACKEND,
  CODING_AGENT_BACKEND_STORAGE_KEY,
  isCodingAgentBackend,
  resolveCodingAgentBackend,
  getInitialCodingAgentBackend,
  persistCodingAgentBackend,
  getBackendCapabilities,
  type BackendCapabilities,
  type ModelIdentity,
  CLINE_ACP_BACKEND,
  CLINE_ACP_AGENT_NAME,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_DEFAULT_MODEL_DISPLAY_NAME,
  CLINE_DEFAULT_PROVIDER_ID,
  CLINE_DEFAULT_MODEL_IDENTITY,
  type PermissionOption,
  type PermissionOutcome,
  type AcpPermissionRequestPayload,
} from './backend-identity'

export interface TextDeltaPayload {
  text: string
  kind?: 'text' | 'thinking'
}

export interface CompatToolStartPayload {
  id?: string
  name: string
  input?: Record<string, unknown>
}

export interface DirectToolStartPayload {
  id: string
  name: string
}

export interface CompatToolResultPayload {
  id?: string
  name: string
  output: string
}

export interface DirectToolResultPayload {
  id: string
  name: string
  result: string
  is_error: boolean
}

export interface CompatDiffProposedPayload {
  id: string
  file_path: string
  search: string
  replace: string
}

export interface DirectDiffProposedPayload {
  call_id?: string
  callId?: string
  path: string
  search: string
  replace: string
}

export interface DirectEditIntentRequestPayload {
  call_id?: string
  callId?: string
  tool_name?: string
  toolName?: string
  path: string
}

export interface AgentDonePayload {
  success: boolean
  error?: string | null
}

export interface AgentErrorPayload {
  message: string
}

export interface AcpEventContext {
  runId?: string
  backend?: CodingAgentBackend
  sessionId?: string
}

export type NormalizedAgentEvent =
  | ({ type: 'text_delta'; text: string } & AcpEventContext)
  | ({ type: 'thinking'; text: string } & AcpEventContext)
  | ({ type: 'tool_start'; id?: string; name: string; input: Record<string, unknown> } & AcpEventContext)
  | ({ type: 'tool_result'; id?: string; name?: string; output: string; isError: boolean } & AcpEventContext)
  | ({ type: 'diff_proposed'; id: string; filePath: string; search: string; replace: string } & AcpEventContext)
  | ({
      type: 'permission_request'
      runId: string
      sessionId: string
      requestId: string
      toolCallId: string
      title?: string
      kind?: string
      options: PermissionOption[]
    } & AcpEventContext)
  | ({ type: 'done'; success: boolean; error?: string | null } & AcpEventContext)
  | ({ type: 'error'; message: string } & AcpEventContext)

export interface AcpMessageChunkPayload {
  text: string
}

export interface AcpThoughtChunkPayload {
  text: string
}

export interface AcpToolCallPayload {
  toolCallId: string
  title?: string
  kind?: string
  input?: Record<string, unknown>
}

export interface AcpToolCallUpdatePayload {
  toolCallId: string
  status?: string
  output?: string
  isError?: boolean
}

export interface AcpPromptDonePayload {
  stopReason: string
  error?: string | null
}

export function normalizeAcpMessageChunk(
  payload: AcpMessageChunkPayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  return { type: 'text_delta', text: payload.text, ...context }
}

export function normalizeAcpThoughtChunk(
  payload: AcpThoughtChunkPayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  return { type: 'thinking', text: payload.text, ...context }
}

export function normalizeAcpToolCall(
  payload: AcpToolCallPayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  return {
    type: 'tool_start',
    id: payload.toolCallId,
    name: payload.title || payload.kind || 'tool',
    input: payload.input ?? {},
    ...context,
  }
}

export function normalizeAcpToolCallUpdate(
  payload: AcpToolCallUpdatePayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  return {
    type: 'tool_result',
    id: payload.toolCallId,
    output: payload.output ?? '',
    isError: payload.isError ?? false,
    ...context,
  }
}

export function normalizeAcpPromptDone(
  payload: AcpPromptDonePayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  if (payload.stopReason === 'end_turn') {
    return { type: 'done', success: true, error: null, ...context }
  }
  if (payload.stopReason === 'cancelled') {
    return {
      type: 'done',
      success: false,
      error: payload.error ?? 'User cancelled turn',
      ...context,
    }
  }
  return {
    type: 'done',
    success: false,
    error: payload.error ?? `Turn stopped: ${payload.stopReason}`,
    ...context,
  }
}

export function normalizeAcpPermissionRequest(
  payload: AcpPermissionRequestPayload,
  context?: AcpEventContext
): NormalizedAgentEvent {
  return {
    type: 'permission_request',
    runId: payload.runId || context?.runId || '',
    sessionId: payload.sessionId || context?.sessionId || '',
    requestId: payload.requestId,
    toolCallId: payload.toolCallId,
    title: payload.title,
    kind: payload.kind,
    options: payload.options,
    ...context,
  }
}

/**
 * Normalizes raw session/update notification payloads from Cline ACP.
 * Note: session_info_update is intentionally suppressed (returns [])
 * so metadata updates are never injected as assistant chat text.
 */
export function normalizeAcpSessionUpdate(
  update: Record<string, unknown>,
  context?: AcpEventContext
): NormalizedAgentEvent[] {
  if (!update || typeof update !== 'object') return []

  const target = (update.update && typeof update.update === 'object'
    ? update.update
    : update) as Record<string, unknown>

  const updateType = target.sessionUpdate || target.type
  if (!updateType || typeof updateType !== 'string') return []

  // 1. Visible assistant text
  if (updateType === 'agent_message_chunk') {
    const content = target.content as Record<string, unknown> | undefined
    if (content && typeof content.text === 'string' && content.text.length > 0) {
      return [normalizeAcpMessageChunk({ text: content.text }, context)]
    }
    if (typeof target.text === 'string' && target.text.length > 0) {
      return [normalizeAcpMessageChunk({ text: target.text }, context)]
    }
  }

  // 2. Visible thinking/reasoning (only if explicitly delivered)
  if (updateType === 'agent_thought_chunk') {
    const content = target.content as Record<string, unknown> | undefined
    if (content && typeof content.text === 'string' && content.text.length > 0) {
      return [normalizeAcpThoughtChunk({ text: content.text }, context)]
    }
    if (typeof target.text === 'string' && target.text.length > 0) {
      return [normalizeAcpThoughtChunk({ text: target.text }, context)]
    }
  }

  // 3. Tool call start
  if (updateType === 'tool_call') {
    const toolCallId = String(target.toolCallId ?? target.callId ?? target.id ?? '')
    if (toolCallId) {
      return [
        normalizeAcpToolCall(
          {
            toolCallId,
            title: typeof target.title === 'string' ? target.title : undefined,
            kind: typeof target.kind === 'string' ? target.kind : undefined,
            input: toRecord(target.input),
          },
          context
        ),
      ]
    }
  }

  // 4. Tool call update / result
  if (updateType === 'tool_call_update') {
    const toolCallId = String(target.toolCallId ?? target.callId ?? target.id ?? '')
    if (toolCallId) {
      const output =
        typeof target.output === 'string'
          ? target.output
          : target.content
          ? JSON.stringify(target.content)
          : ''
      const isError = target.status === 'failed' || Boolean(target.isError)
      return [
        normalizeAcpToolCallUpdate(
          {
            toolCallId,
            status: typeof target.status === 'string' ? target.status : undefined,
            output,
            isError,
          },
          context
        ),
      ]
    }
  }

  // 5. Permission request from agent
  if (updateType === 'permission_request' || updateType === 'request_permission') {
    const toolCall = (target.toolCall && typeof target.toolCall === 'object'
      ? target.toolCall
      : target) as Record<string, unknown>
    const toolCallId = String(toolCall.toolCallId ?? toolCall.id ?? target.toolCallId ?? '')
    const requestId = String(target.requestId ?? target.id ?? '')
    const sessionId = String(target.sessionId ?? context?.sessionId ?? '')
    const runId = String(target.runId ?? context?.runId ?? '')

    const rawOptions = Array.isArray(target.options) ? target.options : []
    const options: PermissionOption[] = rawOptions.map((opt: unknown) => {
      const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>
      return {
        optionId: String(o.optionId ?? o.id ?? ''),
        name: String(o.name ?? o.label ?? o.optionId ?? ''),
        kind: typeof o.kind === 'string' ? o.kind : undefined,
      }
    }).filter((o) => Boolean(o.optionId))

    return [
      normalizeAcpPermissionRequest(
        {
          runId,
          sessionId,
          requestId,
          toolCallId,
          title: typeof toolCall.title === 'string' ? toolCall.title : (typeof target.title === 'string' ? target.title : undefined),
          kind: typeof toolCall.kind === 'string' ? toolCall.kind : (typeof target.kind === 'string' ? target.kind : undefined),
          options,
        },
        context
      ),
    ]
  }

  // 6. session_info_update, mode, or config updates are intentionally suppressed
  if (updateType === 'session_info_update' || updateType === 'config_update') {
    return []
  }

  return []
}

export interface RunEventFilter {
  accept(event: NormalizedAgentEvent): boolean
}

/**
 * Creates an event filter for a run:
 * 1. Discards events from stale/mismatched runs.
 * 2. Allows error followed by terminal done so finishAgentRun is always called.
 * 3. Enforces exactly one terminal done event, discarding duplicate completions and late events.
 */
export function createRunEventFilter(activeRunId: string): RunEventFilter {
  let doneEmitted = false
  let errorEmitted = false

  return {
    accept(event: NormalizedAgentEvent): boolean {
      if (doneEmitted) {
        return false
      }
      if (event.runId && event.runId !== activeRunId) {
        return false
      }
      if (event.type === 'error') {
        if (errorEmitted) return false
        errorEmitted = true
        return true
      }
      if (event.type === 'done') {
        doneEmitted = true
        return true
      }
      return true
    },
  }
}


export function normalizeTextDelta(payload: TextDeltaPayload): NormalizedAgentEvent {
  if (payload.kind === 'thinking') return { type: 'thinking', text: payload.text }
  return { type: 'text_delta', text: payload.text }
}

export function normalizeCompatToolStart(payload: CompatToolStartPayload): NormalizedAgentEvent {
  return {
    type: 'tool_start',
    id: payload.id,
    name: payload.name,
    input: payload.input ?? {},
  }
}

export function normalizeDirectToolStart(payload: DirectToolStartPayload): NormalizedAgentEvent {
  return {
    type: 'tool_start',
    id: payload.id,
    name: payload.name,
    input: {},
  }
}

export function normalizeCompatToolResult(payload: CompatToolResultPayload): NormalizedAgentEvent {
  return {
    type: 'tool_result',
    id: payload.id,
    name: payload.name,
    output: payload.output,
    isError: false,
  }
}

export function normalizeDirectToolResult(payload: DirectToolResultPayload): NormalizedAgentEvent {
  return {
    type: 'tool_result',
    id: payload.id,
    name: payload.name,
    output: payload.result,
    isError: payload.is_error,
  }
}

export function normalizeCompatDiffProposed(payload: CompatDiffProposedPayload): NormalizedAgentEvent {
  return {
    type: 'diff_proposed',
    id: payload.id,
    filePath: payload.file_path,
    search: payload.search,
    replace: payload.replace,
  }
}

export function normalizeDirectDiffProposed(payload: DirectDiffProposedPayload): NormalizedAgentEvent {
  return {
    type: 'diff_proposed',
    id: payload.call_id ?? payload.callId ?? '',
    filePath: payload.path,
    search: payload.search,
    replace: payload.replace,
  }
}

export function normalizeDone(payload: AgentDonePayload): NormalizedAgentEvent {
  return { type: 'done', success: payload.success, error: payload.error }
}

export function normalizeError(payload: AgentErrorPayload): NormalizedAgentEvent {
  return { type: 'error', message: payload.message }
}

export function normalizeLegacyCodeAgentOutput(line: string): NormalizedAgentEvent[] {
  const raw = line.trim()
  if (!raw) return []

  try {
    const msg = JSON.parse(line)
    const type = msg?.type

    if (type === 'system' && msg?.subtype === 'init') {
      const model = typeof msg.model === 'string' ? msg.model : 'model'
      return [{ type: 'text_delta', text: `Agent initialized with ${model}. Waiting for first response...` }]
    }

    if (type === 'assistant') {
      const content: unknown[] = msg?.message?.content ?? []
      return content.flatMap((block): NormalizedAgentEvent[] => {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_use') {
          return [{
            type: 'tool_start' as const,
            name: String(b.name ?? 'Tool'),
            input: toRecord(b.input),
          }]
        }

        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return [{ type: 'text_delta' as const, text: b.text }]
        }

        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          return [{ type: 'thinking' as const, text: b.thinking }]
        }

        return []
      })
    }

    if (type === 'user') {
      const content: unknown[] = msg?.message?.content ?? []
      return content.flatMap((block): NormalizedAgentEvent[] => {
        const b = block as Record<string, unknown>
        if (b.type !== 'tool_result') return []

        const output = Array.isArray(b.content)
          ? (b.content as Array<Record<string, unknown>>).map((c) => c.text ?? '').join('\n')
          : String(b.content ?? '')

        return [{ type: 'tool_result' as const, output, isError: false }]
      })
    }

    if (type === 'result') {
      const success = msg.subtype === 'success'
      return [{
        type: 'done',
        success,
        error: success ? null : String(msg.error ?? 'Agent stopped'),
      }]
    }
  } catch {
    return [{ type: 'text_delta', text: line }]
  }

  return []
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}
