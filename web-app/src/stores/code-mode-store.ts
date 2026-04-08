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

  // ── Runtime (not persisted) ──────────────────────
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
}

export const useCodeModeStore = create<CodeModeState>()(
  persist(
    (set) => ({
      // Persisted
      mode: 'chat',
      projectDir: '',
      draftPrompt: '',
      permissionMode: 'ask',
      codeModel: 'qwen3-coder:30b',
      lastVisionResult: null,

      // Runtime
      isAgentRunning: false,
      agentOutput: [],
      availableCodeModels: [],

      // Actions
      setMode: (mode) => set({ mode }),
      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      setCodeModel: (model) => set({ codeModel: model }),
      setVisionResult: (r) => set({ lastVisionResult: r }),
      setAgentRunning: (running) => set({ isAgentRunning: running }),
      appendOutput: (line) =>
        set((state) => ({ agentOutput: [...state.agentOutput, line] })),
      clearOutput: () => set({ agentOutput: [] }),
      setAvailableCodeModels: (models) => set({ availableCodeModels: models }),
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
