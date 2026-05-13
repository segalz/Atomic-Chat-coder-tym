import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCodingAgentStore, type ExecLogLine } from '@/stores/coding-agent-store'
import { useThreads } from '@/hooks/useThreads'
import { Button } from '@/components/ui/button'
import {
  IconFolderOpen,
  IconPlayerStop,
  IconArrowUp,
  IconTrash,
  IconX,
  IconLoader2,
  IconAlertCircle,
  IconRefresh,
  IconTerminal2,
  IconFileCode,
  IconCpu,
  IconCloudDownload,
  IconCircleCheck,
  IconClock,
} from '@tabler/icons-react'

import { StickToBottom } from 'use-stick-to-bottom'
import { ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import {
  getInitialCodingAgentBackend,
  normalizeCompatDiffProposed,
  normalizeCompatToolResult,
  normalizeCompatToolStart,
  normalizeDirectDiffProposed,
  normalizeDirectToolResult,
  normalizeDirectToolStart,
  normalizeDone,
  normalizeError,
  normalizeLegacyCodeAgentOutput,
  normalizeTextDelta,
  type AgentDonePayload,
  type AgentErrorPayload,
  type CodingAgentBackend,
  type CompatDiffProposedPayload,
  type CompatToolResultPayload,
  type CompatToolStartPayload,
  type DirectDiffProposedPayload,
  type DirectToolResultPayload,
  type DirectToolStartPayload,
  type NormalizedAgentEvent,
  type TextDeltaPayload,
} from './agent-event-adapter'

// ── S6 types ─────────────────────────────────────────────────
interface CodingAgentConfig {
  ollama_url: string
  code_model: string
  vision_model: string
  max_iterations: number
  auto_verify: boolean
}

interface GpuInfo {
  name: string
  total_memory: number // MiB
}

interface SystemInfo {
  total_memory: number // MiB (unified memory on Apple Silicon)
  gpus: GpuInfo[]
}

// Minimum VRAM requirements in GiB for known model families
const MODEL_VRAM_GIB: Record<string, number> = {
  'qwen2.5-coder:32b': 20,
  'deepseek-coder-v2:16b': 9,
  'qwen2.5-coder:14b': 9,
  'qwen2.5-coder:7b': 5,
  'qwen2.5vl:7b': 5,
  'qwen2.5-vl:7b': 5,
}

function vramRequiredGib(model: string): number {
  for (const [key, gib] of Object.entries(MODEL_VRAM_GIB)) {
    if (model.startsWith(key) || model === key) return gib
  }
  // Estimate from model size suffix
  const m = model.match(/:(\d+)b/i)
  if (m) return Math.ceil(Number(m[1]) * 0.65)
  return 0
}

// ── HardwareSetup component ───────────────────────────────────
function HardwareSetup({ ollamaUrl }: { ollamaUrl: string }) {
  const [config, setConfig] = useState<CodingAgentConfig | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [installedModels, setInstalledModels] = useState<string[]>([])
  const [pulling, setPulling] = useState<Record<string, boolean>>({})
  const [pullProgress, setPullProgress] = useState<Record<string, string>>({})

  useEffect(() => {
    invoke<CodingAgentConfig>('get_coding_agent_config').then(setConfig).catch(() => {})
    invoke<SystemInfo>('plugin:hardware|get_system_info').then(setSysInfo).catch(() => {})
    invoke<string[]>('list_ollama_models').then(setInstalledModels).catch(() => {})
  }, [])

  const effectiveVramMib = sysInfo
    ? sysInfo.gpus.length > 0
      ? Math.max(...sysInfo.gpus.map((g) => g.total_memory))
      : sysInfo.total_memory // Apple Silicon unified memory
    : 0

  const effectiveVramGib = effectiveVramMib / 1024

  const handlePull = useCallback(async (model: string) => {
    setPulling((p) => ({ ...p, [model]: true }))
    setPullProgress((p) => ({ ...p, [model]: 'Starting…' }))
    try {
      await invoke('pull_ollama_model', { modelId: model, ollamaUrl })
      setInstalledModels((prev) => (prev.includes(model) ? prev : [...prev, model]))
      setPullProgress((p) => ({ ...p, [model]: 'Done' }))
    } catch (err) {
      setPullProgress((p) => ({ ...p, [model]: `Error: ${err}` }))
    } finally {
      setPulling((p) => ({ ...p, [model]: false }))
    }
  }, [ollamaUrl])

  if (!config) return null

  const modelsToCheck = [
    { label: 'Code model', name: config.code_model },
    { label: 'Vision model', name: config.vision_model },
  ]

  return (
    <div className="px-3 py-2 border-b space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <IconCpu size={11} />
        Hardware
      </div>

      {sysInfo && (
        <div className="text-[11px] text-muted-foreground">
          {sysInfo.gpus.length > 0 ? (
            sysInfo.gpus.map((g) => (
              <div key={g.name} className="flex justify-between">
                <span className="truncate max-w-[110px]" title={g.name}>{g.name}</span>
                <span className="font-mono">{(g.total_memory / 1024).toFixed(0)} GB VRAM</span>
              </div>
            ))
          ) : (
            <div className="flex justify-between">
              <span>Unified Memory</span>
              <span className="font-mono">{(sysInfo.total_memory / 1024).toFixed(0)} GB</span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {modelsToCheck.map(({ label, name }) => {
          const installed = installedModels.some((m) => m === name || m.startsWith(name.split(':')[0]))
          const required = vramRequiredGib(name)
          const tooLarge = required > 0 && effectiveVramGib > 0 && required > effectiveVramGib
          const progress = pullProgress[name]

          return (
            <div key={name} className="rounded border bg-background/50 px-2 py-1.5 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground/70">{label}</span>
                {installed && <IconCircleCheck size={11} className="text-green-500 ml-auto" />}
              </div>
              <div className="font-mono text-[10px] text-foreground/80 truncate" title={name}>{name}</div>
              {tooLarge && (
                <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                  <IconAlertCircle size={11} />
                  Needs ~{required} GB — you have {effectiveVramGib.toFixed(0)} GB
                </div>
              )}
              {!installed && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 w-full gap-1 text-[10px] mt-0.5"
                  disabled={pulling[name]}
                  onClick={() => handlePull(name)}
                >
                  {pulling[name] ? (
                    <IconLoader2 size={10} className="animate-spin" />
                  ) : (
                    <IconCloudDownload size={10} />
                  )}
                  {progress ?? 'Pull model'}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

type AgentStatus = 'idle' | 'running' | 'restarting' | 'free' | 'failed'

function formatTerminalMessage(success: boolean, errorMessage?: string | null): string {
  if (success) return '✓ Agent finished'

  const message = errorMessage?.trim()
  if (!message) return '✗ Agent stopped'

  if (/idle timeout|max(?:imum)? runtime|timed out|timeout/i.test(message)) {
    return `✗ Agent stalled: ${message}`
  }

  return `✗ ${message}`
}

export function CodingAgentPanel() {
  const createThread = useThreads((s) => s.createThread)
  const {
    projectDir, setProjectDir,
    draftPrompt, setDraftPrompt,
    isRunning, setRunning,
    appendPlanText,
    execLog, appendLog,
    addDiff,
    pendingDiffs,
    startNewSession, loadSession, deleteSession,
    sessions,
  } = useCodingAgentStore()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const completionHandledRef = useRef(false)
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)
  const [isRestartingOllama, setIsRestartingOllama] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [lastFailureMessage, setLastFailureMessage] = useState<string | null>(null)
  const lastAgentErrorRef = useRef<string | null>(null)

  // ── Loop scheduler ────────────────────────────────────────
  const [loopPopoverOpen, setLoopPopoverOpen] = useState(false)
  const [loopTimes, setLoopTimes] = useState(3)
  const [loopInterval, setLoopInterval] = useState(5)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [loopCount, setLoopCount] = useState(0)
  const [loopPrompt, setLoopPrompt] = useState('')
  const [loopCountdown, setLoopCountdown] = useState<number | null>(null)
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loopTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [agentConfig, setAgentConfig] = useState<CodingAgentConfig | null>(null)
  const [agentBackend] = useState<CodingAgentBackend>(() => getInitialCodingAgentBackend())

  useEffect(() => {
    invoke<CodingAgentConfig>('get_coding_agent_config').then(setAgentConfig).catch(() => {})
  }, [])

  // ── Pre-flight Ollama check ───────────────────────────────
  const checkOllama = useCallback(async () => {
    setIsCheckingOllama(true)
    setOllamaError(null)
    try {
      await invoke('check_ollama')
      const healthy = await invoke<boolean>('check_ollama_health')
      if (!healthy) setOllamaError('Ollama is not running. Start it with: ollama serve')
    } catch (err) {
      setOllamaError(String(err))
    } finally {
      setIsCheckingOllama(false)
    }
  }, [])

  const restartOllama = useCallback(async () => {
    setIsRestartingOllama(true)
    setOllamaError(null)
    try {
      await invoke('restart_ollama')
      await checkOllama()
    } catch (err) {
      setOllamaError(String(err))
    } finally {
      setIsRestartingOllama(false)
    }
  }, [checkOllama])

  useEffect(() => { checkOllama() }, [checkOllama])

  const clearLoopSchedule = useCallback(() => {
    clearTimeout(loopTimerRef.current!)
    clearInterval(loopTickRef.current!)
    setLoopCountdown(null)
  }, [])

  const finishAgentRun = useCallback((success: boolean, errorMessage?: string | null) => {
    const terminalMessage = formatTerminalMessage(success, errorMessage)

    setRunning(false)
    appendLog({
      type: success ? 'done' : 'error',
      content: terminalMessage,
      timestamp: Date.now(),
    })

    if (!success) {
      setLastFailureMessage(terminalMessage)
      if (loopEnabled) {
        clearLoopSchedule()
        setLoopEnabled(false)
        setLoopPrompt('')
        appendLog({
          type: 'error',
          content: 'Loop stopped after failed agent run.',
          timestamp: Date.now(),
        })
      }
    }

    useCodingAgentStore.getState().saveCurrentSession()
    setAgentStatus('restarting')
    invoke('restart_ollama').catch(() => {}).finally(() => setAgentStatus(success ? 'free' : 'failed'))
  }, [appendLog, clearLoopSchedule, loopEnabled, setRunning])

  const handleNormalizedAgentEvent = useCallback((event: NormalizedAgentEvent) => {
    switch (event.type) {
      case 'text_delta':
        appendPlanText(event.text)
        if (event.text.trim()) {
          appendLog({
            type: 'text_delta',
            content: event.text,
            timestamp: Date.now(),
          })
        }
        break
      case 'thinking':
        if (event.text.trim()) {
          appendLog({
            type: 'thinking',
            content: event.text,
            timestamp: Date.now(),
          })
        }
        break
      case 'tool_start':
        appendLog({
          type: 'tool_start',
          content: JSON.stringify(event.input),
          toolName: event.name,
          timestamp: Date.now(),
        })
        break
      case 'tool_result':
        appendLog({
          type: 'tool_result',
          content: event.isError ? `Error: ${event.output}` : event.output,
          toolName: event.name,
          timestamp: Date.now(),
        })
        break
      case 'diff_proposed':
        addDiff({
          id: event.id,
          filePath: event.filePath,
          search: event.search,
          replace: event.replace,
          status: 'pending',
        })
        appendLog({
          type: 'text_delta',
          content: `Diff proposed for ${event.filePath} — awaiting approval`,
          timestamp: Date.now(),
        })
        break
      case 'done':
        if (completionHandledRef.current) return
        completionHandledRef.current = true
        finishAgentRun(event.success, event.success ? null : (event.error ?? lastAgentErrorRef.current ?? 'Agent stopped by user'))
        break
      case 'error':
        lastAgentErrorRef.current = event.message
        appendLog({ type: 'error', content: event.message, timestamp: Date.now() })
        break
    }
  }, [addDiff, appendLog, appendPlanText, finishAgentRun])

  // ── Subscribe to normalized backend events ───────────────
  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []

    const setup = async () => {
      const u1 = await listen<TextDeltaPayload>('coding-agent-text-delta', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeTextDelta(e.payload))
      })

      const u2 = await listen<CompatToolStartPayload>('coding-agent-tool-start', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeCompatToolStart(e.payload))
      })

      const u3 = await listen<CompatToolResultPayload>('coding-agent-tool-result', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeCompatToolResult(e.payload))
      })

      const u4 = await listen<CompatDiffProposedPayload>('coding-agent-diff-proposed', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeCompatDiffProposed(e.payload))
      })

      const uRaw = await listen<{ line: string }>('code-agent-output', (e) => {
        if (cancelled) return
        normalizeLegacyCodeAgentOutput(e.payload.line).forEach(handleNormalizedAgentEvent)
      })

      const u5 = await listen<AgentDonePayload>('code-agent-done', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeDone(e.payload))
      })

      const u6 = await listen<AgentErrorPayload>('coding-agent-error', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeError(e.payload))
      })
      const u7 = await listen<AgentErrorPayload>('code-agent-error', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeError(e.payload))
      })
      const u8 = await listen<TextDeltaPayload>('agent-text-delta', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeTextDelta(e.payload))
      })
      const u9 = await listen<DirectToolStartPayload>('agent-tool-call-start', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeDirectToolStart(e.payload))
      })
      const u10 = await listen<DirectToolResultPayload>('agent-tool-call-result', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeDirectToolResult(e.payload))
      })
      const u11 = await listen<DirectDiffProposedPayload>('agent-diff-proposed', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeDirectDiffProposed(e.payload))
      })
      const u12 = await listen<AgentDonePayload>('agent-done', (e) => {
        if (!cancelled) handleNormalizedAgentEvent(normalizeDone(e.payload))
      })

      if (cancelled) {
        for (const unlisten of [uRaw, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12]) unlisten()
      } else {
        unlisteners.push(uRaw, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12)
      }
    }

    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [handleNormalizedAgentEvent])

  // ── Handlers ─────────────────────────────────────────────
  const stopSelectedBackend = useCallback(async () => {
    if (agentBackend === 'direct-ollama') {
      await invoke('stop_ollama_agent')
      return
    }

    await invoke('stop_code_agent')
  }, [agentBackend])

  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: { directory: true, title: 'Select Project Folder' },
      })
      if (selected) setProjectDir(selected)
    } catch (err) {
      console.error('Folder dialog error:', err)
    }
  }, [setProjectDir])

  const sendPrompt = useCallback(async (prompt: string) => {
    if (!projectDir || !prompt.trim()) return

    let threadId: string | undefined
    try {
      const newThread = await createThread(
        { id: agentConfig?.code_model ?? 'qwen2.5-coder:32b', provider: 'ollama' },
        prompt
      )
      threadId = newThread.id
    } catch (err) {
      console.warn('Failed to create thread for code agent session:', err)
    }

    startNewSession(prompt, threadId)
    completionHandledRef.current = false
    lastAgentErrorRef.current = null
    setLastFailureMessage(null)
    setRunning(true)
    setAgentStatus('running')
    appendLog({ type: 'text_delta', content: `> ${prompt}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: `Backend: ${agentBackend}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: 'Starting agent…', timestamp: Date.now() })

    try {
      const model = agentConfig?.code_model ?? 'qwen2.5-coder:32b'

      if (agentBackend === 'direct-ollama') {
        await invoke('start_ollama_agent', {
          projectDir,
          prompt,
          model,
          ollamaBaseUrl: agentConfig?.ollama_url ?? 'http://localhost:11434',
        })
      } else {
        await invoke('spawn_code_agent', {
          projectDir,
          prompt,
          ollamaModel: model,
          permissionMode: 'auto_accept',
        })
      }
    } catch (err) {
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
      setRunning(false)
      if (loopEnabled) {
        clearLoopSchedule()
        setLoopEnabled(false)
        setLoopPrompt('')
        appendLog({
          type: 'error',
          content: 'Loop stopped after failed agent run.',
          timestamp: Date.now(),
        })
      }
      setLastFailureMessage(`✗ ${String(err)}`)
      setAgentStatus('idle')
    }
  }, [projectDir, agentConfig, agentBackend, createThread, setRunning, appendLog, startNewSession, loopEnabled, clearLoopSchedule])

  const handleSend = useCallback(async () => {
    if (!projectDir || !draftPrompt.trim()) return
    const prompt = draftPrompt
    setDraftPrompt('')
    if (loopEnabled) {
      setLoopCount(1)
      setLoopPrompt(prompt)
    }
    await sendPrompt(prompt)
  }, [projectDir, draftPrompt, loopEnabled, setDraftPrompt, sendPrompt])

  // ── Loop trigger ──────────────────────────────────────────
  useEffect(() => {
    if (agentStatus !== 'free' || !loopEnabled) return

    // All runs done — reset everything
    if (loopCount >= loopTimes) {
      setLoopEnabled(false)
      setLoopCount(0)
      setLoopPrompt('')
      return
    }

    const seconds = loopInterval * 60
    setLoopCountdown(seconds)

    loopTickRef.current = setInterval(() => {
      setLoopCountdown((s) => (s !== null && s > 1 ? s - 1 : null))
    }, 1000)

    loopTimerRef.current = setTimeout(async () => {
      clearInterval(loopTickRef.current!)
      setLoopCountdown(null)
      setLoopCount((c) => c + 1)
      await sendPrompt(loopPrompt)
    }, seconds * 1000)

    return () => {
      clearTimeout(loopTimerRef.current!)
      clearInterval(loopTickRef.current!)
    }
  }, [agentStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(async () => {
    try { await stopSelectedBackend() } catch { /* ignore */ }
    setRunning(false)
    setLoopEnabled(false)
    setLoopCountdown(null)
    clearTimeout(loopTimerRef.current!)
    clearInterval(loopTickRef.current!)
    setLastFailureMessage(null)
  }, [setRunning, stopSelectedBackend])

  const handleApproveDiff = useCallback(async (id: string) => {
    try {
      await invoke('approve_agent_diff', { callId: id })
      useCodingAgentStore.getState().updateDiffStatus(id, 'approved')
    } catch (err) {
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
    }
  }, [appendLog])

  const handleRejectDiff = useCallback(async (id: string) => {
    try {
      await invoke('reject_agent_diff', { callId: id })
      useCodingAgentStore.getState().updateDiffStatus(id, 'rejected')
    } catch (err) {
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
    }
  }, [appendLog])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    },
    [handleSend]
  )

  const folderName = projectDir ? projectDir.split('/').pop() : null

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: Project picker ──────────────────────────── */}
      <aside className="w-56 shrink-0 border-r flex flex-col bg-muted/20">
        <div className="px-3 py-3 border-b">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSelectFolder}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
          >
            <IconFolderOpen size={15} />
            <span className="truncate">{folderName ?? 'Select project'}</span>
          </Button>
          {projectDir && (
            <p className="mt-1 text-[10px] text-muted-foreground/60 truncate px-0.5" title={projectDir}>
              {projectDir}
            </p>
          )}
        </div>
        <HardwareSetup ollamaUrl="http://localhost:11434" />
        <div className="flex-1 overflow-auto flex flex-col min-h-0">
          {/* Session history */}
          {sessions.length > 0 && (
            <div className="shrink-0 border-b">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                History
              </div>
              <ul className="max-h-40 overflow-y-auto">
                {sessions.map((s) => (
                  <li key={s.id} className="group flex items-center gap-1 px-2 py-1 hover:bg-muted/40">
                    <button
                      type="button"
                      className="flex-1 text-left text-xs text-muted-foreground truncate"
                      onClick={() => loadSession(s.id)}
                      title={s.prompt}
                    >
                      {s.prompt.length > 40 ? s.prompt.slice(0, 40) + '…' : s.prompt}
                    </button>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-destructive shrink-0"
                      onClick={() => deleteSession(s.id)}
                    >
                      <IconX size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex-1 overflow-auto px-3 py-2">
            {projectDir ? (
              <ProjectFileTree projectDir={projectDir} />
            ) : (
              <p className="text-xs text-muted-foreground/50 text-center mt-8">
                Select a project folder to begin
              </p>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main: Log + input ────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Ollama error banner */}
        {ollamaError && (
          <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-3 shrink-0">
            <IconAlertCircle size={16} className="text-destructive shrink-0" />
            <p className="flex-1 text-sm text-destructive truncate">{ollamaError}</p>
            <Button
              size="sm" variant="outline"
              onClick={checkOllama} disabled={isCheckingOllama}
              className="h-7 gap-1.5 text-destructive border-destructive/20 hover:bg-destructive/10"
            >
              <IconRefresh size={13} className={isCheckingOllama ? 'animate-spin' : ''} />
              Retry
            </Button>
          </div>
        )}

        {/* Execution log — takes all available height */}
        <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0 bg-muted/10">
          <IconTerminal2 size={14} className="text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Log</span>
          <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          {agentStatus === 'running' && (
            <span className="text-xs text-green-500 font-mono">running</span>
          )}
          {agentStatus === 'restarting' && (
            <span className="text-xs text-yellow-500 font-mono animate-pulse">ollama restart</span>
          )}
          {agentStatus === 'free' && !isRunning && (
            <span className="text-xs text-green-500 font-mono">memory free</span>
          )}
          {agentStatus === 'failed' && !isRunning && (
            <span className="text-xs text-destructive font-mono">failed</span>
          )}
          {loopEnabled && (
            <span className="flex items-center gap-1 ml-1">
              <span className="text-xs text-blue-500 font-mono">
                {loopCount}/{loopTimes}
                {loopCountdown !== null && ` · ${Math.floor(loopCountdown / 60)}:${String(loopCountdown % 60).padStart(2, '0')}`}
              </span>
              <button
                type="button"
                className="text-destructive hover:text-destructive/80 shrink-0"
                title="Stop loop"
                onClick={() => {
                  clearTimeout(loopTimerRef.current!)
                  clearInterval(loopTickRef.current!)
                  setLoopEnabled(false)
                  setLoopCount(0)
                  setLoopPrompt('')
                  setLoopCountdown(null)
                  setLoopTimes(3)
                  setLoopInterval(5)
                  stopSelectedBackend().catch(() => {})
                  setRunning(false)
                  setLastFailureMessage(null)
                }}
              >
                <IconPlayerStop size={11} />
              </button>
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!isRunning && (
              <Button
                size="sm" variant="ghost"
                className="h-6 text-xs gap-1 text-muted-foreground"
                onClick={restartOllama}
                disabled={isRestartingOllama}
                title="Restart Ollama to free memory"
              >
                <IconRefresh size={12} className={isRestartingOllama ? 'animate-spin' : ''} />
                {isRestartingOllama ? 'Restarting…' : 'Restart'}
              </Button>
            )}
            {execLog.length > 0 && (
              <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 text-muted-foreground" onClick={() => useCodingAgentStore.getState().clearSession()}>
                <IconTrash size={12} /> Clear
              </Button>
            )}
          </div>
        </div>
        {lastFailureMessage && !isRunning && (
          <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-2 shrink-0">
            <IconAlertCircle size={15} className="text-destructive shrink-0" />
            <p className="text-xs text-destructive truncate" title={lastFailureMessage}>
              {lastFailureMessage}
            </p>
          </div>
        )}
        <div className="relative flex-1 min-h-0">
          <StickToBottom className="absolute inset-0 overflow-y-hidden" initial="smooth" resize="smooth">
            <StickToBottom.Content className="px-4 py-3 space-y-0.5">
              {execLog.length === 0 && !isRunning && (
                <p className="text-sm text-muted-foreground/50 text-center mt-16">
                  {projectDir ? 'Describe what to build or fix below.' : 'Select a project folder to begin.'}
                </p>
              )}
              {execLog.map((line, i) => (
                <LogLine key={i} line={line} />
              ))}
              {isRunning && (
                <div className="text-xs text-muted-foreground py-1">
                  <Shimmer duration={1.2}>Running…</Shimmer>
                </div>
              )}
            </StickToBottom.Content>
            <ConversationScrollButton />
          </StickToBottom>
        </div>

        {/* Input */}
        <div className="shrink-0 px-4 pb-4 pt-3 border-t">
          <div className="relative flex items-end rounded-xl border bg-background shadow-sm">
            <textarea
              ref={textareaRef}
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                ollamaError ? 'Ollama required' :
                projectDir ? 'Describe what to build or fix…' :
                'Select a project folder first'
              }
              disabled={!projectDir || isRunning || !!ollamaError}
              className="flex-1 resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              rows={3}
              style={{ maxHeight: '200px', fieldSizing: 'content' } as React.CSSProperties}
            />
            <div className="flex items-center gap-1 px-3 py-3">
              {/* Loop scheduler button */}
              {!isRunning && (
                <div className="relative">
                  <Button
                    size="icon-sm" variant={loopEnabled ? 'default' : 'ghost'}
                    className="rounded-full"
                    onClick={() => setLoopPopoverOpen((v) => !v)}
                    title="Schedule loop"
                  >
                    <IconClock size={14} />
                  </Button>
                  {loopPopoverOpen && (
                    <div className="absolute bottom-full right-0 mb-2 w-52 rounded-xl border bg-background shadow-lg p-3 z-50 flex flex-col gap-2">
                      <p className="text-xs font-semibold text-foreground">Loop scheduler</p>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">Times (total runs)</span>
                        <input
                          type="number" min={1} max={100}
                          value={loopTimes}
                          onChange={(e) => setLoopTimes(Math.max(1, Number(e.target.value)))}
                          className="rounded-md border bg-muted px-2 py-1 text-sm outline-none w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">Loop time (minutes)</span>
                        <input
                          type="number" min={1} max={1440}
                          value={loopInterval}
                          onChange={(e) => setLoopInterval(Math.max(1, Number(e.target.value)))}
                          className="rounded-md border bg-muted px-2 py-1 text-sm outline-none w-full"
                        />
                      </label>
                      <Button
                        size="sm" className="w-full mt-1"
                        onClick={() => { setLoopEnabled(true); setLoopCount(0); setLoopPopoverOpen(false) }}
                      >
                        Do it
                      </Button>
                      {loopEnabled && (
                        <Button size="sm" variant="outline" className="w-full text-destructive border-destructive/30"
                          onClick={() => { setLoopEnabled(false); setLoopCount(0); setLoopCountdown(null); clearTimeout(loopTimerRef.current!); clearInterval(loopTickRef.current!); setLoopPopoverOpen(false) }}>
                          Cancel loop
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {isRunning ? (
                <Button size="icon-sm" variant="destructive" className="rounded-full" onClick={handleStop} title="Stop agent">
                  <IconPlayerStop size={15} />
                </Button>
              ) : (
                <Button
                  size="icon-sm" className="rounded-full" onClick={handleSend}
                  disabled={!projectDir || !draftPrompt.trim() || !!ollamaError}
                  title="Send"
                >
                  <IconArrowUp size={15} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Right: Pending diffs ─────────────────────────── */}
      {pendingDiffs.length > 0 && (
        <aside className="w-72 shrink-0 border-l flex flex-col bg-muted/10">
          <div className="px-3 py-2 border-b flex items-center gap-2">
            <IconFileCode size={13} className="text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Diffs ({pendingDiffs.filter((d) => d.status === 'pending').length} pending)
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {pendingDiffs.map((diff) => (
              <div key={diff.id} className="rounded-lg border bg-background/60 p-2 text-xs">
                <p className="font-mono text-[10px] text-muted-foreground truncate mb-1" title={diff.filePath}>
                  {diff.filePath.split('/').slice(-2).join('/')}
                </p>
                {diff.search && (
                  <div className="rounded bg-red-500/10 border border-red-500/20 px-1.5 py-1 mb-1 font-mono text-[10px] text-red-400 max-h-16 overflow-hidden">
                    -{diff.search.split('\n').slice(0, 3).join('\n')}
                  </div>
                )}
                <div className="rounded bg-green-500/10 border border-green-500/20 px-1.5 py-1 mb-2 font-mono text-[10px] text-green-400 max-h-16 overflow-hidden">
                  +{diff.replace.split('\n').slice(0, 3).join('\n')}
                </div>
                {diff.status === 'pending' ? (
                  <div className="flex gap-1">
                    <Button
                      size="sm" variant="outline"
                      className="flex-1 h-6 text-[10px] text-green-600 border-green-500/30 hover:bg-green-500/10"
                      onClick={() => handleApproveDiff(diff.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      className="flex-1 h-6 text-[10px] text-destructive border-destructive/30 hover:bg-destructive/10"
                      onClick={() => handleRejectDiff(diff.id)}
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <p className={`text-[10px] text-center font-medium ${diff.status === 'approved' ? 'text-green-500' : 'text-muted-foreground'}`}>
                    {diff.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}

    </div>
  )
}

// ── Project file tree (shallow listing) ───────────────────────
function ProjectFileTree({ projectDir }: { projectDir: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    invoke<string[]>('list_dir_shallow', { path: projectDir })
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [projectDir])

  if (loading) return <IconLoader2 size={14} className="animate-spin text-muted-foreground mx-auto mt-4" />

  return (
    <ul className="space-y-0.5">
      {files.map((f) => (
        <li key={f} className="flex items-center gap-1.5 py-0.5 px-1 rounded text-xs text-muted-foreground hover:bg-muted/40 cursor-default truncate">
          <IconFileCode size={12} className="shrink-0 opacity-60" />
          <span className="truncate">{f.split('/').pop()}</span>
        </li>
      ))}
    </ul>
  )
}

// ── Execution log line ────────────────────────────────────────
function LogLine({ line }: { line: ExecLogLine }) {
  switch (line.type) {
    case 'tool_start': {
      const input = tryParse(line.content)
      return (
        <Tool state="input-available" className="my-0.5">
          <ToolHeader title={line.toolName ?? 'Tool'} type={`tool-${line.toolName}` as `tool-${string}`} state="input-available" />
          <ToolContent>{input && <ToolInput input={input} />}</ToolContent>
        </Tool>
      )
    }
    case 'tool_result': {
      const isError = line.content.toLowerCase().includes('error')
      const state = isError ? ('output-error' as const) : ('output-available' as const)
      return (
        <Tool state={state} className="my-0.5">
          <ToolHeader title={line.toolName ?? 'Tool'} type={`tool-${line.toolName}` as `tool-${string}`} state={state} />
          <ToolContent>
            <ToolOutput
              output={isError ? undefined : line.content}
              errorText={isError ? line.content : undefined}
              resolver={(v) => Promise.resolve(v)}
            />
          </ToolContent>
        </Tool>
      )
    }
    case 'error':
      return <div className="text-destructive text-xs py-0.5 break-words">✗ {line.content}</div>
    case 'done':
      return <div className="text-muted-foreground text-[10px] text-center border-t my-2 pt-2 uppercase tracking-widest font-medium">{line.content}</div>
    case 'thinking':
      return (
        <Reasoning className="my-2" defaultOpen={true}>
          <ReasoningTrigger className="text-xs" />
          <ReasoningContent className="mt-2 text-xs">{line.content}</ReasoningContent>
        </Reasoning>
      )
    default:
      return <div className="text-muted-foreground text-xs py-0.5 break-words">{line.content}</div>
  }
}


function tryParse(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s)
    return typeof o === 'object' && o !== null ? o : null
  } catch {
    return null
  }
}
