import { create } from 'zustand'
import { composePlan, formatPlanForExport, DEFAULT_SYSTEM_PROMPT } from '@/services/pm/plan-composer'
import { useProjectModeStore } from './project-mode-store'

interface PlanState {
  userQuery: string
  systemPrompt: string
  planResult: string
  composedUserMessage: string
  isGenerating: boolean
  error: string | null

  setUserQuery: (query: string) => void
  setSystemPrompt: (prompt: string) => void
  composeAndPreview: () => void
  setPlanResult: (result: string) => void
  setIsGenerating: (generating: boolean) => void
  setError: (error: string | null) => void
  exportToMarkdown: () => Promise<string>
  clear: () => void
}

export const usePlanStore = create<PlanState>((set, get) => ({
  userQuery: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  planResult: '',
  composedUserMessage: '',
  isGenerating: false,
  error: null,

  setUserQuery: (query) => set({ userQuery: query }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

  composeAndPreview: () => {
    const { userQuery, systemPrompt } = get()
    const pmStore = useProjectModeStore.getState()

    const { userMessage } = composePlan({
      userQuery,
      projectDna: pmStore.projectDna,
      dependencyTree: pmStore.dependencyTree,
      treeDisplay: pmStore.treeDisplay,
      systemPrompt,
    })

    set({ composedUserMessage: userMessage })
  },

  setPlanResult: (result) => set({ planResult: result, isGenerating: false }),
  setIsGenerating: (generating) => set({ isGenerating: generating }),
  setError: (error) => set({ error, isGenerating: false }),

  exportToMarkdown: async () => {
    const { userQuery, planResult } = get()
    const pmStore = useProjectModeStore.getState()
    return formatPlanForExport(userQuery, planResult, pmStore.projectRoot)
  },

  clear: () => set({
    userQuery: '',
    planResult: '',
    composedUserMessage: '',
    isGenerating: false,
    error: null,
  }),
}))
