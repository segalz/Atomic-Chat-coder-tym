import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { PromptTemplate } from '@/types/pm/prompt-template'
import { loadTemplates, saveTemplates } from '@/services/pm/prompt-library'

interface PromptLibraryState {
  templates: PromptTemplate[]
  isLoading: boolean
  error: string | null
  load: () => Promise<void>
  add: (template: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>
  update: (template: PromptTemplate) => Promise<void>
  delete: (id: string) => Promise<void>
}

export const usePromptLibraryStore = create<PromptLibraryState>((set, get) => ({
  templates: [],
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null })
    try {
      const templates = await loadTemplates()
      set({ templates, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  add: async (templateData) => {
    const id = uuidv4()
    const newTemplate: PromptTemplate = {
      ...templateData,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const templates = [...get().templates, newTemplate]
    set({ templates })
    await saveTemplates(templates)
    return id
  },

  update: async (updatedTemplate) => {
    updatedTemplate.updatedAt = new Date().toISOString()
    const templates = get().templates.map(t => t.id === updatedTemplate.id ? updatedTemplate : t)
    set({ templates })
    await saveTemplates(templates)
  },

  delete: async (id) => {
    const templates = get().templates.filter(t => t.id !== id)
    set({ templates })
    await saveTemplates(templates)
  }
}))
