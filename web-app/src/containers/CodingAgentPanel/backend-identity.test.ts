import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLINE_ACP_AGENT_NAME,
  CLINE_ACP_BACKEND,
  CLINE_DEFAULT_MODEL_DISPLAY_NAME,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_DEFAULT_MODEL_IDENTITY,
  CLINE_DEFAULT_PROVIDER_ID,
  CODING_AGENT_BACKEND_STORAGE_KEY,
  DEFAULT_CODING_AGENT_BACKEND,
  getBackendCapabilities,
  getInitialCodingAgentBackend,
  isCodingAgentBackend,
  resolveCodingAgentBackend,
} from './backend-identity'

describe('backend-identity (Stage 04)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('isCodingAgentBackend predicate', () => {
    it('accepts all valid backend identifiers', () => {
      expect(isCodingAgentBackend('direct-ollama')).toBe(true)
      expect(isCodingAgentBackend('legacy-claude')).toBe(true)
      expect(isCodingAgentBackend('cline-acp')).toBe(true)
    })

    it('rejects unrecognized or invalid strings', () => {
      expect(isCodingAgentBackend('ollama')).toBe(false)
      expect(isCodingAgentBackend('cline')).toBe(false)
      expect(isCodingAgentBackend('claude')).toBe(false)
      expect(isCodingAgentBackend('')).toBe(false)
      expect(isCodingAgentBackend('random-backend')).toBe(false)
    })

    it('rejects non-string values', () => {
      expect(isCodingAgentBackend(null)).toBe(false)
      expect(isCodingAgentBackend(undefined)).toBe(false)
      expect(isCodingAgentBackend(123)).toBe(false)
      expect(isCodingAgentBackend({})).toBe(false)
      expect(isCodingAgentBackend(['direct-ollama'])).toBe(false)
    })
  })

  describe('resolveCodingAgentBackend', () => {
    it('preserves valid legacy and current backend values', () => {
      expect(resolveCodingAgentBackend('direct-ollama')).toBe('direct-ollama')
      expect(resolveCodingAgentBackend('legacy-claude')).toBe('legacy-claude')
      expect(resolveCodingAgentBackend('cline-acp')).toBe('cline-acp')
    })

    it('resolves invalid, empty, or corrupted values to the direct-ollama default', () => {
      expect(resolveCodingAgentBackend(null)).toBe(DEFAULT_CODING_AGENT_BACKEND)
      expect(resolveCodingAgentBackend(undefined)).toBe(DEFAULT_CODING_AGENT_BACKEND)
      expect(resolveCodingAgentBackend('')).toBe(DEFAULT_CODING_AGENT_BACKEND)
      expect(resolveCodingAgentBackend('unknown-value')).toBe(DEFAULT_CODING_AGENT_BACKEND)
      expect(resolveCodingAgentBackend({ backend: 'direct-ollama' })).toBe(DEFAULT_CODING_AGENT_BACKEND)
    })

    it('honors custom fallback when provided', () => {
      expect(resolveCodingAgentBackend('corrupted', 'legacy-claude')).toBe('legacy-claude')
      expect(resolveCodingAgentBackend(null, 'cline-acp')).toBe('cline-acp')
    })
  })

  describe('getInitialCodingAgentBackend', () => {
    it('defaults to direct-ollama when localStorage is empty', () => {
      expect(getInitialCodingAgentBackend()).toBe('direct-ollama')
    })

    it('loads persisted legacy-claude backend from localStorage', () => {
      localStorage.setItem(CODING_AGENT_BACKEND_STORAGE_KEY, 'legacy-claude')
      expect(getInitialCodingAgentBackend()).toBe('legacy-claude')
    })

    it('loads persisted direct-ollama backend from localStorage', () => {
      localStorage.setItem(CODING_AGENT_BACKEND_STORAGE_KEY, 'direct-ollama')
      expect(getInitialCodingAgentBackend()).toBe('direct-ollama')
    })

    it('loads persisted cline-acp backend from localStorage', () => {
      localStorage.setItem(CODING_AGENT_BACKEND_STORAGE_KEY, 'cline-acp')
      expect(getInitialCodingAgentBackend()).toBe('cline-acp')
    })

    it('safely falls back to direct-ollama on invalid localStorage values', () => {
      localStorage.setItem(CODING_AGENT_BACKEND_STORAGE_KEY, 'invalid-backend-name')
      expect(getInitialCodingAgentBackend()).toBe('direct-ollama')
    })
  })

  describe('Cline ACP model and provider identity contract', () => {
    it('defines the frozen contract identities', () => {
      expect(CLINE_ACP_BACKEND).toBe('cline-acp')
      expect(CLINE_ACP_AGENT_NAME).toBe('cline')
      expect(CLINE_DEFAULT_MODEL_ID).toBe('zai/glm-5.3-flash')
      expect(CLINE_DEFAULT_MODEL_DISPLAY_NAME).toBe('GLM 5.3 Flash')
      expect(CLINE_DEFAULT_PROVIDER_ID).toBe('zai')
    })

    it('provides correct default ModelIdentity object', () => {
      expect(CLINE_DEFAULT_MODEL_IDENTITY).toEqual({
        backend: 'cline-acp',
        modelId: 'zai/glm-5.3-flash',
        displayName: 'GLM 5.3 Flash',
        providerId: 'zai',
        agentName: 'cline',
      })
    })
  })

  describe('Backend capabilities matrix', () => {
    it('reports expected capabilities for direct-ollama', () => {
      const caps = getBackendCapabilities('direct-ollama')
      expect(caps.tools).toBe(true)
      expect(caps.streaming).toBe(true)
      expect(caps.thinking).toBe(true)
      expect(caps.diffApproval).toBe(true)
      expect(caps.loadSession).toBe(false)
      expect(caps.cancel).toBe(true)
      expect(caps.requestPermissions).toBe(false)
    })

    it('reports expected capabilities for legacy-claude', () => {
      const caps = getBackendCapabilities('legacy-claude')
      expect(caps.tools).toBe(true)
      expect(caps.streaming).toBe(true)
      expect(caps.diffApproval).toBe(true)
      expect(caps.loadSession).toBe(false)
    })

    it('reports expected capabilities for cline-acp', () => {
      const caps = getBackendCapabilities('cline-acp')
      expect(caps.tools).toBe(true)
      expect(caps.streaming).toBe(true)
      expect(caps.thinking).toBe(true)
      expect(caps.diffApproval).toBe(false)
      expect(caps.loadSession).toBe(true)
      expect(caps.cancel).toBe(true)
      expect(caps.requestPermissions).toBe(true)
    })
  })
})
