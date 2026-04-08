import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppMode = 'chat' | 'code'

export interface AgentOutputLine {
  type:
    | 'userPrompt'
    | 'thinking'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'permission_request'
    | 'system'
    | 'error'
    | 'done'
    | 'diff_snapshot'
  content: string
  toolName?: string
  patch?: string
  paths?: string[]
  toolCallId?: string
  isTruncated?: boolean
  note?: string
  timestamp: number
}

const AGENT_OUTPUT_STORAGE_KEY = 'code-mode-agent-output'

function loadPersistedOutput(): AgentOutputLine[] {
  try {
    const raw = localStorage.getItem(AGENT_OUTPUT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveOutputToStorage(output: AgentOutputLine[]) {
  try {
    localStorage.setItem(AGENT_OUTPUT_STORAGE_KEY, JSON.stringify(output))
  } catch {
    // localStorage quota exceeded — skip silently
  }
}

interface CodeModeState {
  // ── Persisted (session restore) ──────────────────
  mode: AppMode
  projectDir: string
  draftPrompt: string
  permissionMode: 'ask' | 'auto_accept'
  codeModel: string
  lastVisionResult: {
    bestFile: string
    extractedWords: string[]
    screenDescription: string
  } | null

  // ── Runtime (not persisted via zustand) ──────────
  isAgentRunning: boolean
  agentOutput: AgentOutputLine[]
  availableCodeModels: string[]

  // ── Actions ──────────────────────────────────────
  setMode: (mode: AppMode) => void
  setProjectDir: (dir: string) => void
  setDraftPrompt: (text: string) => void
  setPermissionMode: (mode: 'ask' | 'auto_accept') => void
  setCodeModel: (model: string) => void
  setVisionResult: (r: CodeModeState['lastVisionResult']) => void
  setAgentRunning: (running: boolean) => void
  appendOutput: (line: AgentOutputLine) => void
  clearOutput: () => void
  setAvailableCodeModels: (models: string[]) => void
  /** Explicitly flush agentOutput to localStorage — call on send + done only */
  persistOutput: () => void
}

export const useCodeModeStore = create<CodeModeState>()(
  persist(
    (set, get) => ({
      // Persisted
      mode: 'chat',
      projectDir: '',
      draftPrompt: '',
      permissionMode: 'ask',
      codeModel: 'qwen3-coder:30b',
      lastVisionResult: null,

      // Runtime
      isAgentRunning: false,
      agentOutput: loadPersistedOutput(),
      availableCodeModels: [],

      // Actions
      setMode: (mode) => set({ mode }),
      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      setCodeModel: (model) => set({ codeModel: model }),
      setVisionResult: (r) => set({ lastVisionResult: r }),
      setAgentRunning: (running) => set({ isAgentRunning: running }),
      appendOutput: (line) => {
        set((state) => ({ agentOutput: [...state.agentOutput, line] }))
        saveOutputToStorage(get().agentOutput)
      },
      clearOutput: () => {
        set({ agentOutput: [] })
        saveOutputToStorage([])
      },
      setAvailableCodeModels: (models) => set({ availableCodeModels: models }),
      persistOutput: () => {
        saveOutputToStorage(get().agentOutput)
      },
    }),
    {
      name: 'code-mode-store',
      partialize: (state) => ({
        mode: state.mode,
        projectDir: state.projectDir,
        draftPrompt: state.draftPrompt,
        permissionMode: state.permissionMode,
        codeModel: state.codeModel,
        lastVisionResult: state.lastVisionResult,
      }),
    }
  )
)
