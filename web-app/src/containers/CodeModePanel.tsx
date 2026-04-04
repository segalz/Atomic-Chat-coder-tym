import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCodeModeStore } from '@/stores/code-mode-store'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  IconFolderOpen,
  IconPlayerStop,
  IconArrowUp,
} from '@tabler/icons-react'
import { PermissionModeSelector } from './PermissionModeSelector'
import { RenderMarkdown } from './RenderMarkdown'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

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

export function CodeModePanel() {
  const {
    projectDir,
    setProjectDir,
    draftPrompt,
    setDraftPrompt,
    permissionMode,
    isAgentRunning,
    setAgentRunning,
    agentOutput,
    appendOutput,
    clearOutput,
  } = useCodeModeStore()

  const {
    serverPort,
    serverHost,
    apiKey,
    apiPrefix,
    corsEnabled,
    verboseLogs,
    proxyTimeout,
    trustedHosts,
  } = useLocalApiServer()
  const { selectedModel } = useModelProvider()
  const serverStatus = useAppState((s) => s.serverStatus)
  const setServerStatus = useAppState((s) => s.setServerStatus)
  const serviceHub = useServiceHub()

  const outputRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Auto-start server when entering Code mode ────────────
  useEffect(() => {
    if (serverStatus !== 'stopped') return

    let cancelled = false
    const autoStart = async () => {
      try {
        const isRunning = await serviceHub.app().getServerStatus()
        if (isRunning || cancelled) {
          if (isRunning) setServerStatus('running')
          return
        }
        setServerStatus('pending')
        const actualPort = await window.core?.api?.startServer({
          host: serverHost,
          port: serverPort,
          prefix: apiPrefix,
          apiKey,
          trustedHosts,
          isCorsEnabled: corsEnabled,
          isVerboseEnabled: verboseLogs,
          proxyTimeout,
        })
        if (!cancelled && actualPort) {
          setServerStatus('running')
        }
      } catch (err) {
        console.error('Failed to auto-start server for Code mode:', err)
        if (!cancelled) setServerStatus('stopped')
      }
    }
    autoStart()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Listen to Tauri events ───────────────────────────────
  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []

    const setup = async () => {
      const u1 = await listen<CodeAgentOutputEvent>('code-agent-output', (event) => {
        if (!cancelled) {
          // Try to parse as JSON first
          const parsed = tryParseJson(event.payload.line)
          
          if (parsed) {
            // It's JSON - determine the type and add accordingly
            const outputType = (parsed.type as string) || 'assistant'
            appendOutput({
              type: outputType as any,
              content: event.payload.line, // Store raw JSON for processing
              timestamp: Date.now(),
            })
          } else {
            // Raw text, treat as assistant output
            appendOutput({
              type: 'assistant',
              content: event.payload.line,
              timestamp: Date.now(),
            })
          }
        }
      })
      const u2 = await listen<CodeAgentDoneEvent>('code-agent-done', (event) => {
        if (!cancelled) {
          setAgentRunning(false)
          appendOutput({
            type: 'done',
            content: event.payload.success
              ? '✓ Done'
              : `✗ Exited with code ${event.payload.exit_code ?? 'unknown'}`,
            timestamp: Date.now(),
          })
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

      if (cancelled) {
        u1(); u2(); u3()
      } else {
        unlisteners.push(u1, u2, u3)
      }
    }
    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [appendOutput, setAgentRunning])

  // ── Handlers ─────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: { directory: true, title: 'Select Project Folder' },
      })
      if (selected) setProjectDir(selected)
    } catch (err) {
      console.error('Failed to open folder dialog:', err)
    }
  }, [setProjectDir])

  const handleSend = useCallback(async () => {
    if (!projectDir || !draftPrompt.trim() || !selectedModel || isAgentRunning) return

    setError(null)
    setAgentRunning(true)
    clearOutput()

    const modelId = selectedModel.id

    try {
      // Step 0: Verify the model is actually available for the selected provider
      const provider = useModelProvider.getState().getProviderByName(selectedModel.provider)
      if (!provider) {
        setError(`Provider '${selectedModel.provider}' not found`)
        setAgentRunning(false)
        return
      }

      // Check if model exists in the provider's available models
      const modelExists = provider.models.some((m) => m.id === modelId)
      if (!modelExists) {
        setError(
          `Model '${modelId}' is not available in the '${selectedModel.provider}' provider. ` +
          `Please download it first from the Models hub.`
        )
        setAgentRunning(false)
        return
      }

      // Step 1: START the model (like ModelFactory and ChatInput do)
      // This ensures the model is loaded and running before we try to use it
      console.log('[CodeMode] Starting model:', modelId)
      try {
        await serviceHub.models().startModel(provider, modelId)
        console.log('[CodeMode] Model started successfully')
      } catch (error) {
        console.error('[CodeMode] Failed to start model:', error)
        setError(
          `Failed to start model '${modelId}': ${error instanceof Error ? error.message : String(error)}`
        )
        setAgentRunning(false)
        return
      }

      // Step 2: Find the actual port of the running model session
      // TurboQuant loads models via the MLX plugin, so try MLX first
      let sessionPort: number | null = null
      let sessionApiKey = ''

      console.log('[CodeMode] Looking for model session:', modelId)

      // Try MLX first (TurboQuant uses MLX plugin)
      const mlxSession = await invoke<{ port: number; api_key: string } | null>(
        'plugin:mlx|find_mlx_session_by_model',
        { modelId }
      ).catch((e) => { console.log('[CodeMode] MLX find error:', e); return null })

      if (mlxSession) {
        sessionPort = mlxSession.port
        sessionApiKey = mlxSession.api_key
        console.log('[CodeMode] Found MLX session on port:', sessionPort)
      } else {
        // Try llamacpp
        const llamaSession = await invoke<{ port: number; api_key: string } | null>(
          'plugin:llamacpp|find_session_by_model',
          { modelId }
        ).catch((e) => { console.log('[CodeMode] LlamaCpp find error:', e); return null })

        if (llamaSession) {
          sessionPort = llamaSession.port
          sessionApiKey = llamaSession.api_key
          console.log('[CodeMode] Found LlamaCpp session on port:', sessionPort)
        }
      }

      if (!sessionPort) {
        setError(
          `Failed to find running session for model '${modelId}'. The model provider may not support this model type.`
        )
        setAgentRunning(false)
        return
      }

      const serverUrl = `http://127.0.0.1:${sessionPort}/v1`

      await invoke('spawn_code_agent', {
        projectDir,
        prompt: draftPrompt,
        modelId,
        permissionMode,
        serverUrl,
        apiKey: sessionApiKey || 'no-key',
        context: null,
      })
    } catch (err) {
      setError(String(err))
      setAgentRunning(false)
    }
  }, [projectDir, draftPrompt, selectedModel, isAgentRunning, setAgentRunning, clearOutput])

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
          {folderName ?? 'Select folder'}
        </Button>
        {projectDir && (
          <span className="text-xs text-muted-foreground truncate" title={projectDir}>
            {projectDir}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PermissionModeSelector />
          {serverStatus === 'pending' && (
            <span className="text-xs text-muted-foreground">Starting server...</span>
          )}
        </div>
      </div>

      {/* ── Output area (chat-like, scrollable) ───────────── */}
      <StickToBottom className="flex-1 overflow-y-hidden" initial="smooth" resize="smooth">
        {agentOutput.length === 0 && !isAgentRunning && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-muted-foreground">
              <h2 className="text-xl font-medium mb-1">Code Mode</h2>
              <p className="text-sm">
                {projectDir
                  ? 'Ask anything about your project'
                  : 'Select a project folder to get started'}
              </p>
            </div>
          </div>
        )}

        <StickToBottom.Content className="flex flex-col gap-2 px-4 py-4">
          {agentOutput.length > 0 && (
            <div className="mx-auto w-full md:w-4/5 xl:w-4/6 space-y-1">
              {agentOutput.map((line, i) => (
                <OutputLine key={i} line={line} />
              ))}
            </div>
          )}
        </StickToBottom.Content>
      </StickToBottom>

      {error && (
        <div className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

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
                  ? 'Ask me anything...'
                  : 'Select a project folder first'
              }
              disabled={!projectDir || (isAgentRunning && false)}
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
                  title="Stop"
                >
                  <IconPlayerStop size={16} />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  className="rounded-full"
                  onClick={handleSend}
                  disabled={!projectDir || !draftPrompt.trim() || !selectedModel}
                  title="Send"
                >
                  <IconArrowUp size={16} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Output line renderer ───────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
function OutputLine({ line }: { line: { type: string; content: string } }) {
  const parsed = tryParseJson(line.content)

  if (line.type === 'done') {
    return (
      <div className={cn(
        'py-1 text-sm font-medium',
        line.content === 'Done' ? 'text-green-500' : 'text-muted-foreground'
      )}>
        {line.content === 'Done' ? 'Done' : line.content}
      </div>
    )
  }

  if (line.type === 'error') {
    // Try to parse error message
    try {
      const errorData = JSON.parse(line.content)
      return (
        <div className="py-1 text-sm text-destructive">
          ✗ {errorData.message || line.content}
        </div>
      )
    } catch {
      return (
        <div className="py-1 text-sm text-destructive">
          ✗ {line.content}
        </div>
      )
    }
  }

  if (!parsed) {
    return (
      <div className={cn(
        'py-0.5 text-sm whitespace-pre-wrap break-words',
        line.type === 'error' && 'text-destructive'
      )}>
        {line.content}
      </div>
    )
  }

  const parsedData = parsed as any
  const { type, subtype, name, message } = parsedData
  
  if (type === 'system' && subtype === 'init') {
    return (
      <div className="py-1 text-xs text-muted-foreground">
        Working on {parsedData.cwd} with {parsedData.model}
      </div>
    )
  }

  // Task started event
  if (type === 'task_started') {
    return (
      <div className="py-1 text-xs text-muted-foreground">
        ▶ Task started
      </div>
    )
  }

  if (type === 'assistant' && message?.content) {
    const texts = message.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
    if (texts) {
      return (
        <div className="py-1 text-sm">
          <RenderMarkdown content={texts} />
        </div>
      )
    }
  }

  if (type === 'tool_use') {
    const input = parsed.input as Record<string, any> | undefined
    const detail = input?.file_path || input?.command || input?.pattern || ''
    return (
      <div className="py-0.5 text-xs text-muted-foreground font-mono">
        {toolIcon(name)} {name} {detail}
      </div>
    )
  }

  if (type === 'tool_result') {
    return (
      <details className="py-0.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Result ({String(parsed.content ?? '').length} chars)
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs font-mono">
          {typeof parsed.content === 'string'
            ? parsed.content
            : JSON.stringify(parsed.content, null, 2)}
        </pre>
      </details>
    )
  }

  if (type === 'result') {
    return (
      <div className={cn(
        'py-1 text-sm font-medium',
        subtype === 'success' ? 'text-green-500' : 'text-destructive'
      )}>
        {subtype === 'success' ? '✓ Done' : `✗ Error: ${subtype}`}
      </div>
    )
  }

  // Handle 'say' events from the agent
  if (type === 'say') {
    const sayType = parsedData.say
    const text = parsedData.text

    // Task display
    if (sayType === 'task' && text) {
      return (
        <div className="py-1 text-sm">
          <RenderMarkdown content={text} />
        </div>
      )
    }

    // Text/response display
    if (sayType === 'text' && text) {
      return (
        <div className="py-1 text-sm">
          <RenderMarkdown content={text} />
        </div>
      )
    }

    // Error/retry - show as error message
    if (sayType === 'error_retry') {
      try {
        const errorData = typeof text === 'string' ? JSON.parse(text) : text
        return (
          <div className="py-1 text-xs text-yellow-600 dark:text-yellow-400">
            ⚠ Retry {errorData.attempt}/{errorData.maxAttempts}: {errorData.errorMessage}
          </div>
        )
      } catch {
        return (
          <div className="py-1 text-xs text-yellow-600 dark:text-yellow-400">
            ⚠ {text}
          </div>
        )
      }
    }

    // API request started - show compact indicator
    if (sayType === 'api_req_started') {
      return null // Skip these, they're just noise
    }

    // API request retried
    if (sayType === 'api_req_retried') {
      return null // Skip these, handled by error_retry
    }

    // API request finished
    if (sayType === 'api_req_finished') {
      return null // Skip these, they're just noise
    }

    // Generic say handler
    if (text) {
      return (
        <div className="py-1 text-sm">
          <RenderMarkdown content={typeof text === 'string' ? text : JSON.stringify(text)} />
        </div>
      )
    }
  }

  // Handle 'ask' events from the agent (questions to user)
  if (type === 'ask') {
    const askType = parsedData.ask
    const text = parsedData.text

    // API request failed
    if (askType === 'api_req_failed' && text) {
      try {
        const errorData = typeof text === 'string' ? JSON.parse(text) : text
        return (
          <div className="py-1 text-sm text-destructive">
            ✗ API Error: {errorData.message || text}
          </div>
        )
      } catch {
        return (
          <div className="py-1 text-sm text-destructive">
            ✗ {text}
          </div>
        )
      }
    }

    // Generic ask handler
    if (text) {
      return (
        <div className="py-1 text-sm">
          <RenderMarkdown content={typeof text === 'string' ? text : JSON.stringify(text)} />
        </div>
      )
    }
  }

  // Permission request (ask mode)
  if (type === 'permission_request') {
    const request = parsed as any
    return (
      <div className="py-2 rounded-md bg-muted p-3 border border-muted-foreground/20">
        <div className="text-sm mb-3">
          <span className="font-medium">Permission Request:</span>
          <p className="text-xs text-muted-foreground mt-1">{request.message || request.action || 'Requires approval'}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs"
            onClick={() => {
              console.log('[CodeMode] Approved:', request)
              // TODO: Send 'y' to Cline stdin
            }}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              console.log('[CodeMode] Denied:', request)
              // TODO: Send 'n' to Cline stdin
            }}
          >
            Deny
          </Button>
        </div>
      </div>
    )
  }

  // Fallback
  return (
    <div className="py-0.5 text-xs text-muted-foreground whitespace-pre-wrap break-all font-mono">
      {line.content}
    </div>
  )
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Read': return '\u{1F4D6}'
    case 'Edit': return '\u{270F}\u{FE0F}'
    case 'Write': return '\u{1F4DD}'
    case 'Bash': return '\u{1F4BB}'
    case 'Glob':
    case 'Grep': return '\u{1F50D}'
    default: return '\u{1F527}'
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
