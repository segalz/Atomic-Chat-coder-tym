import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppMode = 'chat' | 'plan' | 'coding'

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
    | 'plan_stage'
  content: string
  toolName?: string
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
  attachedImagePath: string | null
  lastVisionResult: {
    bestFile: string
    extractedWords: string[]
    screenDescription: string
  } | null

  // ── Runtime (not persisted via zustand) ──────────
  isAgentRunning: boolean
  agentOutput: AgentOutputLine[]

  // ── Actions ──────────────────────────────────────
  setMode: (mode: AppMode) => void
  setProjectDir: (dir: string) => void
  setDraftPrompt: (text: string) => void
  setAttachedImagePath: (path: string | null) => void
  setVisionResult: (r: CodeModeState['lastVisionResult']) => void
  setAgentRunning: (running: boolean) => void
  appendOutput: (line: AgentOutputLine) => void
  clearOutput: () => void
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
      attachedImagePath: null,
      lastVisionResult: null,

      // Runtime
      isAgentRunning: false,
      agentOutput: loadPersistedOutput(),

      // Actions
      setMode: (mode) => set({ mode }),
      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setAttachedImagePath: (path) => set({ attachedImagePath: path }),
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
        attachedImagePath: state.attachedImagePath,
        lastVisionResult: state.lastVisionResult,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && (state.mode as string) === 'code') {
          state.setMode('plan')
        }
      },
    }
  )
)
