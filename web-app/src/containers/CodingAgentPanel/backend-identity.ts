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


export function getBackendCapabilities(backend: CodingAgentBackend): BackendCapabilities {
  return BACKEND_CAPABILITIES[backend] ?? BACKEND_CAPABILITIES[DEFAULT_CODING_AGENT_BACKEND]
}
