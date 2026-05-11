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
      await invoke('pull_ollama_model', { modelName: model, ollamaUrl })
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

// ── Event shapes from S1 Rust backend ────────────────────────
interface TextDeltaEvent { text: string }
interface ToolCallStartEvent { id: string; name: string; input: Record<string, unknown> }
interface ToolCallResultEvent { id: string; name: string; output: string }
interface DiffProposedEvent { id: string; file_path: string; search: string; replace: string }
interface AgentDoneEvent { success: boolean }
interface AgentErrorEvent { message: string }

export function CodingAgentPanel() {
  const createThread = useThreads((s) => s.createThread)
  const {
    projectDir, setProjectDir,
    draftPrompt, setDraftPrompt,
    isRunning, setRunning,
    appendPlanText,
    execLog, appendLog,
    addDiff,
    startNewSession, loadSession, deleteSession,
    sessions,
  } = useCodingAgentStore()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)
  const [isRestartingOllama, setIsRestartingOllama] = useState(false)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'restarting' | 'free'>('idle')

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

  // ── Subscribe to S1 events ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []

    const setup = async () => {
      const u1 = await listen<TextDeltaEvent>('coding-agent-text-delta', (e) => {
        if (!cancelled) appendPlanText(e.payload.text)
      })

      const u2 = await listen<ToolCallStartEvent>('coding-agent-tool-start', (e) => {
        if (!cancelled) {
          appendLog({
            type: 'tool_start',
            content: JSON.stringify(e.payload.input ?? {}),
            toolName: e.payload.name,
            timestamp: Date.now(),
          })
        }
      })

      const u3 = await listen<ToolCallResultEvent>('coding-agent-tool-result', (e) => {
        if (!cancelled) {
          appendLog({
            type: 'tool_result',
            content: e.payload.output,
            toolName: e.payload.name,
            timestamp: Date.now(),
          })
        }
      })

      const u4 = await listen<DiffProposedEvent>('coding-agent-diff-proposed', (e) => {
        if (!cancelled) {
          addDiff({
            id: e.payload.id,
            filePath: e.payload.file_path,
            search: e.payload.search,
            replace: e.payload.replace,
            status: 'pending',
          })
          appendLog({
            type: 'text_delta',
            content: `Diff proposed for ${e.payload.file_path} — awaiting approval`,
            timestamp: Date.now(),
          })
        }
      })

      // Parse raw stream-json lines from the backend and surface them in the log
      const u_raw = await listen<{ line: string }>('code-agent-output', (e) => {
        if (cancelled) return
        const raw = e.payload.line
        try {
          const msg = JSON.parse(raw)
          const type = msg?.type
          if (type === 'assistant') {
            const content: unknown[] = msg?.message?.content ?? []
            for (const block of content) {
              const b = block as Record<string, unknown>
              if (b.type === 'tool_use') {
                appendLog({
                  type: 'tool_start',
                  toolName: b.name as string,
                  content: JSON.stringify(b.input ?? {}),
                  timestamp: Date.now(),
                })
              } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                appendLog({ type: 'text_delta', content: b.text as string, timestamp: Date.now() })
              }
            }
          } else if (type === 'user') {
            const content: unknown[] = msg?.message?.content ?? []
            for (const block of content) {
              const b = block as Record<string, unknown>
              if (b.type === 'tool_result') {
                const output = Array.isArray(b.content)
                  ? (b.content as Array<Record<string, unknown>>).map((c) => c.text ?? '').join('\n')
                  : String(b.content ?? '')
                appendLog({
                  type: 'tool_result',
                  content: output,
                  timestamp: Date.now(),
                })
              }
            }
          } else if (type === 'result') {
            setRunning(false)
            appendLog({
              type: 'done',
              content: msg.subtype === 'success' ? '✓ Agent finished' : `✗ ${msg.error ?? 'Agent stopped'}`,
              timestamp: Date.now(),
            })
            useCodingAgentStore.getState().saveCurrentSession()
            setAgentStatus('restarting')
            invoke('restart_ollama').catch(() => {}).finally(() => setAgentStatus('free'))
          }
        } catch {
          // non-JSON line — show as-is
          appendLog({ type: 'text_delta', content: raw, timestamp: Date.now() })
        }
      })

      const u5 = await listen<AgentDoneEvent>('code-agent-done', (e) => {
        if (!cancelled) {
          setRunning(false)
          appendLog({
            type: 'done',
            content: e.payload.success ? '✓ Agent finished' : '✗ Agent stopped',
            timestamp: Date.now(),
          })
          useCodingAgentStore.getState().saveCurrentSession()
          invoke('restart_ollama').catch(() => {})
        }
      })

      const u6 = await listen<AgentErrorEvent>('coding-agent-error', (e) => {
        if (!cancelled) {
          appendLog({ type: 'error', content: e.payload.message, timestamp: Date.now() })
        }
      })

      if (cancelled) {
        ;[u_raw, u1, u2, u3, u4, u5, u6].forEach((u) => u())
      } else {
        unlisteners.push(u_raw, u1, u2, u3, u4, u5, u6)
      }
    }

    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [appendPlanText, appendLog, addDiff, setRunning])

  // ── Handlers ─────────────────────────────────────────────
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
    setRunning(true)
    setAgentStatus('running')
    appendLog({ type: 'text_delta', content: `> ${prompt}`, timestamp: Date.now() })

    try {
      await invoke('spawn_code_agent', {
        projectDir,
        prompt,
        ollamaModel: agentConfig?.code_model ?? 'qwen2.5-coder:32b',
        permissionMode: 'auto_accept',
      })
    } catch (err) {
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
      setRunning(false)
    }
  }, [projectDir, agentConfig, createThread, setRunning, appendLog, startNewSession])

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
    try { await invoke('stop_code_agent') } catch { /* ignore */ }
    setRunning(false)
    setLoopEnabled(false)
    setLoopCountdown(null)
    clearTimeout(loopTimerRef.current!)
    clearInterval(loopTickRef.current!)
  }, [setRunning])

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
                  invoke('stop_code_agent').catch(() => {})
                  setRunning(false)
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
