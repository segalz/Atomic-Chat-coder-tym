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
  extractPermissionCommand,
  extractPermissionFileEdit,
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
  describe('extractPermissionCommand & extractPermissionFileEdit', () => {
    describe('extractPermissionCommand', () => {
      it('extracts the command from the top-level command field', () => {
        expect(extractPermissionCommand({ command: 'npm test' })).toBe('npm test')
      })

      it('extracts the command from input.command and input.cmd', () => {
        expect(extractPermissionCommand({ input: { command: 'pnpm lint' } })).toBe('pnpm lint')
        expect(extractPermissionCommand({ input: { cmd: 'cargo build' } })).toBe('cargo build')
        expect(extractPermissionCommand({ input: { command: '', cmd: 'fallback' } })).toBe('fallback')
      })

      it('prefers the top-level command over input fields', () => {
        expect(
          extractPermissionCommand({ command: 'top-level', input: { command: 'input-level' } })
        ).toBe('top-level')
      })

      it('trims surrounding whitespace from the command', () => {
        expect(extractPermissionCommand({ command: '   npm run build   ' })).toBe('npm run build')
        expect(extractPermissionCommand({ input: { cmd: '\tmake all\n' } })).toBe('make all')
      })

      it('returns null when no command is present', () => {
        expect(extractPermissionCommand({})).toBe(null)
        expect(extractPermissionCommand({ input: { foo: 'bar' } })).toBe(null)
      })

      it('returns null when the command is empty or whitespace-only', () => {
        expect(extractPermissionCommand({ command: '' })).toBe(null)
        expect(extractPermissionCommand({ command: '   ' })).toBe(null)
        expect(extractPermissionCommand({ input: { command: '' } })).toBe(null)
        expect(extractPermissionCommand({ input: { cmd: '' } })).toBe(null)
      })
    })

    describe('extractPermissionFileEdit', () => {
      it('extracts the path from filePath and the diff from diff', () => {
        expect(
          extractPermissionFileEdit({ filePath: 'src/app.ts', diff: '@@ -1,2 +1,3 @@' })
        ).toEqual({ path: 'src/app.ts', diff: '@@ -1,2 +1,3 @@' })
      })

      it('extracts the path from input.path and input.filePath', () => {
        expect(extractPermissionFileEdit({ input: { path: 'src/b.ts' } })).toEqual({
          path: 'src/b.ts',
        })
        expect(extractPermissionFileEdit({ input: { filePath: 'src/c.ts' } })).toEqual({
          path: 'src/c.ts',
        })
      })

      it('extracts the path from the first usable locations entry', () => {
        expect(
          extractPermissionFileEdit({
            locations: [
              { path: 'src/first.ts' },
              { path: 'src/second.ts' },
            ],
          })
        ).toEqual({ path: 'src/first.ts' })
      })

      it('extracts the diff from input.diff and input.newContent', () => {
        expect(
          extractPermissionFileEdit({ input: { path: 'src/d.ts', diff: '-old\n+new' } })
        ).toEqual({ path: 'src/d.ts', diff: '-old\n+new' })
        expect(
          extractPermissionFileEdit({ input: { path: 'src/e.ts', newContent: 'export const x = 1' } })
        ).toEqual({ path: 'src/e.ts', diff: 'export const x = 1' })
      })

      it('synthesizes the edit body from input.search and input.replace', () => {
        expect(
          extractPermissionFileEdit({
            input: { path: 'src/f.ts', search: 'const old', replace: 'const next' },
          })
        ).toEqual({ path: 'src/f.ts', search: 'const old', replace: 'const next' })
      })

      it('extracts diff from ACP content blocks when top-level or input diff is absent', () => {
        expect(
          extractPermissionFileEdit({
            filePath: 'src/content-diff.ts',
            content: [{ type: 'diff', diff: '@@ -10,3 +10,4 @@' }],
          })
        ).toEqual({ path: 'src/content-diff.ts', diff: '@@ -10,3 +10,4 @@' })

        expect(
          extractPermissionFileEdit({
            filePath: 'src/content-patch.ts',
            content: [{ type: 'text', text: '--- a/src/content-patch.ts\n+++ b/src/content-patch.ts\n@@ -1 +1 @@' }],
          })
        ).toEqual({
          path: 'src/content-patch.ts',
          diff: '--- a/src/content-patch.ts\n+++ b/src/content-patch.ts\n@@ -1 +1 @@',
        })
      })

      it('extracts line and range information from locations', () => {
        expect(
          extractPermissionFileEdit({
            locations: [{ path: 'src/line-test.ts', line: 42 }],
          })
        ).toEqual({ path: 'src/line-test.ts', line: 42 })

        expect(
          extractPermissionFileEdit({
            locations: [{ path: 'src/range-test.ts', startLine: 10, endLine: 25 }],
          })
        ).toEqual({ path: 'src/range-test.ts', startLine: 10, endLine: 25 })

        expect(
          extractPermissionFileEdit({
            locations: [
              {
                path: 'src/nested-range.ts',
                range: { start: { line: 5 }, end: { line: 15 } },
              },
            ],
          })
        ).toEqual({ path: 'src/nested-range.ts', startLine: 5, endLine: 15 })
      })

      it('keeps the path when no diff body is available', () => {
        expect(extractPermissionFileEdit({ filePath: 'src/standalone.ts' })).toEqual({
          path: 'src/standalone.ts',
        })
      })

      it('trims whitespace from resolved paths', () => {
        expect(extractPermissionFileEdit({ filePath: '  src/trim.ts  ' })).toEqual({
          path: 'src/trim.ts',
        })
      })

      it('returns null when neither a path nor a diff can be resolved', () => {
        expect(extractPermissionFileEdit({})).toBe(null)
        expect(extractPermissionFileEdit({ input: { diff: 'diff body without a target file' } })).toBe(
          null
        )
        expect(extractPermissionFileEdit({ locations: [] })).toBe(null)
      })
    })
  })
})
