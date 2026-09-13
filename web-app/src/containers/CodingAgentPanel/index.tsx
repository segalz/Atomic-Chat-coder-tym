import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCodingAgentStore, type CodingSessionSource, type ExecLogLine, type WorkState } from '@/stores/coding-agent-store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  IconFolderOpen,
  IconPlayerStop,
  IconArrowUp,
  IconLoader2,
  IconAlertCircle,
  IconRefresh,
  IconFileCode,
  IconCpu,
  IconCloudDownload,
  IconCircleCheck,
  IconClock,
  IconPencil,
  IconPaperclip,
  IconArrowsExchange,
} from '@tabler/icons-react'

import { StickToBottom } from 'use-stick-to-bottom'
import { ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { cn } from '@/lib/utils'
import { isRtlText, getTextDirection } from '@/utils/textDirection'
import { CopyButton } from '@/containers/CopyButton'
import { EditMessageDialog } from '@/containers/dialogs/EditMessageDialog'
import { DeleteMessageDialog } from '@/containers/dialogs/DeleteMessageDialog'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import {
  CLINE_DEFAULT_MODEL_ID,
  extractPermissionCommand,
  extractPermissionFileEdit,
  getInitialCodingAgentBackend,
  normalizeAcpPermissionRequest,
  normalizeCompatDiffProposed,
  normalizeCompatToolResult,
  normalizeCompatToolStart,
  normalizeDirectDiffProposed,
  normalizeDirectToolResult,
  normalizeDirectToolStart,
  normalizeDone,
  normalizeError,
  CLINE_DEFAULT_PROVIDER_ID,
  normalizeLegacyCodeAgentOutput,
  normalizeTextDelta,
  persistCodingAgentBackend,
  type AcpPermissionRequestPayload,
  type AgentDonePayload,
  type AgentErrorPayload,
  type CodingAgentBackend,
  type CompatDiffProposedPayload,
  type CompatToolResultPayload,
  type CompatToolStartPayload,
  type DirectDiffProposedPayload,
  type DirectEditIntentRequestPayload,
  type DirectToolResultPayload,
  type DirectToolStartPayload,
  type NormalizedAgentEvent,
  type TextDeltaPayload,
  resolveCodingAgentBackend,
} from './agent-event-adapter'
import {
  isOllamaHealthCheckRequired,
  isOllamaRestartRequired,
  isSendBlockedByOllamaError,
  routeRespondPermission,
  routeSendAgentPrompt,
  routeStopAgent,
  type ActiveRun,
} from './backend-router'
import {
  persistSelectedClineModel,
  resolveSelectedClineModel,
  getCachedClineModels,
  fetchClineCliModels,
  type ClineFreeModel,
} from './backend-identity'
import { useSidebarSafe } from '@/components/ui/sidebar'
import { CodeModelSelector } from './CodeModelSelector'
import { ProviderModelPicker } from './ProviderModelPicker'
import { WorkStateCard } from './WorkStateCard'
import { WorkThreadHeader } from './WorkThreadHeader'
import { SwitchAiDialog } from './SwitchAiDialog'

import { PermissionRequest } from './PermissionRequest'
import './ConversationSummary.css'
import { ContextBudgetIndicator } from './ContextBudgetIndicator'
import { buildConversationSummary } from './conversation-summary'
import { buildCodingAgentPrompt } from './conversation-context'
import { validateContinuationSafety, parseResumePromptToCheckpoint } from './loop-continuation'
import type { EditPermission } from './edit-permission'
import {
  buildModelCapabilitiesByName,
  isCodeAgentToolCompatible,
  type ModelCapabilitiesByName,
  type OllamaModelCapabilities,
} from './code-model-compat'

// ── S6 types ─────────────────────────────────────────────────
interface CodingAgentConfig {
  ollama_url: string
  code_model: string
  vision_model: string
  max_iterations: number
  auto_verify: boolean
}

interface PendingEditIntent {
  id: string
  toolName: string
  filePath: string
}

const CODING_AGENT_CODE_MODEL_STORAGE_KEY = 'coding-agent-code-model'
const CODE_AGENT_DEFAULT_MODEL = 'qwen3-coder:30b'
const CODE_AGENT_FALLBACK_MODELS = [
  CODE_AGENT_DEFAULT_MODEL,
  'qwen3-coder-next',
]

function getStoredCodeModel(): string | null {
  if (typeof window === 'undefined') return null

  try {
    const value = window.localStorage.getItem(CODING_AGENT_CODE_MODEL_STORAGE_KEY)?.trim()
    if (!value) return null
    if (isCodeAgentToolCompatible(value)) return value

    window.localStorage.removeItem(CODING_AGENT_CODE_MODEL_STORAGE_KEY)
    return null
  } catch {
    return null
  }
}

function isOllamaModelInstalled(model: string, installedModels: string[]): boolean {
  const trimmed = model.trim()
  if (!trimmed) return false

  return installedModels.some((installed) => {
    if (installed === trimmed) return true
    if (trimmed.includes(':')) return false
    return installed.startsWith(`${trimmed}:`)
  })
}

function findInstalledModel(model: string | null | undefined, installedModels: string[]): string | null {
  const trimmed = model?.trim()
  if (!trimmed) return null

  for (const installed of installedModels) {
    if (installed === trimmed) return installed
    if (!trimmed.includes(':') && installed.startsWith(`${trimmed}:`)) return installed
  }

  return null
}

function resolveInstalledCodeModel(
  preferredModel: string | null | undefined,
  configuredModel: string | null | undefined,
  installedModels: string[],
  modelCapabilities?: ModelCapabilitiesByName
): string | null {
  const compatibleInstalled = installedModels
    .map((model) => model.trim())
    .filter(Boolean)
    .filter((model) => isCodeAgentToolCompatible(model, modelCapabilities))

  const candidates = [
    preferredModel,
    configuredModel,
    ...CODE_AGENT_FALLBACK_MODELS,
    ...compatibleInstalled,
  ]

  for (const candidate of candidates) {
    if (!candidate || !isCodeAgentToolCompatible(candidate, modelCapabilities)) continue
    const installed = findInstalledModel(candidate, compatibleInstalled)
    if (installed) return installed
  }

  return null
}

function persistSelectedCodeModel(model: string): void {
  try {
    window.localStorage.setItem(CODING_AGENT_CODE_MODEL_STORAGE_KEY, model)
  } catch {
    // Ignore storage failures; the current selection still applies for this session.
  }
}

function withLegacyEditInstruction(prompt: string, editPermission: EditPermission): string {
  if (editPermission === 'allowed') return prompt

  const instruction = editPermission === 'denied'
    ? 'For this request, answer in text only. Do not create, edit, delete, or write files.'
    : 'If this request requires creating, editing, deleting, or writing files, ask the user for confirmation before making changes.'

  return `${instruction}\n\n${prompt}`
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
  'qwen3-coder-next': 52,
  'qwen3-coder:30b': 20,
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
interface HardwareSetupProps {
  ollamaUrl: string
  selectedCodeModel: string
  disabled?: boolean
  onCodeModelChange: (model: string) => void
}

function HardwareSetup({
  ollamaUrl,
  selectedCodeModel,
  disabled = false,
  onCodeModelChange,
}: HardwareSetupProps) {
  const [config, setConfig] = useState<CodingAgentConfig | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [installedModels, setInstalledModels] = useState<string[]>([])
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilitiesByName>({})
  const [pulling, setPulling] = useState<Record<string, boolean>>({})
  const [pullProgress, setPullProgress] = useState<Record<string, string>>({})

  const refreshInstalledModels = useCallback(() => {
    invoke<string[]>('list_ollama_models').then(setInstalledModels).catch(() => {})
    invoke<OllamaModelCapabilities[]>('list_ollama_model_capabilities')
      .then((models) => setModelCapabilities(buildModelCapabilitiesByName(models)))
      .catch(() => setModelCapabilities({}))
  }, [])

  useEffect(() => {
    invoke<CodingAgentConfig>('get_coding_agent_config').then(setConfig).catch(() => {})
    invoke<SystemInfo>('plugin:hardware|get_system_info').then(setSysInfo).catch(() => {})
    refreshInstalledModels()
  }, [refreshInstalledModels])

  useEffect(() => {
    if (!config || installedModels.length === 0) return

    const installedCodeModel = resolveInstalledCodeModel(selectedCodeModel, config.code_model, installedModels, modelCapabilities)
    if (installedCodeModel && installedCodeModel !== selectedCodeModel) {
      onCodeModelChange(installedCodeModel)
    }
  }, [config, installedModels, modelCapabilities, onCodeModelChange, selectedCodeModel])

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
      refreshInstalledModels()
      setPullProgress((p) => ({ ...p, [model]: 'Done' }))
    } catch (err) {
      setPullProgress((p) => ({ ...p, [model]: `Error: ${err}` }))
    } finally {
      setPulling((p) => ({ ...p, [model]: false }))
    }
  }, [ollamaUrl, refreshInstalledModels])

  if (!config) return null

  const modelsToCheck = [
    { label: 'Code model', name: selectedCodeModel || config.code_model, kind: 'code' as const },
    { label: 'Vision model', name: config.vision_model, kind: 'vision' as const },
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
        {modelsToCheck.map(({ label, name, kind }) => {
          const installed = isOllamaModelInstalled(name, installedModels)
          const required = vramRequiredGib(name)
          const tooLarge = required > 0 && effectiveVramGib > 0 && required > effectiveVramGib
          const progress = pullProgress[name]

          return (
            <div key={name} className="rounded border bg-background/50 px-2 py-1.5 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground/70">{label}</span>
                {installed && <IconCircleCheck size={11} className="text-green-500 ml-auto" />}
              </div>
              {kind === 'code' ? (
                <CodeModelSelector
                  value={name}
                  installedModels={installedModels}
                  modelCapabilities={modelCapabilities}
                  disabled={disabled}
                  isPulling={pulling[name]}
                  pullProgress={progress}
                  onChange={onCodeModelChange}
                  onPull={handlePull}
                  onRefresh={refreshInstalledModels}
                />
              ) : (
                <div className="font-mono text-[10px] text-foreground/80 truncate" title={name}>{name}</div>
              )}
              {tooLarge && (
                <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                  <IconAlertCircle size={11} />
                  Needs ~{required} GB — you have {effectiveVramGib.toFixed(0)} GB
                </div>
              )}
              {!installed && kind === 'vision' && (
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
  const {
    projectDir, setProjectDir,
    draftPrompt, setDraftPrompt,
    isRunning, setRunning,
    appendPlanText,
    execLog, appendLog,
    addDiff, clearPendingDiffs,
    pendingDiffs,
    startNewSession, continueSession, setConversationSummary,
    conversationSummary,
    sessions,
    activeSessionId,
  } = useCodingAgentStore()
  const autoApproveTools = useCodingAgentStore((s) => s.autoApproveTools)
  const setAutoApproveTools = useCodingAgentStore((s) => s.setAutoApproveTools)

  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const currentWorkState = currentSession?.workState
  const handleUpdateWorkState = useCallback(
    (patch: Partial<WorkState>) => {
      if (!activeSessionId) return
      useCodingAgentStore.getState().updateWorkState(activeSessionId, patch)
    },
    [activeSessionId]
  )

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const completionHandledRef = useRef(false)
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)
  const [isRestartingOllama, setIsRestartingOllama] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [lastFailureMessage, setLastFailureMessage] = useState<string | null>(null)
  const [pendingEditIntent, setPendingEditIntent] = useState<PendingEditIntent | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const activeRunRef = useRef<ActiveRun | null>(null)
  activeRunRef.current = activeRun
  const autoApproveRef = useRef(true)
  const [lspEnabled, setLspEnabled] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('coding-agent-lsp') === 'true'
    return false
  })
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('coding-agent-lsp', String(lspEnabled))
  }, [lspEnabled])
  const lastAgentErrorRef = useRef<string | null>(null)
  const approvedEditToolCallIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (lspEnabled && projectDir) {
      const initDiagnostics = async () => {
        try {
          await invoke('start_diagnostics_pipeline')
          await invoke('add_workspace_to_diagnostics_pipeline', { workspacePath: projectDir })
        } catch (err) {
          console.error('Failed to initialize diagnostics pipeline:', err)
        }
      }
      void initDiagnostics()
    }
  }, [lspEnabled, projectDir])

  useEffect(() => {
    let cancelled = false
    const unlisteners: (() => void)[] = []

    const setup = async () => {
      const u1 = await listen('lsp-diagnostics-updated', (event) => {
        if (cancelled) return
        const payload = event.payload as { uri: string; diagnostics: any[] }
        let filePath = payload.uri
        try {
          filePath = payload.uri.startsWith('file://')
            ? decodeURIComponent(new URL(payload.uri).pathname)
            : payload.uri
        } catch {
          filePath = payload.uri.startsWith('file://') ? payload.uri.substring(7) : payload.uri
        }
        useCodingAgentStore.getState().setDiagnostics(filePath, payload.diagnostics)
      })

      unlisteners.push(u1)
    }

    setup()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [])

  // ── Loop scheduler ────────────────────────────────────────
  const [loopPopoverOpen, setLoopPopoverOpen] = useState(false)
  const [loopTimes, setLoopTimes] = useState(3)
  const [loopInterval, setLoopInterval] = useState(5)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [loopCount, setLoopCount] = useState(0)
  const [loopPrompt, setLoopPrompt] = useState('')
  const [loopId, setLoopId] = useState<string | null>(null)
  const [loopCountdown, setLoopCountdown] = useState<number | null>(null)
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loopTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [agentConfig, setAgentConfig] = useState<CodingAgentConfig | null>(null)
  const [selectedCodeModel, setSelectedCodeModel] = useState(() => getStoredCodeModel() ?? '')
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilitiesByName>({})
  const [agentBackend, setAgentBackend] = useState<CodingAgentBackend>(() => getInitialCodingAgentBackend())
  const [selectedClineModel, setSelectedClineModel] = useState(() => resolveSelectedClineModel())
  const [pendingPermission, setPendingPermission] = useState<AcpPermissionRequestPayload | null>(null)
  const pendingPermissionRef = useRef<AcpPermissionRequestPayload | null>(null)
  pendingPermissionRef.current = pendingPermission

  const sidebar = useSidebarSafe()
  const isRightPanelOpen = useCodingAgentStore((s) => s.isRightPanelOpen)
  const toggleRightPanel = useCodingAgentStore((s) => s.toggleRightPanel)
  const [clineModels, setClineModels] = useState<ClineFreeModel[]>(() => getCachedClineModels())
  const [ollamaInstalledModels, setOllamaInstalledModels] = useState<string[]>([])

  const [switchAiDialogOpen, setSwitchAiDialogOpen] = useState(false)

  const handleSelectSwitchAi = useCallback(
    (modelId: string, backend: CodingAgentBackend, displayName: string, provider?: string) => {
      if (backend !== agentBackend) {
        setAgentBackend(backend)
        persistCodingAgentBackend(backend)
      }
      if (backend === 'cline-acp') {
        setSelectedClineModel(modelId)
        persistSelectedClineModel(modelId)
      } else {
        setSelectedCodeModel(modelId)
        persistSelectedCodeModel(modelId)
      }

      if (activeSessionId) {
        useCodingAgentStore.getState().setSessionIdentity(activeSessionId, {
          backend,
          modelId,
          providerId: provider,
        })
        useCodingAgentStore.getState().addAIPathStep(activeSessionId, {
          modelId,
          displayName,
          provider,
          backend,
          timestamp: Date.now(),
        })
      }

      appendLog({
        type: 'text_delta',
        content: `Switched active AI to ${displayName} (${backend === 'cline-acp' ? 'Cline ACP' : 'Ollama'}). Continuity preserved in this Work Thread.`,
        timestamp: Date.now(),
      })
    },
    [activeSessionId, agentBackend, appendLog]
  )

  useEffect(() => {
    if (agentBackend === 'cline-acp') {
      void fetchClineCliModels().then((live) => {
        if (live && live.length > 0) {
          setClineModels(live)
        }
      })
    } else if (agentBackend === 'direct-ollama') {
      invoke<string[]>('list_ollama_models')
        .then((m) => setOllamaInstalledModels(m || []))
        .catch(() => {})
    }
  }, [agentBackend])

  useEffect(() => {
    invoke<CodingAgentConfig>('get_coding_agent_config')
      .then((config) => {
        setAgentConfig(config)
        setSelectedCodeModel((current) => {
          const candidate = current || getStoredCodeModel() || config.code_model
          return isCodeAgentToolCompatible(candidate) ? candidate : CODE_AGENT_DEFAULT_MODEL
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (isOllamaHealthCheckRequired(agentBackend)) {
      invoke<OllamaModelCapabilities[]>('list_ollama_model_capabilities')
        .then((models) => setModelCapabilities(buildModelCapabilitiesByName(models)))
        .catch(() => setModelCapabilities({}))
    }
  }, [agentBackend])

  const handleBackendChange = useCallback((backend: CodingAgentBackend) => {
    setAgentBackend(backend)
    persistCodingAgentBackend(backend)
    if (backend === 'cline-acp') {
      setSelectedCodeModel(CLINE_DEFAULT_MODEL_ID)
      persistSelectedCodeModel(CLINE_DEFAULT_MODEL_ID)
    }
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

  useEffect(() => {
    if (isOllamaHealthCheckRequired(agentBackend)) {
      checkOllama()
    }
  }, [agentBackend, checkOllama])

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

    const runSessionId = activeRun?.sessionId ?? useCodingAgentStore.getState().activeSessionId
    if (runSessionId) {
      useCodingAgentStore.getState().setSessionStatus(
        runSessionId,
        success ? 'completed' : 'failed',
        errorMessage ?? undefined
      )
    }

    useCodingAgentStore.getState().saveCurrentSession()
    setPendingPermission(null)
    const runBackend = activeRun?.backend ?? agentBackend
    if (isOllamaRestartRequired(runBackend)) {
      setAgentStatus('restarting')
      invoke('restart_ollama')
        .catch(() => {})
        .finally(() => {
          setActiveRun(null)
          setAgentStatus(success ? 'free' : 'failed')
        })
    } else {
      setActiveRun(null)
      setAgentStatus(success ? 'free' : 'failed')
    }
  }, [activeRun, agentBackend, appendLog, clearLoopSchedule, loopEnabled, setRunning])

  const handleRespondPermission = useCallback(async (requestId: string, optionId: string) => {
    const permission = pendingPermissionRef.current
    if (!permission || permission.requestId !== requestId) return

    try {
      await routeRespondPermission(
        {
          backend: 'cline-acp',
          runId: permission.runId,
          requestId,
          optionId,
          activeRun,
        },
        invoke
      )

      const selectedOption = permission.options?.find((o) => o.optionId === optionId)
      const isApproved =
        selectedOption?.kind === 'allow' ||
        /^(allow|approve|yes)/i.test(optionId)

      const fileEdit = extractPermissionFileEdit(permission)
      const cmd = extractPermissionCommand(permission)

      if (isApproved && fileEdit && permission.toolCallId) {
        approvedEditToolCallIdsRef.current.add(permission.toolCallId)
      }

      let outcomeLog = `Permission '${optionId}': ${permission.title || permission.toolCallId}`
      if (fileEdit) {
        outcomeLog = isApproved
          ? `Permission approved for edit on ${fileEdit.path}. Awaiting agent execution...`
          : `Permission denied for edit on ${fileEdit.path} — changes were NOT applied.`
      } else if (cmd) {
        outcomeLog = isApproved
          ? `Permission approved for command '${cmd}'. Awaiting execution...`
          : `Permission denied for command '${cmd}' — command was NOT executed.`
      }

      appendLog({
        type: 'text_delta',
        content: outcomeLog,
        timestamp: Date.now(),
      })
      setPendingPermission(null)
    } catch (err) {
      appendLog({
        type: 'error',
        content: `Failed to respond to permission request: ${err}`,
        timestamp: Date.now(),
      })
    }
  }, [activeRun, appendLog])

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
      case 'tool_result': {
        const rawOutput = event.output ?? ''
        const wasApprovedEdit = Boolean(event.id && approvedEditToolCallIdsRef.current.has(event.id))
        if (wasApprovedEdit && event.id) {
          approvedEditToolCallIdsRef.current.delete(event.id)
        }
        const isEditTool = Boolean(event.name && /edit|write|replace/i.test(event.name))
        const shouldPrefixApplied =
          (wasApprovedEdit || isEditTool) &&
          !event.isError &&
          !rawOutput.toLowerCase().includes('applied')

        const content = event.isError
          ? `Error: ${rawOutput}`
          : shouldPrefixApplied
          ? `Applied edit: ${rawOutput || 'success'}`
          : rawOutput
        appendLog({
          type: 'tool_result',
          content,
          toolName: event.name,
          timestamp: Date.now(),
        })
        break
      }
      case 'diff_proposed':
        if (!event.id) {
          appendLog({
            type: 'error',
            content: `Diff proposed for ${event.filePath}, but no approval id was provided by the backend.`,
            timestamp: Date.now(),
          })
          break
        }
        addDiff({
          id: event.id,
          filePath: event.filePath,
          search: event.search,
          replace: event.replace,
          status: 'pending',
        })
        if (autoApproveRef.current) {
          void invoke('approve_agent_diff', { callId: event.id })
            .then(() => useCodingAgentStore.getState().updateDiffStatus(event.id, 'approved'))
            .catch((err) => appendLog({ type: 'error', content: String(err), timestamp: Date.now() }))
          appendLog({
            type: 'text_delta',
            content: `Diff auto-approved for ${event.filePath}`,
            timestamp: Date.now(),
          })
        } else {
          appendLog({
            type: 'text_delta',
            content: `Diff proposed for ${event.filePath} — awaiting approval`,
            timestamp: Date.now(),
          })
        }
        break
      case 'permission_request': {
        if (autoApproveTools) {
          const firstAllow = event.options?.find((o) => o.optionId === 'allow_always' || o.optionId === 'allow_once' || o.kind?.includes('allow'))?.optionId || event.options?.[0]?.optionId || 'allow_always'
          pendingPermissionRef.current = event
          handleRespondPermission(event.requestId, firstAllow)
          break
        }
        setPendingPermission(event)
        const cmd = event.command ?? extractPermissionCommand(event)
        const fileEdit = event.filePath ? { path: event.filePath } : extractPermissionFileEdit(event)
        let logContent = `Permission requested: ${event.title || event.toolCallId}`
        if (fileEdit) {
          logContent = `Proposed edit for ${fileEdit.path} — awaiting approval`
        } else if (cmd) {
          logContent = `Command execution requested: '${cmd}' — awaiting approval`
        }
        appendLog({
          type: 'text_delta',
          content: logContent,
          timestamp: Date.now(),
        })
        break
      }
      case 'done':
        setPendingPermission(null)
        if (completionHandledRef.current) return
        completionHandledRef.current = true
        finishAgentRun(event.success, event.success ? null : (event.error ?? lastAgentErrorRef.current ?? 'Agent stopped by user'))
        break
      case 'error':
        setPendingPermission(null)
        lastAgentErrorRef.current = event.message
        appendLog({ type: 'error', content: event.message, timestamp: Date.now() })
        break
    }
  }, [addDiff, appendLog, appendPlanText, autoApproveTools, finishAgentRun, handleRespondPermission])

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
      const u13 = await listen<DirectEditIntentRequestPayload>('agent-edit-intent-request', (e) => {
        if (cancelled) return
        const callId = e.payload.call_id ?? e.payload.callId ?? ''
        const toolName = e.payload.tool_name ?? e.payload.toolName ?? 'file edit'
        if (!callId) {
          appendLog({
            type: 'error',
            content: `File edit intent for ${e.payload.path || toolName} did not include an approval id.`,
            timestamp: Date.now(),
          })
          return
        }
        if (autoApproveRef.current) {
          void invoke('approve_agent_edit_intent', { callId })
            .then(() => {
              appendLog({
                type: 'text_delta',
                content: `File edit intent auto-approved for ${e.payload.path || toolName}.`,
                timestamp: Date.now(),
              })
            })
            .catch((err) => appendLog({ type: 'error', content: String(err), timestamp: Date.now() }))
          return
        }

        setPendingEditIntent({
          id: callId,
          toolName,
          filePath: e.payload.path,
        })
      })

      const uPerm = await listen<AcpPermissionRequestPayload>('cline-permission-request', (e) => {
        const currentActive = activeRunRef.current
        if (!cancelled && (!currentActive || e.payload.runId === currentActive.runId)) {
          handleNormalizedAgentEvent(normalizeAcpPermissionRequest(e.payload))
        }
      })

      const uSessionBound = await listen<{ atomicSessionId: string; externalSessionId: string }>(
        'cline-session-bound',
        (e) => {
          if (cancelled) return
          const { atomicSessionId, externalSessionId } = e.payload
          if (atomicSessionId && externalSessionId) {
            useCodingAgentStore.getState().setSessionIdentity(atomicSessionId, {
              externalSessionId,
            })
          }
        }
      )

      if (cancelled) {
        for (const unlisten of [uRaw, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, u13, uPerm, uSessionBound]) unlisten()
      } else {
        unlisteners.push(uRaw, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, u13, uPerm, uSessionBound)
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
    setPendingPermission(null)
    await routeStopAgent(activeRun, agentBackend, invoke)
  }, [activeRun, agentBackend])

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

  const sendPrompt = useCallback(async (
    prompt: string,
    options: {
      source?: CodingSessionSource
      includeConversationContext?: boolean
      includeSummaryContext?: boolean
      currentRun?: number
      maxRuns?: number
      loopId?: string | null
      overrideModel?: string
    } = {}
  ): Promise<boolean> => {
    if (!projectDir || !prompt.trim()) return false

    if (activeRun) {
      if (!isRunning) {
        setActiveRun(null)
        setAgentStatus('free')
      } else {
        appendLog({
          type: 'error',
          content: `An agent run is already active on backend '${activeRun.backend}'. Stop it first.`,
          timestamp: Date.now(),
        })
        return false
      }
    }

    const source = options.source ?? 'manual'
    const includeConversationContext = options.includeConversationContext ?? source === 'manual'
    const includeSummaryContext = options.includeSummaryContext ?? includeConversationContext
    const currentRun = options.currentRun ?? 1
    const maxRuns = options.maxRuns ?? 1
    const activeLoopId = options.loopId ?? null
    const editPermission: EditPermission = 'allowed'
    const storeState = useCodingAgentStore.getState()
    const activeSession = storeState.sessions.find((session) => session.id === storeState.activeSessionId)
    const activeSessionBackend = activeSession ? resolveCodingAgentBackend(activeSession.backend) : null
    const isProviderSwitch = Boolean(
      activeSession &&
      activeSession.projectDir === projectDir &&
      activeSession.source === source &&
      activeSessionBackend !== agentBackend
    )
    const shouldStartNewSession = !activeSession || activeSession.projectDir !== projectDir || activeSession.source !== source || isProviderSwitch
    const seedFromSessionId = isProviderSwitch ? activeSession?.id : null
    const isClineContinuation = Boolean(
      !shouldStartNewSession &&
      agentBackend === 'cline-acp' &&
      activeSessionBackend === 'cline-acp' &&
      activeSession?.externalSessionId
    )
    const candidateModel = options.overrideModel || selectedCodeModel || agentConfig?.code_model || CODE_AGENT_DEFAULT_MODEL
    let model = candidateModel
    if (isOllamaHealthCheckRequired(agentBackend)) {
      const candidateCompatModel = isCodeAgentToolCompatible(candidateModel, modelCapabilities) ? candidateModel : CODE_AGENT_DEFAULT_MODEL
      model = candidateCompatModel
      try {
        const installedModels = await invoke<string[]>('list_ollama_models')
        let capabilities = modelCapabilities
        try {
          const modelCapabilityList = await invoke<OllamaModelCapabilities[]>('list_ollama_model_capabilities')
          capabilities = buildModelCapabilitiesByName(modelCapabilityList)
          setModelCapabilities(capabilities)
        } catch (capabilityErr) {
          console.warn('Failed to refresh Ollama model capabilities before Code Agent run:', capabilityErr)
        }

        const installedCodeModel = resolveInstalledCodeModel(model, agentConfig?.code_model, installedModels, capabilities)
        if (!installedCodeModel) {
          appendLog({
            type: 'error',
            content: 'No installed code-compatible Ollama model was found. Install or select a code model before running Code Agent.',
            timestamp: Date.now(),
          })
          setLastFailureMessage('✗ No installed code-compatible Ollama model was found.')
          setAgentStatus('failed')
          return false
        }

        model = installedCodeModel
        if (model !== selectedCodeModel) {
          setSelectedCodeModel(model)
          persistSelectedCodeModel(model)
        }
      } catch (err) {
        console.warn('Failed to refresh Ollama models before Code Agent run:', err)
      }
    } else if (agentBackend === 'cline-acp') {
      model = options.overrideModel || selectedClineModel || CLINE_DEFAULT_MODEL_ID
    }
    const promptForAgent = buildCodingAgentPrompt({
      prompt,
      projectDir,
      sessions: storeState.sessions,
      activeSessionId: shouldStartNewSession ? null : storeState.activeSessionId,
      seedFromSessionId,
      backend: agentBackend,
      source,
      isContinuation: isClineContinuation,
      includeHistory: includeConversationContext,
      includeSummaryContext,
    })
    let targetSessionId = storeState.activeSessionId
    if (shouldStartNewSession) {
      startNewSession(prompt, undefined, source, {
        backend: agentBackend,
        providerId: agentBackend === 'cline-acp' ? CLINE_DEFAULT_PROVIDER_ID : undefined,
        modelId: model,
        externalSessionId: undefined,
        status: 'running',
      })
      targetSessionId = useCodingAgentStore.getState().activeSessionId
    } else {
      continueSession(prompt, source)
      clearPendingDiffs()
      if (targetSessionId) {
        useCodingAgentStore.getState().setSessionIdentity(targetSessionId, {
          backend: agentBackend,
          providerId: agentBackend === 'cline-acp' ? CLINE_DEFAULT_PROVIDER_ID : undefined,
          modelId: model,
        })
        useCodingAgentStore.getState().setSessionStatus(targetSessionId, 'running')
      }
    }
    completionHandledRef.current = false
    lastAgentErrorRef.current = null
    setLastFailureMessage(null)
    setRunning(true)
    setAgentStatus('running')
    appendLog({ type: 'text_delta', content: `> ${prompt}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: `Backend: ${agentBackend}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: `Model: ${model}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: `LSP Tools: ${lspEnabled ? 'enabled' : 'disabled'}`, timestamp: Date.now() })
    appendLog({ type: 'text_delta', content: 'Starting agent…', timestamp: Date.now() })

    try {
      let finalPrompt = promptForAgent
      if (source === 'loop' && currentRun > 1) {
        let resumePrompt: string | null = null
        if (activeLoopId) {
          try {
            resumePrompt = await invoke<string | null>('get_loop_resume_prompt', {
              loopId: activeLoopId,
              runNumber: currentRun - 1,
            })
          } catch (err) {
            console.warn('[Loop] Failed to load resume prompt:', err)
          }
        }

        const checkpoint = resumePrompt && activeLoopId
          ? parseResumePromptToCheckpoint(resumePrompt, activeLoopId, projectDir, maxRuns)
          : null

        const safety = validateContinuationSafety({
          activeLoopId,
          currentRun,
          maxRuns,
          projectDir,
          targetBackend: agentBackend,
          activeSession,
          checkpoint,
        })

        if (!safety.safe) {
          const errorMsg = safety.error || 'Continuation safety failure'
          appendLog({ type: 'text_delta', content: `[Loop Safety Error] ${errorMsg}`, timestamp: Date.now() })
          setAgentStatus('failed')
          setRunning(false)
          setLastFailureMessage(errorMsg)
          return false
        }

        if (safety.resumePrompt) {
          finalPrompt = `${safety.resumePrompt}\n\n${promptForAgent}`
        }
      }

      const sendResult = await routeSendAgentPrompt(
        {
          backend: agentBackend,
          projectDir,
          prompt:
            agentBackend === 'direct-ollama' || agentBackend === 'cline-acp'
              ? finalPrompt
              : withLegacyEditInstruction(finalPrompt, editPermission),
          model,
          sessionId: isClineContinuation
            ? (activeSession?.externalSessionId ?? targetSessionId ?? activeSession?.id)
            : (targetSessionId ?? activeSession?.id),
          activeRun,
          ollamaBaseUrl: agentConfig?.ollama_url ?? 'http://localhost:11434',
          editPermission,
          lspEnabled,
          source,
          currentRun,
          maxRuns,
          loopId: activeLoopId,
          autoApprove: autoApproveTools,
        },
        invoke
      )
      setActiveRun({
        ...sendResult.activeRun,
        sessionId: targetSessionId ?? sendResult.activeRun.sessionId,
      })
      if (agentBackend !== 'cline-acp' && sendResult.activeRun.sessionId && targetSessionId) {
        useCodingAgentStore.getState().setSessionIdentity(targetSessionId, {
          externalSessionId: sendResult.activeRun.sessionId,
        })
      }
      return true
    } catch (err) {
      setActiveRun(null)
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
      setRunning(false)
      if (targetSessionId) {
        useCodingAgentStore.getState().setSessionStatus(targetSessionId, 'failed', String(err))
      }
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
      return false
    }
  }, [projectDir, selectedCodeModel, selectedClineModel, agentConfig, agentBackend, activeRun, autoApproveTools, setRunning, appendLog, startNewSession, continueSession, clearPendingDiffs, loopEnabled, clearLoopSchedule])

  const handleDeleteTurn = useCallback(
    (timestamp: number) => {
      if (isRunning) return

      const currentExecLog = useCodingAgentStore.getState().execLog
      const turn = getTurnIndices(currentExecLog, timestamp)
      if (!turn) return

      const updatedLog = [
        ...currentExecLog.slice(0, turn.startIndex),
        ...currentExecLog.slice(turn.endIndex),
      ]

      useCodingAgentStore.setState({ execLog: updatedLog })

      const { activeSessionId, sessions } = useCodingAgentStore.getState()
      if (activeSessionId) {
        if (updatedLog.length === 0) {
          const updatedSessions = sessions.map((s) => {
            if (s.id === activeSessionId) {
              return { ...s, execLog: [], planText: '' }
            }
            return s
          })
          useCodingAgentStore.setState({ sessions: updatedSessions, planText: '' })
        } else {
          const remainingPrompt =
            updatedLog.find((l) => l.content.trimStart().startsWith('>'))?.content.replace(/^>\s*/, '') ?? ''
          const updatedSessions = sessions.map((s) => {
            if (s.id === activeSessionId) {
              return {
                ...s,
                prompt: remainingPrompt || s.prompt,
                execLog: updatedLog,
              }
            }
            return s
          })
          useCodingAgentStore.setState({ sessions: updatedSessions })
        }
      }
    },
    [isRunning]
  )

  const handleEditPrompt = useCallback(
    async (timestamp: number, newText: string) => {
      const trimmed = newText.trim()
      if (!trimmed || isRunning) return

      const currentExecLog = useCodingAgentStore.getState().execLog
      const turn = getTurnIndices(currentExecLog, timestamp)
      if (!turn) return

      // Slice off this turn and any subsequent turns (standard chat edit-branch behavior)
      const trimmedLog = currentExecLog.slice(0, turn.startIndex)
      useCodingAgentStore.setState({ execLog: trimmedLog })

      const { activeSessionId, sessions } = useCodingAgentStore.getState()
      if (activeSessionId) {
        const remainingFirstPrompt =
          trimmedLog.find((l) => l.content.trimStart().startsWith('>'))?.content.replace(/^>\s*/, '') || trimmed
        const updatedSessions = sessions.map((s) => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              prompt: remainingFirstPrompt,
              execLog: trimmedLog,
            }
          }
          return s
        })
        useCodingAgentStore.setState({ sessions: updatedSessions })
      }

      await sendPrompt(trimmed)
    },
    [isRunning, sendPrompt]
  )

  const handleClineModelChange = useCallback((model: string) => {
    if (model === selectedClineModel) return

    setSelectedClineModel(model)
    persistSelectedClineModel(model)

    const storeState = useCodingAgentStore.getState()
    if (storeState.activeSessionId) {
      storeState.setSessionIdentity(storeState.activeSessionId, {
        backend: agentBackend,
        providerId: CLINE_DEFAULT_PROVIDER_ID,
        modelId: model,
      })
    }
  }, [selectedClineModel, agentBackend])

  const handleCodeModelChange = useCallback((model: string) => {
    if (!isCodeAgentToolCompatible(model, modelCapabilities)) return
    if (model === selectedCodeModel) return

    setSelectedCodeModel(model)
    persistSelectedCodeModel(model)

    const storeState = useCodingAgentStore.getState()
    if (storeState.activeSessionId) {
      storeState.setSessionIdentity(storeState.activeSessionId, {
        backend: agentBackend,
        modelId: model,
      })
    }
  }, [selectedCodeModel, modelCapabilities, agentBackend])

  const sendPromptRef = useRef(sendPrompt)

  useEffect(() => {
    sendPromptRef.current = sendPrompt
  }, [sendPrompt])

  const handleSend = useCallback(async () => {
    if (!projectDir || !draftPrompt.trim()) return
    const prompt = draftPrompt
    setDraftPrompt('')
    if (loopEnabled) {
      const newLoopId = crypto.randomUUID()
      setLoopId(newLoopId)
      setLoopCount(1)
      setLoopPrompt(prompt)
      const success = await sendPrompt(prompt, {
        source: 'loop',
        includeConversationContext: false,
        includeSummaryContext: false,
        currentRun: 1,
        maxRuns: loopTimes,
        loopId: newLoopId,
      })
      if (!success) {
        setDraftPrompt(prompt)
        setLoopId(null)
        setLoopCount(0)
        setLoopPrompt('')
      }
    } else {
      const success = await sendPrompt(prompt, {
        source: 'manual',
        includeConversationContext: true,
        includeSummaryContext: true,
      })
      if (!success) {
        setDraftPrompt(prompt)
      }
    }
  }, [projectDir, draftPrompt, loopEnabled, loopTimes, setDraftPrompt, sendPrompt, setLoopCount, setLoopPrompt, setLoopId])

  const handleSummarizeConversation = useCallback(async () => {
    const storeState = useCodingAgentStore.getState()
    const session = storeState.sessions.find((item) => item.id === storeState.activeSessionId)
    if (!session || session.projectDir !== projectDir || session.source === 'loop' || loopEnabled) return

    const summary = buildConversationSummary(session)
    if (!summary) return

    setConversationSummary(summary)

    try {
      await navigator.clipboard.writeText(summary)
      appendLog({
        type: 'text_delta',
        content: '\n[System] Conversation summary copied to clipboard! You can paste it into a new chat to continue.',
        timestamp: Date.now(),
      })
    } catch (err) {
      console.warn('Failed to copy summary to clipboard:', err)
    }
  }, [loopEnabled, projectDir, setConversationSummary, appendLog])

  // ── Loop trigger ──────────────────────────────────────────
  useEffect(() => {
    if (agentStatus !== 'free' || !loopEnabled) return

    // All runs done — reset everything
    if (loopCount >= loopTimes) {
      setLoopEnabled(false)
      setLoopCount(0)
      setLoopPrompt('')
      setLoopId(null)
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
      const nextRun = loopCount + 1
      setLoopCount(nextRun)
      await sendPromptRef.current(loopPrompt, {
        source: 'loop',
        includeConversationContext: false,
        includeSummaryContext: false,
        currentRun: nextRun,
        maxRuns: loopTimes,
        loopId,
      })
    }, seconds * 1000)

    return () => {
      clearTimeout(loopTimerRef.current!)
      clearInterval(loopTickRef.current!)
    }
  }, [agentStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(async () => {
    completionHandledRef.current = true
    try { await stopSelectedBackend() } catch { /* ignore */ }
    setRunning(false)
    setActiveRun(null)
    setAgentStatus('free')
    setPendingPermission(null)
    const runSessionId = activeRun?.sessionId ?? useCodingAgentStore.getState().activeSessionId
    if (runSessionId) {
      useCodingAgentStore.getState().markSessionInterrupted(runSessionId, 'User stopped run')
      useCodingAgentStore.getState().saveCurrentSession()
    }
    setLoopEnabled(false)
    setLoopId(null)
    setLoopCountdown(null)
    clearTimeout(loopTimerRef.current!)
    clearInterval(loopTickRef.current!)
    setLastFailureMessage(null)
  }, [activeRun, setRunning, stopSelectedBackend])

  useEffect(() => {
    if (!activeSessionId) return
    const session = sessions.find((s) => s.id === activeSessionId)
    if (!session) return

    if (session.backend) {
      setAgentBackend(session.backend)
      persistCodingAgentBackend(session.backend)
    }

    if (session.modelId) {
      if (session.backend === 'cline-acp') {
        setSelectedClineModel(session.modelId)
        persistSelectedClineModel(session.modelId)
      } else {
        setSelectedCodeModel(session.modelId)
        persistSelectedCodeModel(session.modelId)
      }
    }
  }, [activeSessionId, sessions])

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

  const handleEditIntentDecision = useCallback(async (approved: boolean) => {
    if (!pendingEditIntent) return

    const intent = pendingEditIntent
    setPendingEditIntent(null)

    try {
      await invoke(approved ? 'approve_agent_edit_intent' : 'reject_agent_edit_intent', { callId: intent.id })
      appendLog({
        type: 'text_delta',
        content: approved ? 'File edits approved for this request.' : 'Answer-only selected for this request.',
        timestamp: Date.now(),
      })
    } catch (err) {
      appendLog({ type: 'error', content: String(err), timestamp: Date.now() })
    }
  }, [appendLog, pendingEditIntent])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    },
    [handleSend]
  )

  const displayLog = useMemo(() => mergeStreamingLog(execLog), [execLog])
  const activeManualSession = useMemo(() => {
    const session = sessions.find((item) => item.id === activeSessionId)
    if (!session || session.projectDir !== projectDir || session.source === 'loop') return null
    if (!session.prompt.trim() && !session.planText.trim() && session.execLog.length === 0) return null
    return session
  }, [activeSessionId, projectDir, sessions])
  const activeLoopSession = useMemo(() => {
    const session = sessions.find((item) => item.id === activeSessionId)
    if (!session || session.projectDir !== projectDir || session.source !== 'loop') return null
    return session
  }, [activeSessionId, projectDir, sessions])
  const contextCharacterCount = useMemo(() => {
    if (loopEnabled) {
      const loopSessionChars = activeLoopSession
        ? activeLoopSession.planText.length +
          activeLoopSession.execLog.reduce((total, line) => total + line.content.length, 0)
        : 0

      return loopPrompt.length + loopSessionChars
    }

    const sessionChars = activeManualSession
      ? activeManualSession.prompt.length +
        activeManualSession.planText.length +
        activeManualSession.execLog.reduce((total, line) => total + line.content.length, 0)
      : 0

    return draftPrompt.length + sessionChars
  }, [activeLoopSession, activeManualSession, draftPrompt, loopEnabled, loopPrompt])

  const handleCopyLog = useCallback(() => {
    const text = execLog.map((l) => l.content).join('\n')
    void navigator.clipboard.writeText(text)
  }, [execLog])

  return (
    <div className="flex flex-1 min-h-0 h-full overflow-hidden bg-[#0a0d13]">
      {/* ── Center Main Workbench ────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0a0d13] overflow-hidden relative">
        {/* Ollama error banner */}
        {isSendBlockedByOllamaError(agentBackend, ollamaError) && ollamaError && (
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

        {/* Work Thread Header: Title, Status, AI Path, Switch AI & Progressive Diagnostics */}
        <WorkThreadHeader
          title={currentSession?.prompt?.trim() || currentWorkState?.goal || 'New Work Thread'}
          status={agentStatus}
          activeAiName={
            agentBackend === 'cline-acp'
              ? (clineModels.find((m) => m.id === selectedClineModel)?.name || selectedClineModel)
              : selectedCodeModel
          }
          connectionMethod={agentBackend === 'cline-acp' ? 'Cline ACP' : 'Direct Ollama'}
          aiPath={currentSession?.aiPath}
          isRunning={isRunning}
          loopInfo={
            loopEnabled
              ? `${loopCount}/${loopTimes}${
                  loopCountdown !== null
                    ? ` · ${Math.floor(loopCountdown / 60)}:${String(loopCountdown % 60).padStart(2, '0')}`
                    : ''
                }`
              : undefined
          }
          isSidebarOpen={sidebar?.open ?? true}
          onToggleSidebar={sidebar ? () => sidebar.toggleSidebar() : undefined}
          isRightPanelOpen={isRightPanelOpen}
          onToggleRightPanel={toggleRightPanel}
          onOpenSwitchAi={() => setSwitchAiDialogOpen(true)}
          onClearSession={() => {
            useCodingAgentStore.getState().clearSession()
            setActiveRun(null)
            setRunning(false)
            setAgentStatus('free')
            setPendingPermission(null)
          }}
          onCopyLog={handleCopyLog}
          hasLogs={execLog.length > 0}
          showOllamaRestart={!isRunning && isOllamaHealthCheckRequired(agentBackend)}
          isRestartingOllama={isRestartingOllama}
          onRestartOllama={restartOllama}
        />

        {lastFailureMessage && !isRunning && (
          <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-2 shrink-0">
            <IconAlertCircle size={15} className="text-destructive shrink-0" />
            <p className="text-xs text-destructive truncate" title={lastFailureMessage}>
              {lastFailureMessage}
            </p>
          </div>
        )}

        {/* Execution log & conversation area */}
        <div className="relative flex-1 min-h-0">
          <StickToBottom className="absolute inset-0 overflow-y-hidden" initial="smooth" resize="smooth">
            <StickToBottom.Content className="px-5 py-4 space-y-3">
              {execLog.length === 0 && !isRunning && (
                <div className="text-center mt-16 text-slate-500 text-sm">
                  {projectDir ? 'Describe what to build or fix below.' : 'Select a project directory on the right to begin.'}
                </div>
              )}
              {displayLog.map((line, i) => (
                <LogLine
                  key={line.timestamp ? `${line.timestamp}-${i}` : i}
                  line={line}
                  isStreaming={isRunning && i === displayLog.length - 1}
                  isRunning={isRunning}
                  onEditPrompt={handleEditPrompt}
                  onDeleteTurn={handleDeleteTurn}
                />
              ))}
              {isRunning && (
                <div className="text-xs text-slate-400 py-1">
                  <Shimmer duration={1.2}>Running…</Shimmer>
                </div>
              )}
            </StickToBottom.Content>
            <ConversationScrollButton />
          </StickToBottom>
        </div>

        {/* Permission Request */}
        {pendingPermission && (
          <div className="shrink-0 px-4 pt-2">
            <PermissionRequest
              request={pendingPermission}
              onRespond={handleRespondPermission}
              disabled={!isRunning}
            />
          </div>
        )}

        {/* Bottom Prompt Composer & Context Metrics */}
        <div className="shrink-0 p-4 border-t border-[#1a212f] bg-[#0c1017]/95">
          <div className="flex items-center justify-between text-[11px] mb-2 px-1 text-slate-400">
            <ContextBudgetIndicator
              characterCount={contextCharacterCount}
              contextEnabled={true}
            />
            <div className="flex items-center gap-2">
              {conversationSummary && !loopEnabled && (
                <span className="text-[10px] font-mono text-emerald-400">Summary saved</span>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 text-xs text-sky-400 hover:text-sky-300 hover:bg-sky-950/30 transition-colors cursor-pointer"
                onClick={handleSummarizeConversation}
                disabled={isRunning || loopEnabled || !activeManualSession}
                title="Summarize & continue"
              >
                <IconCircleCheck size={13} />
                Summarize & continue
              </Button>
            </div>
          </div>

          <div className="relative bg-[#131722] border border-[#222b3d] focus-within:border-sky-500 rounded-xl shadow-lg transition-all">
            <textarea
              ref={textareaRef}
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isSendBlockedByOllamaError(agentBackend, ollamaError) ? 'Ollama required' :
                projectDir ? 'Describe what to build or fix...' :
                'Select a project folder first'
              }
              disabled={!projectDir || isRunning || isSendBlockedByOllamaError(agentBackend, ollamaError)}
              dir={getTextDirection(draftPrompt)}
              className="w-full bg-transparent border-0 focus:ring-0 text-xs sm:text-sm text-slate-100 placeholder-slate-500 p-3 resize-none leading-relaxed outline-none"
              rows={2}
              style={{ minHeight: '60px', maxHeight: '180px', fieldSizing: 'content' } as React.CSSProperties}
            />

            <div className="flex items-center justify-between px-3 py-2 border-t border-[#1c2332] bg-[#111520] rounded-b-xl">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-[#1a2130] rounded transition-colors cursor-pointer"
                  title="Attach file"
                  onClick={handleSelectFolder}
                >
                  <IconPaperclip className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono font-bold text-slate-400 p-1.5 cursor-pointer hover:text-slate-200">@</span>
                <span className="h-3.5 w-px bg-slate-700 mx-0.5"></span>
                <button
                  type="button"
                  onClick={() => setLspEnabled((v) => !v)}
                  title={lspEnabled ? 'LSP Tools ON — click to disable' : 'LSP Tools OFF — click to enable'}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-mono rounded border flex items-center gap-1 transition-colors cursor-pointer',
                    lspEnabled
                      ? 'bg-sky-950/70 text-sky-300 border-sky-800/60'
                      : 'bg-muted/40 text-slate-400 border-slate-700/60'
                  )}
                >
                  <IconCircleCheck size={11} className={lspEnabled ? 'text-sky-400' : 'text-slate-500'} />
                  LSP
                </button>
                <span className="h-3.5 w-px bg-slate-700 mx-0.5" />
                {agentBackend === 'cline-acp' ? (
                  <select
                    aria-label="Select Model"
                    disabled={isRunning}
                    value={selectedClineModel}
                    onChange={(e) => handleClineModelChange(e.target.value)}
                    className="h-6 text-[11px] bg-[#10141d] hover:bg-[#161c28] text-slate-200 border border-[#273244] focus:border-sky-500 rounded-md px-2 py-0 outline-none font-medium cursor-pointer max-w-[210px] truncate"
                  >
                    {clineModels.map((m) => (
                      <option key={m.id} value={m.id} className="bg-[#10141d] text-slate-100">
                        {`${m.name} (${m.provider})${m.tag ? ' • ' + m.tag : ''}`}
                      </option>
                    ))}
                  </select>
                ) : ollamaInstalledModels.length > 0 ? (
                  <select
                    aria-label="Select Model"
                    disabled={isRunning}
                    value={selectedCodeModel}
                    onChange={(e) => handleCodeModelChange(e.target.value)}
                    className="h-6 text-[11px] bg-[#10141d] hover:bg-[#161c28] text-slate-200 border border-[#273244] focus:border-sky-500 rounded-md px-2 py-0 outline-none font-medium cursor-pointer max-w-[210px] truncate"
                  >
                    {ollamaInstalledModels.map((m) => (
                      <option key={m} value={m} className="bg-[#10141d] text-slate-100">
                        {m}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                {!isRunning && (
                  <div className="relative">
                    <button
                      type="button"
                      className="p-1 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                      onClick={() => setLoopPopoverOpen((v) => !v)}
                      title="Execution Timeout / Loop Limit"
                    >
                      <IconClock className="w-4 h-4" />
                    </button>
                    {loopPopoverOpen && (
                      <div className="absolute bottom-full right-0 mb-2 w-52 rounded-xl border border-[#273244] bg-[#10141d] shadow-lg p-3 z-50 flex flex-col gap-2">
                        <p className="text-xs font-semibold text-slate-200">Loop scheduler</p>
                        <label className="flex flex-col gap-0.5">
                          <span className="text-xs text-slate-400">Times (total runs)</span>
                          <input
                            type="number" min={1} max={100}
                            value={loopTimes}
                            onChange={(e) => setLoopTimes(Math.max(1, Number(e.target.value)))}
                            className="rounded-md border border-[#273244] bg-[#161c26] text-slate-200 px-2 py-1 text-sm outline-none w-full"
                          />
                        </label>
                        <label className="flex flex-col gap-0.5">
                          <span className="text-xs text-slate-400">Loop time (minutes)</span>
                          <input
                            type="number" min={1} max={1440}
                            value={loopInterval}
                            onChange={(e) => setLoopInterval(Math.max(1, Number(e.target.value)))}
                            className="rounded-md border border-[#273244] bg-[#161c26] text-slate-200 px-2 py-1 text-sm outline-none w-full"
                          />
                        </label>
                        <Button
                          size="sm" className="w-full mt-1 bg-sky-500 hover:bg-sky-400 text-white"
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
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-7 h-7 rounded-lg bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-md transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                    title="Stop agent"
                  >
                    <IconPlayerStop size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!projectDir || !draftPrompt.trim() || isSendBlockedByOllamaError(agentBackend, ollamaError)}
                    className="w-7 h-7 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center shadow-md transition-transform hover:scale-105 active:scale-95 glow-cyan cursor-pointer"
                    title="Run Agent (Enter)"
                  >
                    <IconArrowUp size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right Panel: Workspace, Backend, Model & Permissions ── */}
      {isRightPanelOpen && (
        <aside className="w-72 shrink-0 border-l border-[#1a202c] bg-[#10141d] flex flex-col justify-between p-3 select-none text-xs overflow-y-auto">
          <div className="space-y-4">
            <WorkStateCard
              workState={currentWorkState}
              onUpdateWorkState={handleUpdateWorkState}
              disabled={isRunning}
            />

            {/* Active AI & Switch AI Card */}
            <div className="rounded-xl border border-sky-500/20 bg-[#141a27] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold tracking-wider uppercase text-sky-400">Active AI</span>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sky-950/80 border border-sky-800/40 text-sky-300">
                  {agentBackend === 'cline-acp' ? 'Cline ACP' : 'Direct Ollama'}
                </span>
              </div>
              <div className="font-mono text-xs font-semibold text-slate-100 truncate">
                {agentBackend === 'cline-acp'
                  ? (clineModels.find((m) => m.id === selectedClineModel)?.name || selectedClineModel)
                  : selectedCodeModel}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setSwitchAiDialogOpen(true)}
                disabled={isRunning}
                className="w-full h-7 text-xs bg-sky-500 hover:bg-sky-400 text-white gap-1.5 font-medium shadow-xs mt-1"
              >
                <IconArrowsExchange size={14} />
                <span>Switch AI / Continue Task</span>
              </Button>
            </div>

            {/* Workspace Directory */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                Workspace Directory
              </label>
              <button
                type="button"
                onClick={handleSelectFolder}
                disabled={isRunning}
                className="w-full flex items-center gap-2 px-2.5 py-2 bg-[#171c26] hover:bg-[#1c2330] border border-[#232a39] rounded-lg text-slate-300 transition-colors text-left cursor-pointer group"
                title={projectDir ?? 'Select project'}
              >
                <IconFolderOpen className="w-4 h-4 text-sky-400 shrink-0 group-hover:scale-105 transition-transform" />
                <span className="font-mono text-[11px] truncate text-slate-200 flex-1">
                  {projectDir || 'Select project...'}
                </span>
              </button>
            </div>

            {/* Backend Provider Selector & Model Config */}
            <ProviderModelPicker
              showSelector={false}
              backend={agentBackend}
              onBackendChange={handleBackendChange}
            selectedModel={agentBackend === 'cline-acp' ? selectedClineModel : selectedCodeModel}
            onModelChange={(model) => {
              if (agentBackend === 'cline-acp') {
                handleClineModelChange(model)
              } else {
                handleCodeModelChange(model)
              }
            }}
            disabled={isRunning}
          >
            {isOllamaHealthCheckRequired(agentBackend) && (
              <HardwareSetup
                ollamaUrl={agentConfig?.ollama_url ?? 'http://localhost:11434'}
                selectedCodeModel={selectedCodeModel}
                disabled={isRunning}
                onCodeModelChange={handleCodeModelChange}
              />
            )}
          </ProviderModelPicker>

          {/* Auto-Approve Tools */}
          {agentBackend === 'cline-acp' && (
            <div className="flex items-center justify-between px-1 py-1">
              <span className="text-xs text-slate-300 font-medium">Auto-Approve Tools</span>
              <Switch
                checked={autoApproveTools}
                onCheckedChange={setAutoApproveTools}
                disabled={isRunning}
              />
            </div>
          )}

          {/* Pending Diffs (if any) */}
          {pendingDiffs.filter((d) => d.status === 'pending').length > 0 && (
            <div className="pt-2 border-t border-[#1a202c]">
              <div className="flex items-center gap-2 mb-2 text-slate-400 font-semibold text-[10px] uppercase tracking-wider">
                <IconFileCode size={13} className="text-sky-400" />
                <span>Diffs ({pendingDiffs.filter((d) => d.status === 'pending').length} pending)</span>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {pendingDiffs.filter((d) => d.status === 'pending').map((diff) => (
                  <div key={diff.id} className="rounded-lg border border-[#232c3d] bg-[#141822] p-2 text-xs">
                    <p className="font-mono text-[10px] text-slate-400 truncate mb-1" title={diff.filePath}>
                      {diff.filePath.split('/').slice(-2).join('/')}
                    </p>
                    {diff.search && (
                      <div className="rounded bg-red-500/10 border border-red-500/20 px-1.5 py-1 mb-1 font-mono text-[10px] text-red-400 max-h-24 overflow-auto whitespace-pre-wrap">
                        -{diff.search.split('\n').slice(0, 6).join('\n')}
                      </div>
                    )}
                    <div className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-1 mb-2 font-mono text-[10px] text-emerald-400 max-h-24 overflow-auto whitespace-pre-wrap">
                      +{diff.replace.split('\n').slice(0, 6).join('\n')}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm" variant="outline"
                        className="flex-1 h-6 text-[10px] text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
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
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Project File Tree (if project open) */}
          {projectDir && (
            <div className="pt-2 border-t border-[#1a202c]">
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                Files
              </label>
              <div className="max-h-52 overflow-y-auto">
                <ProjectFileTree projectDir={projectDir} />
              </div>
            </div>
          )}
        </div>
      </aside>
      )}

      <Dialog open={Boolean(pendingEditIntent)} onOpenChange={(open) => {
        if (!open && pendingEditIntent) void handleEditIntentDecision(false)
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Allow File Edits?</DialogTitle>
            <DialogDescription>
              The agent wants to use {pendingEditIntent?.toolName ?? 'a file edit tool'} for this request.
            </DialogDescription>
          </DialogHeader>
          {pendingEditIntent?.filePath && (
            <p className="rounded border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground break-all">
              {pendingEditIntent.filePath}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => void handleEditIntentDecision(false)}>
              Answer only
            </Button>
            <Button onClick={() => void handleEditIntentDecision(true)}>
              Approve edits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SwitchAiDialog
        open={switchAiDialogOpen}
        onOpenChange={setSwitchAiDialogOpen}
        currentModelId={agentBackend === 'cline-acp' ? selectedClineModel : selectedCodeModel}
        currentBackend={agentBackend}
        clineModels={clineModels}
        ollamaModels={ollamaInstalledModels}
        onSelectAi={handleSelectSwitchAi}
        disabled={isRunning}
      />

    </div>
  )
}

// ── Project file tree (shallow listing) ───────────────────────
function ProjectFileTree({ projectDir }: { projectDir: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const diagnostics = useCodingAgentStore((s) => s.diagnostics)

  useEffect(() => {
    setLoading(true)
    invoke<string[]>('list_dir_shallow', { path: projectDir })
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [projectDir])

  if (loading) return <IconLoader2 size={14} className="animate-spin text-muted-foreground mx-auto mt-4" />

  const getDiagnosticCount = (filePath: string) => {
    const normalized = filePath.split('/').pop() || filePath
    return Object.entries(diagnostics).reduce((count, [key, diags]) => {
      if (key.split('/').pop() === normalized || key.endsWith('/' + normalized)) {
        return count + diags.length
      }
      return count
    }, 0)
  }

  return (
    <ul className="space-y-0.5">
      {files.map((f) => {
        const diagCount = getDiagnosticCount(f)
        return (
          <li key={f} className="flex items-center gap-1.5 py-0.5 px-1 rounded text-xs text-muted-foreground hover:bg-muted/40 cursor-default truncate">
            <IconFileCode size={12} className="shrink-0 opacity-60" />
            <span className="truncate flex-1">{f.split('/').pop()}</span>
            {diagCount > 0 && (
              <span className="flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded text-[9px] font-semibold bg-red-500 text-white">
                {diagCount}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const TEXT_DELTA_STATUS_PREFIXES = [
  '>',
  'Backend:',
  'Model:',
  'Starting agent',
  'Ollama agent started',
  'Agent iteration',
  'Diff proposed for',
  'Permission',
]

function isMergeableTextDelta(line: ExecLogLine): boolean {
  if (line.type !== 'text_delta' && line.type !== 'thinking') return false

  const content = line.content.trimStart()
  if (!content) return false

  if (line.type === 'thinking') return true

  return !TEXT_DELTA_STATUS_PREFIXES.some((prefix) => content.startsWith(prefix))
}

function mergeStreamingLog(lines: ExecLogLine[]): ExecLogLine[] {
  return lines.reduce<ExecLogLine[]>((merged, line) => {
    if (!isMergeableTextDelta(line)) {
      merged.push(line)
      return merged
    }

    const last = merged.at(-1)
    if (last && isMergeableTextDelta(last) && last.type === line.type) {
      merged[merged.length - 1] = {
        ...last,
        content: `${last.content}${line.content}`,
        timestamp: line.timestamp,
      }
    } else {
      merged.push(line)
    }

    return merged
  }, [])
}

export function getTurnIndices(
  execLog: ExecLogLine[],
  promptTimestamp: number,
  promptContent?: string
): { startIndex: number; endIndex: number } | null {
  let startIndex = execLog.findIndex(
    (l) =>
      l.timestamp === promptTimestamp &&
      (promptContent ? l.content === promptContent : l.content.trimStart().startsWith('>'))
  )
  if (startIndex === -1 && promptContent) {
    startIndex = execLog.findIndex((l) => l.content === promptContent)
  }
  if (startIndex === -1) return null

  let endIndex = startIndex + 1
  while (endIndex < execLog.length && !execLog[endIndex].content.trimStart().startsWith('>')) {
    endIndex++
  }
  return { startIndex, endIndex }
}

// ── Execution log line ────────────────────────────────────────
export function LogLine({
  line,
  isStreaming,
  onEditPrompt,
  onDeleteTurn,
  isRunning,
}: {
  line: ExecLogLine
  isStreaming?: boolean
  onEditPrompt?: (timestamp: number, newText: string) => void
  onDeleteTurn?: (timestamp: number) => void
  isRunning?: boolean
}) {
  switch (line.type) {
    case 'tool_start': {
      const input = tryParse(line.content)
      return (
        <Tool state="input-available" className="my-1">
          <ToolHeader title={line.toolName ?? 'Tool'} type={`tool-${line.toolName}` as `tool-${string}`} state="input-available" />
          <ToolContent>{input && <ToolInput input={input} />}</ToolContent>
        </Tool>
      )
    }
    case 'tool_result': {
      const isError = line.content.toLowerCase().includes('error')
      const state = isError ? ('output-error' as const) : ('output-available' as const)
      return (
        <Tool state={state} className="my-1">
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
      return (
        <div className="my-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-start gap-2.5 break-words">
          <IconAlertCircle size={15} className="shrink-0 mt-0.5" />
          <div className="flex-1 whitespace-pre-wrap">{line.content}</div>
        </div>
      )
    case 'done':
      return (
        <div className="flex items-center justify-center my-4 select-none">
          <div className="h-px bg-gradient-to-r from-transparent via-[#232c3d] to-transparent flex-1" />
          <div className="px-3 py-1 bg-[#101a1c] border border-emerald-500/30 rounded-full flex items-center gap-1.5 text-[10px] font-mono text-emerald-400 shrink-0 mx-4 shadow-sm">
            <IconCircleCheck size={12} className="text-emerald-400" />
            AGENT FINISHED
          </div>
          <div className="h-px bg-gradient-to-r from-transparent via-[#232c3d] to-transparent flex-1" />
        </div>
      )
    case 'thinking':
      return (
        <Reasoning className="my-2 bg-[#10151f] rounded-xl border border-[#1f283a] p-3 text-xs shadow-sm" defaultOpen={true}>
          <ReasoningTrigger className="text-xs text-slate-300 font-medium hover:text-white transition-colors" />
          <ReasoningContent
            className={`mt-2.5 pt-2.5 border-t border-[#18202d] text-slate-400 text-[11px] leading-relaxed pl-6 border-l-2 border-slate-700 ml-1 font-mono${isRtlText(line.content) ? ' text-right' : ''}`}
            dir={isRtlText(line.content) ? 'rtl' : undefined}
          >
            {line.content}
          </ReasoningContent>
        </Reasoning>
      )
    default: {
      const trimmed = line.content.trimStart()

      // User prompt card with copy, edit, delete
      if (trimmed.startsWith('>')) {
        const promptText = line.content.replace(/^>\s*/, '')
        const isRtl = isRtlText(promptText)
        return (
          <div className="flex flex-col items-end w-full my-3 group">
            <div className="bg-secondary bg-[#1e2638] text-white px-4 py-2.5 rounded-2xl rounded-tr-none max-w-sm text-right text-sm shadow-md font-sans select-text inline-block">
              <bdi
                dir={getTextDirection(promptText)}
                className={cn('block select-text whitespace-pre-wrap', isRtl && 'text-right')}
                style={{ unicodeBidi: 'isolate' }}
              >
                {promptText}
              </bdi>
              <div className="flex items-center justify-start gap-2 mt-1.5 pt-1 text-[10px] text-slate-400 border-t border-slate-700/50">
                <CopyButton text={promptText} />
                {!isRunning && onEditPrompt && (
                  <EditMessageDialog
                    message={promptText}
                    onSave={(newText) => onEditPrompt(line.timestamp, newText)}
                    triggerElement={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        role="button"
                        tabIndex={0}
                        title="Edit prompt"
                        className="hover:text-white"
                      >
                        <IconPencil size={13} />
                      </Button>
                    }
                  />
                )}
                {!isRunning && onDeleteTurn && (
                  <DeleteMessageDialog
                    onDelete={() => onDeleteTurn(line.timestamp)}
                  />
                )}
              </div>
            </div>
          </div>
        )
      }

      // Metadata / status lines
      if (
        trimmed.startsWith('Backend:') ||
        trimmed.startsWith('Model:') ||
        trimmed.startsWith('LSP Tools:') ||
        trimmed.startsWith('Ollama agent started') ||
        trimmed.startsWith('Agent iteration') ||
        trimmed.startsWith('Diff proposed for') ||
        trimmed.startsWith('Permission')
      ) {
        const isModel = trimmed.startsWith('Model:')
        const isLsp = trimmed.startsWith('LSP Tools:')
        return (
          <div className="flex items-center gap-1.5 text-[11px] font-mono my-0.5 select-text">
            <span
              className={cn(
                'px-2.5 py-1 rounded-lg bg-[#0e1219] border border-[#1b2230] inline-flex items-center gap-2',
                isModel ? 'text-sky-400' : isLsp ? 'text-emerald-400 font-semibold' : 'text-slate-300'
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              {line.content}
            </span>
          </div>
        )
      }

      if (trimmed.startsWith('Starting agent')) {
        return (
          <div className="flex items-center gap-2 font-mono text-xs text-slate-300 py-1 select-none pl-1">
            <IconLoader2 size={13} className="animate-spin text-sky-400 shrink-0" />
            <span>{line.content}</span>
          </div>
        )
      }

      // Assistant Markdown response with BiDi isolation
      return (
        <div
          className={cn(
            'w-full my-2 text-slate-100 text-sm leading-relaxed select-text',
            isRtlText(line.content) && 'text-right pr-2'
          )}
          dir={isRtlText(line.content) ? 'rtl' : 'ltr'}
        >
          <bdi dir="auto" style={{ unicodeBidi: 'isolate', display: 'block' }}>
            <RenderMarkdown content={line.content} isStreaming={isStreaming} />
          </bdi>
        </div>
      )
    }
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
