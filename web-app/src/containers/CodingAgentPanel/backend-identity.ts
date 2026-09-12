/**
 * Backend and Model Identity Types for Coding Agent Panel
 *
 * Implements Stage 04 of the Cline ACP Integration Roadmap.
 * Defined according to docs/msp-plan/cline-acp/integration-contract.md.
 */

export type CodingAgentBackend = 'direct-ollama' | 'legacy-claude' | 'cline-acp'

export const DEFAULT_CODING_AGENT_BACKEND: CodingAgentBackend = 'direct-ollama'
export const CODING_AGENT_BACKEND_STORAGE_KEY = 'coding-agent-backend'

export const CLINE_ACP_BACKEND: CodingAgentBackend = 'cline-acp'
export const CLINE_ACP_AGENT_NAME = 'cline'
export const CLINE_DEFAULT_MODEL_ID = 'zai/glm-5.3-flash'
export const CLINE_DEFAULT_MODEL_DISPLAY_NAME = 'GLM 5.3 Flash'
export const CLINE_DEFAULT_PROVIDER_ID = 'zai'

export interface ModelIdentity {
  backend: CodingAgentBackend
  modelId: string
  displayName: string
  providerId?: string
  agentName?: string
}

export const CLINE_DEFAULT_MODEL_IDENTITY: ModelIdentity = {
  backend: CLINE_ACP_BACKEND,
  modelId: CLINE_DEFAULT_MODEL_ID,
  displayName: CLINE_DEFAULT_MODEL_DISPLAY_NAME,
  providerId: CLINE_DEFAULT_PROVIDER_ID,
  agentName: CLINE_ACP_AGENT_NAME,
}

export interface BackendCapabilities {
  tools: boolean
  streaming: boolean
  thinking: boolean
  diffApproval: boolean
  loadSession: boolean
  cancel: boolean
  requestPermissions: boolean
}

const BACKEND_CAPABILITIES: Record<CodingAgentBackend, BackendCapabilities> = {
  'direct-ollama': {
    tools: true,
    streaming: true,
    thinking: true,
    diffApproval: true,
    loadSession: false,
    cancel: true,
    requestPermissions: false,
  },
  'legacy-claude': {
    tools: true,
    streaming: true,
    thinking: true,
    diffApproval: true,
    loadSession: false,
    cancel: true,
    requestPermissions: false,
  },
  'cline-acp': {
    tools: true,
    streaming: true,
    thinking: true,
    diffApproval: false,
    loadSession: true,
    cancel: true,
    requestPermissions: true,
  },
}

export function isCodingAgentBackend(value: unknown): value is CodingAgentBackend {
  return value === 'direct-ollama' || value === 'legacy-claude' || value === 'cline-acp'
}

export function resolveCodingAgentBackend(
  value: unknown,
  fallback: CodingAgentBackend = DEFAULT_CODING_AGENT_BACKEND
): CodingAgentBackend {
  if (isCodingAgentBackend(value)) {
    return value
  }
  return fallback
}

export function getInitialCodingAgentBackend(): CodingAgentBackend {
  const envBackend = import.meta.env?.VITE_CODING_AGENT_BACKEND
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

/**
 * Persists the given backend to localStorage so it survives page reloads.
 * Safe to call in non-browser environments; storage errors are ignored.
 */
export function persistCodingAgentBackend(backend: CodingAgentBackend): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CODING_AGENT_BACKEND_STORAGE_KEY, backend)
  } catch {
    // Ignore storage failures (quota, private mode, etc.).
  }
}

/**
 * Free models available through the Cline Free catalog.
 * Rendered as a selectable dropdown in the Cline ACP backend section
 * of the ProviderModelPicker.
 */
export interface ClineFreeModel {
  id: string
  name: string
  provider: string
  description: string
  contextWindow?: string
  tag?: string
}

export const CLINE_FREE_MODELS: ClineFreeModel[] = [
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    provider: 'Zhipu AI',
    description: 'Latest natively multimodal model in the GLM-5 series (Default)',
    tag: 'Default',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    description: 'Fast and efficient reasoning & code model with 1M context window',
    contextWindow: '1M',
    tag: '1M Context',
  },
  {
    id: 'cline-free/longcat-2.0',
    name: 'LongCat 2.0',
    provider: 'Cline Free',
    description: 'Trillion-parameter model built for agentic coding with 1M context window',
    contextWindow: '1M',
    tag: '1M Context',
  },
  {
    id: 'cline-free/solar-pro4',
    name: 'Solar Pro 4',
    provider: 'Cline Free',
    description: 'Strong model for office productivity, documents, and coding',
    tag: 'Coding',
  },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3',
    provider: 'Meta / Contributor',
    description: 'Multimodal reasoning model for agentic workflows & experimentation',
    tag: 'Multimodal',
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    name: 'Laguna S 2.1',
    provider: 'Poolside',
    description: 'Latest coding agent model from Poolside',
    tag: 'Agent',
  },
]

export const CODING_AGENT_CLINE_MODEL_STORAGE_KEY = 'coding-agent-cline-model'

/**
 * Persists the selected Cline free model to localStorage so it survives page reloads.
 * Safe to call in non-browser environments; storage errors are ignored.
 */
export function persistSelectedClineModel(model: string): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, model)
  } catch {
    // Ignore storage failures (quota, private mode, etc.).
  }
}

/**
 * Resolves the selected Cline free model from localStorage, falling back to
 * the provided fallback (or the Cline default model id) when nothing valid
 * is stored.
 */
export function resolveSelectedClineModel(fallback?: string): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY)
      if (stored && stored.trim().length > 0) return stored
    } catch {
      // Ignore storage failures and keep the fallback.
    }
  }

  return fallback || CLINE_DEFAULT_MODEL_ID
}

export function getBackendCapabilities(backend: CodingAgentBackend): BackendCapabilities {
  return BACKEND_CAPABILITIES[backend] ?? BACKEND_CAPABILITIES[DEFAULT_CODING_AGENT_BACKEND]
}

export interface PermissionOption {
  optionId: string
  name: string
  kind?: 'allow' | 'deny' | string
}

export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export interface AcpPermissionRequestPayload {
  runId: string
  sessionId: string
  requestId: string
  toolCallId: string
  title?: string
  options: PermissionOption[]
  kind?: string
  input?: Record<string, unknown>
  content?: unknown[]
  locations?: Array<{ path: string; line?: number }>
  command?: string
  filePath?: string
  diff?: string
}

/**
 * Describes a file edit surfaced by an ACP permission request, so the UI can
 * preview which file would be modified and how.
 */
export interface PermissionFileEdit {
  path: string
  line?: number
  startLine?: number
  endLine?: number
  diff?: string
  search?: string
  replace?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Returns the value as a trimmed, non-empty string, or null when not usable. */
function asTrimmedNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Returns the value when it is a string with non-whitespace content, or null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim().length > 0 ? value : null
}

/**
 * Extracts the command an ACP permission request wants to run, if any.
 * Checks the top-level `command` field and the `command`/`cmd` input fields.
 */
export function extractPermissionCommand(request: Partial<AcpPermissionRequestPayload>): string | null {
  if (!request) return null

  const directCommand = asTrimmedNonEmptyString(request.command)
  if (directCommand) return directCommand

  const input = asRecord(request.input)
  if (input) {
    const inputCommand =
      asTrimmedNonEmptyString(input.command) ?? asTrimmedNonEmptyString(input.cmd)
    if (inputCommand) return inputCommand
  }

  return null
}

/**
 * Extracts the file edit described by an ACP permission request, if any.
 * The path may come from `filePath`, the `path`/`filePath` input fields, or
 * the first entry of `locations`; the change body may come from `diff`, the
 * `diff`/`newContent` input fields, the `search`/`replace` input fields, or
 * ACP `content` diff blocks. Line numbers are extracted from `locations`.
 */
export function extractPermissionFileEdit(request: Partial<AcpPermissionRequestPayload>): PermissionFileEdit | null {
  if (!request) return null

  const input = asRecord(request.input)

  // Resolve the target path and optional line numbers from any supported location field.
  let path = asTrimmedNonEmptyString(request.filePath)
  let line: number | undefined = undefined
  let startLine: number | undefined = undefined
  let endLine: number | undefined = undefined

  if (!path && input) {
    path = asTrimmedNonEmptyString(input.path) ?? asTrimmedNonEmptyString(input.filePath)
    if (typeof input.line === 'number') line = input.line
  }

  if (Array.isArray(request.locations)) {
    for (const location of request.locations) {
      const locationRecord = asRecord(location)
      if (!locationRecord) continue
      const locationPath = asTrimmedNonEmptyString(locationRecord.path)
      if (!path && locationPath) {
        path = locationPath
      }
      if (typeof locationRecord.line === 'number') {
        line = locationRecord.line
      }
      if (typeof locationRecord.startLine === 'number') {
        startLine = locationRecord.startLine
      }
      if (typeof locationRecord.endLine === 'number') {
        endLine = locationRecord.endLine
      }
      const range = asRecord(locationRecord.range)
      if (range) {
        const start = asRecord(range.start)
        const end = asRecord(range.end)
        if (typeof start?.line === 'number') startLine = start.line
        if (typeof end?.line === 'number') endLine = end.line
      }
      if (path) break
    }
  }

  if (!path) return null

  let diff =
    asNonEmptyString(request.diff) ??
    (input ? asNonEmptyString(input.diff) ?? asNonEmptyString(input.newContent) : null)

  // Extract diff from ACP content blocks if not found in top-level or input
  if (!diff && Array.isArray(request.content)) {
    for (const block of request.content) {
      const b = asRecord(block)
      if (!b) continue
      if (b.type === 'diff' && typeof b.diff === 'string' && b.diff.trim().length > 0) {
        diff = b.diff
        break
      }
      if (
        typeof b.text === 'string' &&
        (b.text.includes('@@') || b.text.includes('---') || b.text.includes('+++'))
      ) {
        diff = b.text
        break
      }
    }
  }

  const search = input ? asNonEmptyString(input.search) : null
  const replace = input ? asNonEmptyString(input.replace) : null

  const edit: PermissionFileEdit = { path }
  if (line !== undefined) edit.line = line
  if (startLine !== undefined) edit.startLine = startLine
  if (endLine !== undefined) edit.endLine = endLine
  if (diff) edit.diff = diff
  if (search) edit.search = search
  if (replace) edit.replace = replace

  return edit
}
