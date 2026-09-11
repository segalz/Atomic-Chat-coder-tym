import { describe, expect, it, vi } from 'vitest'
import {
  isOllamaHealthCheckRequired,
  isOllamaRestartRequired,
  isSendBlockedByOllamaError,
  routeSendAgentPrompt,
  routeStopAgent,
  type ActiveRun,
  type InvokeFunction,
} from './backend-router'

describe('backend-router (Stage 09: Wire backend-specific routing)', () => {
  describe('Ollama gating functions', () => {
    it('applies Ollama health checks only to direct-ollama', () => {
      expect(isOllamaHealthCheckRequired('direct-ollama')).toBe(true)
      expect(isOllamaHealthCheckRequired('cline-acp')).toBe(false)
      expect(isOllamaHealthCheckRequired('code-agent' as any)).toBe(false)
    })

    it('applies Ollama restart on finish only to direct-ollama', () => {
      expect(isOllamaRestartRequired('direct-ollama')).toBe(true)
      expect(isOllamaRestartRequired('cline-acp')).toBe(false)
      expect(isOllamaRestartRequired('code-agent' as any)).toBe(false)
    })

    it('does not block send by Ollama errors when backend is cline-acp', () => {
      const ollamaErr = 'Ollama is not running. Start it with: ollama serve'
      expect(isSendBlockedByOllamaError('direct-ollama', ollamaErr)).toBe(true)
      expect(isSendBlockedByOllamaError('direct-ollama', null)).toBe(false)
      expect(isSendBlockedByOllamaError('cline-acp', ollamaErr)).toBe(false)
      expect(isSendBlockedByOllamaError('cline-acp', null)).toBe(false)
    })
  })

  describe('routeSendAgentPrompt', () => {
    it('routes to start_cline_agent when backend is cline-acp even if Ollama is unavailable', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        if (cmd.includes('ollama')) {
          throw new Error('Ollama service unavailable (connection refused)')
        }
        return {}
      }

      const result = await routeSendAgentPrompt(
        {
          backend: 'cline-acp',
          projectDir: '/test/workspace',
          prompt: 'Refactor this module',
          model: 'zai/glm-5.3-flash',
          sessionId: 'session-acp-1',
          activeRun: null,
        },
        mockInvoke
      )

      expect(result.success).toBe(true)
      expect(result.command).toBe('start_cline_agent')
      expect(result.activeRun.backend).toBe('cline-acp')
      expect(result.activeRun.sessionId).toBe('session-acp-1')
      expect(result.activeRun.runId).toMatch(/^run-/)

      // Verify no Ollama commands were called
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('start_cline_agent')
      expect(calls[0].args).toEqual({
        projectDir: '/test/workspace',
        prompt: 'Refactor this module',
        model: 'zai/glm-5.3-flash',
        runId: result.activeRun.runId,
        sessionId: 'session-acp-1',
      })
    })

    it('prevents cross-backend concurrent runs when direct-ollama is active', async () => {
      const mockInvoke: InvokeFunction = vi.fn().mockResolvedValue({})
      const activeRun: ActiveRun = {
        runId: 'run-active-1',
        backend: 'direct-ollama',
      }

      await expect(
        routeSendAgentPrompt(
          {
            backend: 'cline-acp',
            projectDir: '/test/workspace',
            prompt: 'Test prompt',
            activeRun,
          },
          mockInvoke
        )
      ).rejects.toThrow("An agent run is already active on backend 'direct-ollama'. Stop it first.")

      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('prevents cross-backend concurrent runs when cline-acp is active', async () => {
      const mockInvoke: InvokeFunction = vi.fn().mockResolvedValue({})
      const activeRun: ActiveRun = {
        runId: 'run-active-2',
        backend: 'cline-acp',
      }

      await expect(
        routeSendAgentPrompt(
          {
            backend: 'direct-ollama',
            projectDir: '/test/workspace',
            prompt: 'Test prompt',
            activeRun,
          },
          mockInvoke
        )
      ).rejects.toThrow("An agent run is already active on backend 'cline-acp'. Stop it first.")

      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('routes to start_ollama_agent when backend is direct-ollama', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const result = await routeSendAgentPrompt(
        {
          backend: 'direct-ollama',
          projectDir: '/test/workspace',
          prompt: 'Fix styling',
          model: 'qwen2.5-coder:7b',
          activeRun: null,
          ollamaBaseUrl: 'http://localhost:11434',
          editPermission: 'allowed',
          lspEnabled: true,
        },
        mockInvoke
      )

      expect(result.success).toBe(true)
      expect(result.command).toBe('start_ollama_agent')
      expect(result.activeRun.backend).toBe('direct-ollama')
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('start_ollama_agent')
      expect(calls[0].args).toMatchObject({
        projectDir: '/test/workspace',
        prompt: 'Fix styling',
        model: 'qwen2.5-coder:7b',
        ollamaBaseUrl: 'http://localhost:11434',
        editPermission: 'allowed',
        lspEnabled: true,
      })
    })

    it('preserves legacy routing for code-agent', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const result = await routeSendAgentPrompt(
        {
          backend: 'code-agent' as any,
          projectDir: '/test/workspace',
          prompt: 'Legacy task',
          model: 'legacy-model',
          activeRun: null,
        },
        mockInvoke
      )

      expect(result.success).toBe(true)
      expect(result.command).toBe('spawn_code_agent')
      expect(result.activeRun.backend).toBe('code-agent')
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('spawn_code_agent')
      expect(calls[0].args).toMatchObject({
        projectDir: '/test/workspace',
        prompt: 'Legacy task',
        ollamaModel: 'legacy-model',
        permissionMode: 'auto_accept',
      })
    })
  })

  describe('routeStopAgent', () => {
    it('stops active cline-acp run even if UI selection has changed to direct-ollama', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const activeRun: ActiveRun = {
        runId: 'run-cline-999',
        backend: 'cline-acp',
      }

      // UI dropdown was switched to direct-ollama while run was executing
      const result = await routeStopAgent(activeRun, 'direct-ollama', mockInvoke)

      expect(result.targetBackend).toBe('cline-acp')
      expect(result.command).toBe('stop_cline_agent')
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('stop_cline_agent')
      expect(calls[0].args).toEqual({ runId: 'run-cline-999' })
    })

    it('stops active direct-ollama run even if UI selection has changed to cline-acp', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const activeRun: ActiveRun = {
        runId: 'run-ollama-888',
        backend: 'direct-ollama',
      }

      // UI dropdown was switched to cline-acp while run was executing
      const result = await routeStopAgent(activeRun, 'cline-acp', mockInvoke)

      expect(result.targetBackend).toBe('direct-ollama')
      expect(result.command).toBe('stop_ollama_agent')
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('stop_ollama_agent')
    })

    it('stops active legacy run even if UI selection has changed to cline-acp', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const activeRun: ActiveRun = {
        runId: 'run-legacy-777',
        backend: 'code-agent' as any,
      }

      const result = await routeStopAgent(activeRun, 'cline-acp', mockInvoke)

      expect(result.command).toBe('stop_code_agent')
      expect(calls.length).toBe(1)
      expect(calls[0].cmd).toBe('stop_code_agent')
    })

    it('falls back to selected backend if no active run is tracked', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const mockInvoke: InvokeFunction = async (cmd, args) => {
        calls.push({ cmd, args })
        return {}
      }

      const result = await routeStopAgent(null, 'cline-acp', mockInvoke)

      expect(result.targetBackend).toBe('cline-acp')
      expect(result.command).toBe('stop_cline_agent')
      expect(calls[0].cmd).toBe('stop_cline_agent')
    })
  })
})
