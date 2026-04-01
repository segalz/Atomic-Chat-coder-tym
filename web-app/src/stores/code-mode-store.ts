import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppMode = 'chat' | 'code'

export interface AgentOutputLine {
  type:
    | 'system'
    | 'thinking'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'permission_request'
    | 'result'
    | 'error'
    | 'done'
  content: string
  toolName?: string
  timestamp: number
}

interface CodeModeState {
  // ── Persisted (session restore) ──────────────────
  mode: AppMode
  projectDir: string
  draftPrompt: string
  permissionMode: 'ask' | 'auto_accept'
  lastVisionResult: {
    bestFile: string
    extractedWords: string[]
    screenDescription: string
  } | null

  // ── Runtime (not persisted) ──────────────────────
  isAgentRunning: boolean
  agentOutput: AgentOutputLine[]

  // ── Actions ──────────────────────────────────────
  setMode: (mode: AppMode) => void
  setProjectDir: (dir: string) => void
  setDraftPrompt: (text: string) => void
  setPermissionMode: (mode: 'ask' | 'auto_accept') => void
  setVisionResult: (r: CodeModeState['lastVisionResult']) => void
  setAgentRunning: (running: boolean) => void
  appendOutput: (line: AgentOutputLine) => void
  clearOutput: () => void
}

export const useCodeModeStore = create<CodeModeState>()(
  persist(
    (set) => ({
      // Persisted
      mode: 'chat',
      projectDir: '',
      draftPrompt: '',
      permissionMode: 'ask',
      lastVisionResult: null,

      // Runtime
      isAgentRunning: false,
      agentOutput: [],

      // Actions
      setMode: (mode) => set({ mode }),
      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      setVisionResult: (r) => set({ lastVisionResult: r }),
      setAgentRunning: (running) => set({ isAgentRunning: running }),
      appendOutput: (line) =>
        set((state) => ({ agentOutput: [...state.agentOutput, line] })),
      clearOutput: () => set({ agentOutput: [] }),
    }),
    {
      name: 'code-mode-store',
      partialize: (state) => ({
        mode: state.mode,
        projectDir: state.projectDir,
        draftPrompt: state.draftPrompt,
        permissionMode: state.permissionMode,
        lastVisionResult: state.lastVisionResult,
      }),
    }
  )
)
