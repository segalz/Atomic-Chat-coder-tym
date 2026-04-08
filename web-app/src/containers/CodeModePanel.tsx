import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCodeModeStore, type AgentOutputLine } from '@/stores/code-mode-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  IconFolderOpen,
  IconPlayerStop,
  IconArrowUp,
  IconCopy,
  IconTrash,
} from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PermissionModeSelector } from './PermissionModeSelector'
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

interface CodeAgentDiffSnapshotEvent {
  paths: string[]
  patch: string
  is_truncated: boolean
  note?: string
  tool_call_id?: string
}

export function CodeModePanel() {
  const { t } = useTranslation()
  const {
    mode,
    projectDir,
    setProjectDir,
    draftPrompt,
    setDraftPrompt,
    permissionMode,
    codeModel,
    availableCodeModels,
    setAvailableCodeModels,
    isAgentRunning,
    setAgentRunning,
    agentOutput,
    appendOutput,
    clearOutput,
    persistOutput,
  } = useCodeModeStore()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [ollamaStatus, setOllamaStatus] = useState<{ ok: boolean; version?: string } | null>(null)
  const [isPullingModel, setIsPullingModel] = useState(false)
  const [pullStatus, setPullStatus] = useState<string | null>(null)

  // ── Onboarding: Check Ollama and load models on mode change ──
  useEffect(() => {
    if (mode !== 'code') return

    // בדוק Ollama
    invoke<string>('check_ollama')
      .then(version => setOllamaStatus({ ok: true, version }))
      .catch(() => setOllamaStatus({ ok: false }))

    // טען מודלים מותקנים
    invoke<string[]>('list_ollama_models')
      .then(models => setAvailableCodeModels(models))
      .catch(() => {})
  }, [mode, setAvailableCodeModels])

  // ── Pull progress listener ───────────────────────────────
  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []

    const setup = async () => {
      const u = await listen<{ line: string }>('ollama-pull-progress', (event) => {
        if (!cancelled) {
          setPullStatus(event.payload.line)
        }
      })

      if (cancelled) {
        u()
      } else {
        unlisteners.push(u)
      }
    }
    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [])

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
      const u4 = await listen<CodeAgentDiffSnapshotEvent>('diff_snapshot', (event) => {
        if (!cancelled) {
          appendOutput({
            type: 'diff_snapshot',
            content: event.payload.note || t('code-mode:diffSnapshotTitle'),
            patch: event.payload.patch,
            paths: event.payload.paths,
            toolCallId: event.payload.tool_call_id,
            isTruncated: event.payload.is_truncated,
            timestamp: Date.now(),
          })
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
  }, [appendOutput, setAgentRunning, persistOutput, t])

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

  const handleSend = useCallback(async () => {
    if (!projectDir) {
      appendOutput({ type: 'error', content: t('code-mode:noProjectSelected'), timestamp: Date.now() })
      return
    }
    if (!codeModel) {
      appendOutput({ type: 'error', content: t('code-mode:modelNotInstalled'), timestamp: Date.now() })
      return
    }

    const promptToSend = draftPrompt
    clearOutput()
    setDraftPrompt('')
    appendOutput({ type: 'userPrompt', content: promptToSend, timestamp: Date.now() })
    persistOutput()
    setAgentRunning(true)

    try {
      await invoke('spawn_code_agent', {
        projectDir,
        prompt: promptToSend,
        ollamaModel: codeModel,
        permissionMode,
      })
      // spawn_code_agent returns immediately (fire-and-forget).
      // Do NOT set isAgentRunning=false here — let code-agent-done event handle it.
    } catch (e) {
      // Spawn failed synchronously — reset running state
      appendOutput({ type: 'error', content: String(e), timestamp: Date.now() })
      setAgentRunning(false)
    }
  }, [projectDir, codeModel, draftPrompt, permissionMode, clearOutput, setDraftPrompt, setAgentRunning, appendOutput, persistOutput, t])

  const handleStop = useCallback(async () => {
    try {
      await invoke('stop_code_agent')
    } catch (err) {
      console.error('Failed to stop agent:', err)
    }
  }, [])

  const handlePullModel = useCallback(async () => {
    if (!codeModel) return

    setIsPullingModel(true)
    setPullStatus(t('code-mode:pullingModel', { model: codeModel }))

    try {
      await invoke('pull_ollama_model', { modelId: codeModel })
      await invoke<string[]>('list_ollama_models')
        .then(models => setAvailableCodeModels(models))
        .catch(() => {})
    } catch (e) {
      appendOutput({ type: 'error', content: String(e), timestamp: Date.now() })
    } finally {
      setIsPullingModel(false)
    }
  }, [codeModel, setAvailableCodeModels, appendOutput, t])

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

  const clearOutputHandler = useCallback(() => {
    clearOutput()
  }, [clearOutput])

  const folderName = projectDir ? projectDir.split('/').pop() : null

  // Onboarding UI
  const renderOnboarding = () => {
    if (ollamaStatus === null) return null // Loading

    if (!ollamaStatus.ok) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-center max-w-md mx-auto p-6 rounded-lg border bg-card">
            <div className="text-2xl mb-4">⚠️</div>
            <h3 className="text-lg font-medium mb-2">{t('code-mode:ollamaRequired')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('code-mode:ollamaRequiredDescription')}
            </p>
            <div className="flex gap-2 justify-center">
              <Button size="sm" onClick={() => window.open('https://ollama.ai', '_blank')}>
                {t('code-mode:installOllama')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                invoke<string>('check_ollama')
                  .then(version => setOllamaStatus({ ok: true, version }))
                  .catch(() => setOllamaStatus({ ok: false }))
              }}>
                {t('code-mode:checkAgain')}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    if (!availableCodeModels.includes(codeModel)) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-center max-w-md mx-auto p-6 rounded-lg border bg-card">
            <div className="text-2xl mb-4">⚠️</div>
            <h3 className="text-lg font-medium mb-2">{t('code-mode:modelNotInstalled')}</h3>
            <p className="text-sm text-muted-foreground mb-4 font-mono">
              {t('code-mode:pullCommand', { model: codeModel })}
            </p>
            {pullStatus && (
              <p className="text-sm text-muted-foreground mb-4">{pullStatus}</p>
            )}
            <div className="flex flex-wrap gap-2 justify-center">
              <Button size="sm" onClick={handlePullModel} disabled={isPullingModel || !codeModel}>
                {isPullingModel ? t('code-mode:pullingModel', { model: codeModel }) : t('code-mode:pullModel')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigator.clipboard.writeText(`ollama pull ${codeModel}`)}
              >
                {t('code-mode:copyCommand')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                invoke<string[]>('list_ollama_models')
                  .then(models => setAvailableCodeModels(models))
                  .catch(() => {})
              }}>
                {t('code-mode:checkAgain')}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return null // All good
  }

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
        <div className="ml-auto flex items-center gap-2">
          <PermissionModeSelector />
        </div>
      </div>

      {/* Status bar if all good */}
      {ollamaStatus?.ok && availableCodeModels.includes(codeModel) && (
        <div className="px-4 py-1 text-xs text-muted-foreground border-b bg-muted/50">
          ✅ {t('code-mode:ollamaStatus', { version: ollamaStatus.version })}  |  ✅ {t('code-mode:modelInstalled', { model: codeModel })}
        </div>
      )}

      {/* Onboarding or Output */}
      {renderOnboarding() || (
        <>          {/* ── Output Controls ──────────────────────────────────────────── */}
          {agentOutput.length > 0 && (
            <div className="output-controls">
              <Button
                size="sm"
                variant="outline"
                onClick={copyAll}
                className="gap-1.5"
              >
                <IconCopy size={14} />
                {t('code-mode:copyAll')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={clearOutputHandler}
                className="gap-1.5"
              >
                <IconTrash size={14} />
                {t('code-mode:clearOutput')}
              </Button>
            </div>
          )}
          {/* ── Output area — same pattern as regular chat ────── */}
          <div className="flex-1 min-h-0 relative">
            <StickToBottom className="absolute inset-0 overflow-y-hidden" initial="smooth" resize="smooth">

              {agentOutput.length === 0 && !isAgentRunning && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center text-muted-foreground">
                    <h2 className="text-xl font-medium mb-1">{t('code-mode:codeModeTitle')}</h2>
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
                    <OutputLine key={i} line={line} />
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
              <div className="relative flex items-end rounded-2xl border bg-background shadow-sm">
                <textarea
                  ref={textareaRef}
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    projectDir
                      ? t('code-mode:sendPrompt')
                      : t('code-mode:selectProjFolderFirst')
                  }
                  disabled={!projectDir || isAgentRunning}
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
                      disabled={!projectDir || !draftPrompt.trim() || !codeModel}
                      title={t('code-mode:sendPrompt')}
                    >
                      <IconArrowUp size={16} />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Output line renderer ───────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */

function CollapsibleSection({
  icon,
  title,
  children,
  defaultOpen = false,
}: {
  icon: string
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="collapsible-section">
      <button
        className={cn('collapsible-trigger', isOpen && 'open')}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{icon}</span>
        <span>{title}</span>
      </button>
      {isOpen && (
        <div className="collapsible-content open">
          {children}
        </div>
      )}
    </div>
  )
}

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

function DiffBlock({
  patch,
  paths,
  note,
  toolCallId,
  isTruncated,
}: {
  patch: string
  paths?: string[]
  note?: string
  toolCallId?: string
  isTruncated?: boolean
}) {
  const { t } = useTranslation()
  const title = paths?.length ? paths.join(', ') : t('code-mode:diffSnapshotTitle')

  return (
    <CollapsibleSection icon="📝" title={title} defaultOpen={false}>
      {toolCallId && (
        <div className="text-xs text-muted-foreground mb-2">{`tool_call_id: ${toolCallId}`}</div>
      )}
      {note && <div className="text-sm text-muted-foreground mb-2">{note}</div>}
      <pre className="diff-block">{patch || t('code-mode:diffUnavailable')}</pre>
      {isTruncated && (
        <div className="text-xs text-muted-foreground mt-2">{t('code-mode:diffTruncated')}</div>
      )}
    </CollapsibleSection>
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

function OutputLine({ line }: { line: AgentOutputLine }) {
  const parsed = tryParseJson(line.content)

  switch (line.type) {
    case 'thinking': {
      return <ThinkingBlock content={line.content} />
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              output={isError ? undefined : (line.content as any)}
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

    case 'diff_snapshot': {
      return (
        <DiffBlock
          patch={line.patch ?? ''}
          paths={line.paths}
          note={line.note}
          toolCallId={line.toolCallId}
          isTruncated={line.isTruncated}
        />
      )
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
        <div className="text-muted-foreground text-xs text-center border-t mt-2 pt-2">
          ✅ Agent finished
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
