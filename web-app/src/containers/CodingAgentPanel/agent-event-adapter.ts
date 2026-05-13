export type CodingAgentBackend = 'legacy-claude' | 'direct-ollama'

export const DEFAULT_CODING_AGENT_BACKEND: CodingAgentBackend = 'direct-ollama'
export const CODING_AGENT_BACKEND_STORAGE_KEY = 'coding-agent-backend'

export function isCodingAgentBackend(value: string | null): value is CodingAgentBackend {
  return value === 'legacy-claude' || value === 'direct-ollama'
}

export function getInitialCodingAgentBackend(): CodingAgentBackend {
  const envBackend = import.meta.env.VITE_CODING_AGENT_BACKEND
  if (isCodingAgentBackend(envBackend)) return envBackend

  if (typeof window === 'undefined') return DEFAULT_CODING_AGENT_BACKEND

  try {
    const storedBackend = window.localStorage.getItem(CODING_AGENT_BACKEND_STORAGE_KEY)
    if (isCodingAgentBackend(storedBackend)) return storedBackend
  } catch {
    // Ignore storage failures and keep the conservative default.
  }

  return DEFAULT_CODING_AGENT_BACKEND
}

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
  call_id: string
  path: string
  search: string
  replace: string
}

export interface AgentDonePayload {
  success: boolean
  error?: string | null
}

export interface AgentErrorPayload {
  message: string
}

export type NormalizedAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id?: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id?: string; name?: string; output: string; isError: boolean }
  | { type: 'diff_proposed'; id: string; filePath: string; search: string; replace: string }
  | { type: 'done'; success: boolean; error?: string | null }
  | { type: 'error'; message: string }

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
    id: payload.call_id,
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
