import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCodeModeStore, type AgentOutputLine } from '@/stores/code-mode-store'
import { Button } from '@/components/ui/button'
import {
  IconFolderOpen,
  IconPlayerStop,
  IconArrowUp,
  IconCopy,
  IconTrash,
  IconPhoto,
  IconX,
  IconCheck,
  IconLoader2,
  IconAlertTriangle,
  IconAlertCircle,
  IconRefresh,
  IconCircle,
  IconPlayerSkipForward,
} from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { RenderMarkdown } from './RenderMarkdown'
import { StickToBottom } from 'use-stick-to-bottom'
import { ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Shimmer } from '@/components/ai-elements/shimmer'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import './CodeModePanel.css'

// ── Event types from Rust backend ────────────────────────────
interface CodeAgentOutputEvent {
  line: string
}
interface CodeAgentDoneEvent {
  exit_code: number | null
  success: boolean
}
interface CodeAgentErrorEvent {
  message: string
}

type StageStatus = 'idle' | 'running' | 'done' | 'skipped' | 'error' | 'warning'
type StageName = 'translate' | 'vision' | 'navigate' | 'architect'

interface PlanStageProgressEvent {
  stage: StageName
  status: StageStatus
  detail?: string
}

interface StageState {
  translate: StageStatus
  vision: StageStatus
  navigate: StageStatus
  architect: StageStatus
}

const INITIAL_STAGES: StageState = {
  translate: 'idle',
  vision: 'idle',
  navigate: 'idle',
  architect: 'idle',
}

export function CodeModePanel() {
  const { t } = useTranslation()
  const {
    projectDir,
    setProjectDir,
    draftPrompt,
    setDraftPrompt,
    attachedImagePath,
    setAttachedImagePath,
    isAgentRunning,
    setAgentRunning,
    agentOutput,
    appendOutput,
    clearOutput,
    persistOutput,
  } = useCodeModeStore()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [stages, setStages] = useState<StageState>(INITIAL_STAGES)
  const [_stageDetail, setStageDetail] = useState<Partial<Record<StageName, string>>>({})
  const [copied, setCopied] = useState(false)
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)

  // ── Pre-flight check ─────────────────────────────────────
  const checkOllama = useCallback(async () => {
    setIsCheckingOllama(true)
    setOllamaError(null)
    try {
      // 1. Check if binary exists
      await invoke('check_ollama')
      // 2. Check if daemon is responding
      const isHealthy = await invoke<boolean>('check_ollama_health')
      if (!isHealthy) {
        setOllamaError(t('code-mode:ollamaNotRunning'))
      }
    } catch (err) {
      setOllamaError(String(err))
    } finally {
      setIsCheckingOllama(false)
    }
  }, [t])

  useEffect(() => {
    checkOllama()
  }, [checkOllama])

  // ── Listen to Tauri events ───────────────────────────────
  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []
    // Map tool_use_id → tool_name so tool_result can show the real tool name
    const toolNameMap = new Map<string, string>()

    const setup = async () => {
      const u1 = await listen<CodeAgentOutputEvent>('code-agent-output', (event) => {
        if (!cancelled) {
          const parsed = tryParseJson(event.payload.line)

          if (!parsed) {
            // Plain text line
            if (event.payload.line.trim()) {
              appendOutput({ type: 'assistant', content: event.payload.line, timestamp: Date.now() })
            }
            return
          }

          const rawType = (parsed.type as string) || ''

          switch (rawType) {
            case 'system':
              // Internal CLI metadata (init event, session info) — skip
              break

            case 'result': {
              // Content already rendered via 'assistant' events during streaming — skip to avoid duplication
              break
            }

            case 'assistant': {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              const msgContent = (parsed.message as any)?.content as Array<any> | undefined
              if (!msgContent) break

              // Thinking parts → reasoning bubble (collapsed after agent finishes)
              const thinkingText = msgContent
                .filter((c: any) => c.type === 'thinking')
                .map((c: any) => c.thinking as string)
                .join('\n')
              if (thinkingText.trim()) {
                appendOutput({ type: 'thinking', content: thinkingText, timestamp: Date.now() })
              }

              // Text parts → assistant bubble
              const texts = msgContent
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text as string)
                .join('')
              if (texts.trim()) {
                appendOutput({ type: 'assistant', content: texts, timestamp: Date.now() })
              }

              // Tool-use parts → tool_use bubble
              msgContent.filter((c: any) => c.type === 'tool_use').forEach((tu: any) => {
                toolNameMap.set(tu.id as string, tu.name as string)
                appendOutput({
                  type: 'tool_use',
                  content: JSON.stringify(tu.input ?? {}),
                  toolName: tu.name as string,
                  timestamp: Date.now(),
                })
              })
              break
            }

            case 'user': {
              const msgContent = (parsed.message as any)?.content as Array<any> | undefined
              if (!msgContent) break

              // Tool-result parts → tool_result bubble
              msgContent.filter((c: any) => c.type === 'tool_result').forEach((tr: any) => {
                const resultContent =
                  typeof tr.content === 'string'
                    ? tr.content
                    : Array.isArray(tr.content)
                      ? tr.content
                          .filter((c: any) => c.type === 'text')
                          .map((c: any) => c.text as string)
                          .join('\n')
                      : JSON.stringify(tr.content)
                const toolName = toolNameMap.get(tr.tool_use_id as string) || undefined
                appendOutput({
                  type: 'tool_result',
                  content: resultContent,
                  toolName,
                  timestamp: Date.now(),
                })
              })
              break
            }

            case 'permission_request': {
              const reason = parsed.reason as string | undefined
              const command = parsed.command as string | undefined
              const prompt = parsed.prompt as string | undefined
              const content = [reason, command, prompt].filter(Boolean).join(' - ') || event.payload.line
              appendOutput({ type: 'permission_request', content, timestamp: Date.now() })
              break
            }

            case 'error': {
              const msg = (parsed.message as string | undefined) || event.payload.line
              appendOutput({ type: 'error', content: msg, timestamp: Date.now() })
              break
            }

            default:
              // Unknown top-level type — skip to avoid showing raw JSON
              break
          }
        }
      })
      const u2 = await listen<CodeAgentDoneEvent>('code-agent-done', (event) => {
        if (!cancelled) {
          setAgentRunning(false)
          appendOutput({
            type: 'done',
            content: event.payload.success
              ? t('code-mode:agentRunning')
              : `✗ ${t('code-mode:stopAgent')}`,
            timestamp: Date.now(),
          })
          persistOutput()
        }
      })
      const u3 = await listen<CodeAgentErrorEvent>('code-agent-error', (event) => {
        if (!cancelled) {
          appendOutput({
            type: 'error',
            content: event.payload.message,
            timestamp: Date.now(),
          })
        }
      })

      const u4 = await listen<PlanStageProgressEvent>('plan-stage-progress', (event) => {
        if (!cancelled) {
          const { stage, status, detail } = event.payload
          setStages((prev) => ({ ...prev, [stage]: status }))
          if (detail) setStageDetail((prev) => ({ ...prev, [stage]: detail }))

          // Append to log for visibility
          if (status === 'done' || status === 'skipped' || status === 'warning') {
            const stageLabel = t(`code-mode:stage${stage.charAt(0).toUpperCase() + stage.slice(1)}` as any)
            const statusKey = status === 'done' ? 'stageDone' : status === 'skipped' ? 'stageSkipped' : status
            const statusLabel = t(`code-mode:${statusKey}` as any) || status

            appendOutput({
              type: 'plan_stage',
              content: `${stageLabel}: ${statusLabel}${detail && status !== 'done' ? ` - ${detail}` : ''}`,
              timestamp: Date.now(),
            })
          }
        }
      })

      if (cancelled) {
        u1(); u2(); u3(); u4()
      } else {
        unlisteners.push(u1, u2, u3, u4)
      }
    }
    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [appendOutput, setAgentRunning, persistOutput, t, setStages, setStageDetail])

  // ── Handlers ─────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: { directory: true, title: t('code-mode:browseFolder') },
      })
      if (selected) setProjectDir(selected)
    } catch (err) {
      console.error('Failed to open folder dialog:', err)
    }
  }, [setProjectDir, t])

  useEffect(() => {
    const unlisten = listen<string[]>('tauri://file-drop', (event) => {
      const filePath = event.payload[0];
      if (filePath) {
        setAttachedImagePath(filePath);
      }
    });

    return () => {
      unlisten.then(f => f());
    };
  }, [setAttachedImagePath]);


  const handleSend = useCallback(async () => {
    if (!projectDir) {
      appendOutput({ type: 'error', content: t('code-mode:noProjectSelected'), timestamp: Date.now() })
      return
    }

    const promptToSend = draftPrompt
    const imagePathToSend = attachedImagePath
    clearOutput()
    setDraftPrompt('')
    setAttachedImagePath(null)
    setStages(INITIAL_STAGES)
    setStageDetail({})
    appendOutput({ type: 'userPrompt', content: promptToSend, timestamp: Date.now() })
    persistOutput()
    setAgentRunning(true)

    try {
      await invoke('run_plan_pipeline', {
        projectDir,
        prompt: promptToSend,
        imagePath: imagePathToSend,
      })
      // run_plan_pipeline returns immediately (fire-and-forget).
      // Do NOT set isAgentRunning=false here — let code-agent-done event handle it.
    } catch (e) {
      // Spawn failed synchronously — reset running state
      appendOutput({ type: 'error', content: String(e), timestamp: Date.now() })
      setAgentRunning(false)
    }
  }, [projectDir, draftPrompt, attachedImagePath, setAttachedImagePath, clearOutput, setDraftPrompt, setAgentRunning, appendOutput, persistOutput, t, setStages, setStageDetail])

  const handleStop = useCallback(async () => {
    try {
      await invoke('stop_code_agent')
    } catch (err) {
      console.error('Failed to stop agent:', err)
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const copyAll = useCallback(() => {
    const text = agentOutput
      .filter(line => line.type !== 'userPrompt')
      .map(line => `[${line.type}] ${line.content}`)
      .join('\n')
    navigator.clipboard.writeText(text)
  }, [agentOutput])

  const handleCopyPlan = useCallback(() => {
    const planText = agentOutput
      .filter((line) => line.type === 'assistant')
      .map((line) => line.content)
      .join('\n\n')
    navigator.clipboard.writeText(planText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [agentOutput])

  const clearOutputHandler = useCallback(() => {
    clearOutput()
  }, [clearOutput])

  const folderName = projectDir ? projectDir.split('/').pop() : null

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Project Bar (compact) ─────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSelectFolder}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <IconFolderOpen size={16} />
          {folderName ?? t('code-mode:browseFolder')}
        </Button>
        {projectDir && (
          <span className="text-xs text-muted-foreground truncate" title={projectDir}>
            {projectDir}
          </span>
        )}
      </div>

      {/* ── Ollama Error Banner ────────────────────────────── */}
      {ollamaError && (
        <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2.5 flex items-center gap-3 shrink-0">
          <IconAlertCircle size={18} className="text-destructive shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-destructive truncate">
              {ollamaError}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={checkOllama}
            disabled={isCheckingOllama}
            className="h-8 gap-1.5 text-destructive border-destructive/20 hover:bg-destructive/10"
          >
            <IconRefresh size={14} className={isCheckingOllama ? 'animate-spin' : ''} />
            {t('code-mode:checkAgain')}
          </Button>
        </div>
      )}

      {/* ── Output Controls ──────────────────────────────────────────── */}
      {agentOutput.length > 0 && (
        <div className="output-controls">
          {stages.architect === 'done' && !isAgentRunning && (
            <Button
              size="sm"
              variant="default"
              onClick={handleCopyPlan}
              className="gap-1.5"
            >
              <IconCopy size={14} />
              {copied ? t('code-mode:planCopied') : t('code-mode:copyPlan')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={copyAll}
            className="gap-1.5 text-muted-foreground"
          >
            <IconCopy size={14} />
            {t('code-mode:copyAll')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={clearOutputHandler}
            className="gap-1.5 text-muted-foreground"
          >
            <IconTrash size={14} />
            {t('code-mode:clearOutput')}
          </Button>
        </div>
      )}

      {/* ── Stage progress bar ──────────────────────────────── */}
      {stages.translate !== 'idle' && (
        <div className="flex items-center gap-2 px-4 py-2 border-b text-[10px] uppercase tracking-wider shrink-0 overflow-x-auto bg-muted/30">
          <StageStep label={t('code-mode:stageTranslate')} status={stages.translate} />
          <StepArrow />
          <StageStep label={t('code-mode:stageVision')}    status={stages.vision} />
          <StepArrow />
          <StageStep label={t('code-mode:stageNavigate')}  status={stages.navigate} />
          <StepArrow />
          <StageStep label={t('code-mode:stagePlanning')}  status={stages.architect} />
        </div>
      )}

      {/* ── Output area — same pattern as regular chat ────── */}
      <div className="flex-1 min-h-0 relative">
        <StickToBottom className="absolute inset-0 overflow-y-hidden" initial="smooth" resize="smooth">

              {agentOutput.length === 0 && !isAgentRunning && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center text-muted-foreground">
                    <h2 className="text-xl font-medium mb-1">{t('code-mode:planModeTitle')}</h2>
                    <p className="text-sm">
                      {projectDir
                        ? t('code-mode:askAnythingAboutProject')
                        : t('code-mode:selectProjFolderFirst')}
                    </p>
                  </div>
                </div>
              )}

              <StickToBottom.Content className="flex flex-col gap-2 px-4 py-4">
                <div className="mx-auto w-full md:w-4/5 xl:w-4/6 space-y-1 min-w-0 overflow-x-hidden">
                  {agentOutput.map((line, i) => (
                    <OutputLine key={i} line={line} t={t} />
                  ))}

                  {/* Loading indicator — visible while agent is running */}
                  {isAgentRunning && (
                    <div className="py-2 text-sm text-muted-foreground">
                      <Shimmer duration={1.5}>Thinking…</Shimmer>
                    </div>
                  )}
                </div>
              </StickToBottom.Content>

              {/* Scroll-to-bottom button — same as regular chat */}
              <ConversationScrollButton />
        </StickToBottom>
      </div>

      {/* ── Input area (chat-like, bottom) ────────────────── */}
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full md:w-4/5 xl:w-4/6">
          <div
            className={`relative flex flex-col rounded-2xl border bg-background shadow-sm transition-colors`}
          >
            {attachedImagePath && (
              <div className="flex items-center gap-1.5 px-3 pt-2">
                <IconPhoto size={13} className="shrink-0 text-muted-foreground" />
                <span className="text-xs text-muted-foreground truncate max-w-[240px]">
                  {attachedImagePath.split('/').pop()}
                </span>
                <button
                  type="button"
                  onClick={() => setAttachedImagePath(null)}
                  className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  title="Remove image"
                >
                  <IconX size={12} />
                </button>
              </div>
            )}
            <div className="flex items-end">
            <textarea
              ref={textareaRef}
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                ollamaError
                  ? t('code-mode:ollamaRequired')
                  : projectDir
                    ? t('code-mode:sendPrompt')
                    : t('code-mode:selectProjFolderFirst')
              }
              disabled={!projectDir || isAgentRunning || !!ollamaError}
              className="flex-1 resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              rows={1}
              style={{ maxHeight: '150px', fieldSizing: 'content' } as React.CSSProperties}
            />
            <div className="flex items-center gap-1 px-2 py-2">
              {isAgentRunning ? (
                <Button
                  size="icon-sm"
                  variant="destructive"
                  className="rounded-full"
                  onClick={handleStop}
                  title={t('code-mode:stopAgent')}
                >
                  <IconPlayerStop size={16} />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  className="rounded-full"
                  onClick={handleSend}
                  disabled={!projectDir || !draftPrompt.trim() || !!ollamaError}
                  title={t('code-mode:sendPrompt')}
                >
                  <IconArrowUp size={16} />
                </Button>
              )}
            </div>
            </div>{/* flex items-end row */}
          </div>{/* drag container */}
        </div>
      </div>
    </div>
  )
}

// ── Output line renderer ───────────────────────────────────

function PermissionCard({ content }: { content: string }) {
  const [loading, setLoading] = useState(false)

  const handleApprove = async () => {
    setLoading(true)
    try {
      await invoke('send_agent_input', { text: 'y' })
    } catch (e) {
      console.error('Failed to send approval:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleDeny = async () => {
    setLoading(true)
    try {
      await invoke('send_agent_input', { text: 'n' })
    } catch (e) {
      console.error('Failed to send denial:', e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="permission-card">
      <div className="permission-card-title">Permission Request</div>
      <div className="permission-card-content">{content}</div>
      <div className="permission-card-buttons">
        <button className="approve" onClick={handleApprove} disabled={loading}>
          ✅ Approve
        </button>
        <button className="deny" onClick={handleDeny} disabled={loading}>
          ❌ Deny
        </button>
      </div>
    </div>
  )
}

// Separate component so it can read isAgentRunning from store (hooks can't be inside switch)
function ThinkingBlock({ content }: { content: string }) {
  const isAgentRunning = useCodeModeStore((state) => state.isAgentRunning)
  return (
    <Reasoning
      className="w-full text-muted-foreground"
      isStreaming={isAgentRunning}
      defaultOpen={isAgentRunning}
    >
      <ReasoningTrigger />
      <ReasoningContent>{content}</ReasoningContent>
    </Reasoning>
  )
}

function OutputLine({ line, t }: { line: AgentOutputLine, t: any }) {
  switch (line.type) {
    case 'thinking': {
      return <ThinkingBlock content={line.content} />
    }

    case 'plan_stage': {
      return (
        <div className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground/70 font-medium">
          <div className="w-1.5 h-1.5 rounded-full bg-primary/40" />
          {line.content}
        </div>
      )
    }

    case 'userPrompt': {
      return (
        <div className="flex justify-end w-full py-1">
          <div className="bg-secondary text-foreground px-3 py-2 rounded-md inline-block max-w-[80%] min-w-0">
            <div dir="auto" className="select-text whitespace-pre-wrap break-words text-sm">
              {line.content}
            </div>
          </div>
        </div>
      )
    }

    case 'assistant': {
      // content is always extracted plain text (never raw JSON) after the refactor
      if (!line.content?.trim()) return null
      return <RenderMarkdown content={line.content} />
    }

    case 'tool_use': {
      // content is JSON.stringify(input), toolName is the real tool name
      const toolInput = tryParseJson(line.content) as Record<string, unknown> | null
      const toolName = line.toolName || 'Tool'
      return (
        <Tool state="input-available" className="my-1">
          <ToolHeader
            title={toolName}
            type={`tool-${toolName}` as `tool-${string}`}
            state="input-available"
          />
          <ToolContent>
            {toolInput && <ToolInput input={toolInput} />}
          </ToolContent>
        </Tool>
      )
    }

    case 'tool_result': {
      // content is extracted result text, toolName is the real tool name (matched from tool_use)
      const isError = line.content.toLowerCase().includes('error')
      const state = isError ? ('output-error' as const) : ('output-available' as const)
      const toolName = line.toolName || 'Tool'
      return (
        <Tool state={state} className="my-1">
          <ToolHeader
            title={toolName}
            type={`tool-${toolName}` as `tool-${string}`}
            state={state}
          />
          <ToolContent>
            <ToolOutput
              output={isError ? undefined : line.content}
              errorText={isError ? line.content : undefined}
              resolver={(input) => Promise.resolve(input)}
            />
          </ToolContent>
        </Tool>
      )
    }

    case 'permission_request': {
      return <PermissionCard content={line.content} />
    }

    case 'system': {
      // Internal CLI system events (init, session info, etc.) — hide from user
      return null
    }

    case 'error': {
      return (
        <div className="text-destructive font-medium text-sm py-1 px-1 break-words">
          ✗ {line.content}
        </div>
      )
    }

    case 'done': {
      return (
        <div className="text-muted-foreground text-[10px] text-center border-t mt-4 pt-4 uppercase tracking-widest font-medium">
          {line.content.includes('✗') ? line.content : t('code-mode:stageDone')}
        </div>
      )
    }

    default: {
      return (
        <div className="text-muted-foreground text-xs py-1 px-1">
          {line.content}
        </div>
      )
    }
  }
}


function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(s)
    return typeof obj === 'object' && obj !== null ? obj : null
  } catch {
    return null
  }
}

// ── Stage progress helpers ─────────────────────────────────

function StepArrow() {
  return <span className="text-muted-foreground/50 select-none px-0.5">→</span>
}

function StageStep({ label, status }: { label: string; status: StageStatus }) {
  const icon =
    status === 'running' ? <IconLoader2 size={12} className="animate-spin text-primary" />
    : status === 'done'  ? <IconCheck size={12} className="text-primary" />
    : status === 'skipped' ? <IconPlayerSkipForward size={12} className="text-muted-foreground/40" />
    : status === 'error' ? <IconX size={12} className="text-destructive" />
    : status === 'warning' ? <IconAlertTriangle size={12} className="text-amber-500" />
    : <IconCircle size={10} className="text-muted-foreground/30" />

  const textClass =
    status === 'running' ? 'text-foreground font-semibold'
    : status === 'done'  ? 'text-foreground/80'
    : status === 'error' ? 'text-destructive font-medium'
    : 'text-muted-foreground/50'

  return (
    <span className={`flex items-center gap-1.5 whitespace-nowrap transition-colors duration-200 ${textClass}`}>
      <span className="flex items-center justify-center w-3.5 h-3.5">{icon}</span>
      <span>{label}</span>
    </span>
  )
}
