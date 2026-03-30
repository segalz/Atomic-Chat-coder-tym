import { create } from 'zustand'
import type { DependencyNode, ProjectDna } from '@/types/pm/dependency-tree'
import { analyzeProject } from '@/services/pm/project-analyzer'
import { analyzeProjectDna, buildAiContext } from '@/services/pm/project-dna'
import { bundleContext, renderTree } from '@/services/pm/context-bundler'

interface ProjectModeState {
  projectRoot: string
  entryFile: string
  dependencyTree: DependencyNode | null
  treeDisplay: string
  projectDna: ProjectDna | null
  bundledContext: string
  aiContext: string
  isAnalyzing: boolean
  error: string | null
  localCount: number
  externalCount: number

  setProjectRoot: (path: string) => void
  setEntryFile: (path: string) => void
  analyzeProject: () => Promise<void>
  clearProject: () => void
}

export const useProjectModeStore = create<ProjectModeState>((set, get) => ({
  projectRoot: '',
  entryFile: '',
  dependencyTree: null,
  treeDisplay: '',
  projectDna: null,
  bundledContext: '',
  aiContext: '',
  isAnalyzing: false,
  error: null,
  localCount: 0,
  externalCount: 0,

  setProjectRoot: (path) => set({ projectRoot: path, dependencyTree: null, error: null }),
  setEntryFile: (path) => set({ entryFile: path, dependencyTree: null, error: null }),

  analyzeProject: async () => {
    const { projectRoot, entryFile } = get()
    if (!projectRoot || !entryFile) return

    set({ isAnalyzing: true, error: null })

    try {
      // Run dependency analysis and DNA detection in parallel
      const [tree, dna] = await Promise.all([
        analyzeProject(projectRoot, entryFile),
        analyzeProjectDna(projectRoot),
      ])

      const treeDisplay = renderTree(tree)
      const bundled = await bundleContext(tree, projectRoot)
      const aiCtx = buildAiContext(dna)

      set({
        dependencyTree: tree,
        treeDisplay,
        projectDna: dna,
        bundledContext: bundled,
        aiContext: aiCtx,
        isAnalyzing: false,
      })
    } catch (err) {
      set({
        isAnalyzing: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  clearProject: () =>
    set({
      projectRoot: '',
      entryFile: '',
      dependencyTree: null,
      treeDisplay: '',
      projectDna: null,
      bundledContext: '',
      aiContext: '',
      isAnalyzing: false,
      error: null,
      localCount: 0,
      externalCount: 0,
    }),
}))
