import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ExecLogLineType =
  | 'text_delta'
  | 'tool_start'
  | 'tool_result'
  | 'error'
  | 'done'

export interface ExecLogLine {
  type: ExecLogLineType
  content: string
  toolName?: string
  timestamp: number
}

export interface PendingDiff {
  id: string
  filePath: string
  search: string
  replace: string
  status: 'pending' | 'approved' | 'rejected'
}

export interface CodingSession {
  id: string
  threadId?: string
  prompt: string
  projectDir: string
  planText: string
  execLog: ExecLogLine[]
  pendingDiffs: PendingDiff[]
  timestamp: number
}

interface CodingAgentState {
  // Persisted
  projectDir: string
  draftPrompt: string
  sessions: CodingSession[]
  activeSessionId: string | null

  // Runtime
  isRunning: boolean
  planText: string
  execLog: ExecLogLine[]
  pendingDiffs: PendingDiff[]
  showFree: boolean

  // Actions
  setProjectDir: (dir: string) => void
  setDraftPrompt: (text: string) => void
  setRunning: (v: boolean) => void
  setShowFree: (v: boolean) => void
  appendPlanText: (text: string) => void
  appendLog: (line: ExecLogLine) => void
  addDiff: (diff: PendingDiff) => void
  updateDiffStatus: (id: string, status: PendingDiff['status']) => void
  /** Save current session to history then clear runtime state */
  startNewSession: (prompt: string, threadId?: string) => void
  /** Persist the current running session into history (call when agent finishes) */
  saveCurrentSession: () => void
  /** Load a past session into the view (read-only) */
  loadSession: (id: string) => void
  /** Delete a session from history */
  deleteSession: (id: string) => void
  clearSession: () => void
}

export const useCodingAgentStore = create<CodingAgentState>()(
  persist(
    (set, get) => ({
      projectDir: '',
      draftPrompt: '',
      sessions: [],
      activeSessionId: null,
      isRunning: false,
      planText: '',
      execLog: [],
      pendingDiffs: [],
      showFree: false,

      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setRunning: (v) => set(v ? { isRunning: true, showFree: false } : { isRunning: false }),
      setShowFree: (v) => set({ showFree: v }),
      appendPlanText: (text) => set((s) => ({ planText: s.planText + text })),
      appendLog: (line) => set((s) => ({ execLog: [...s.execLog, line] })),
      addDiff: (diff) => set((s) => ({ pendingDiffs: [...s.pendingDiffs, diff] })),
      updateDiffStatus: (id, status) =>
        set((s) => ({
          pendingDiffs: s.pendingDiffs.map((d) => (d.id === id ? { ...d, status } : d)),
        })),

      startNewSession: (prompt, threadId) => {
        const { planText, execLog, pendingDiffs, projectDir, sessions, activeSessionId } = get()
        const newId = crypto.randomUUID()

        // Save current session if it has any content
        const updatedSessions = [...sessions]
        if (execLog.length > 0 || planText) {
          const idx = updatedSessions.findIndex((s) => s.id === activeSessionId)
          if (idx !== -1) {
            updatedSessions[idx] = { ...updatedSessions[idx], planText, execLog, pendingDiffs }
          } else {
            // New session for the previous run
            const prevPrompt = execLog.find((l) => l.type === 'text_delta')?.content?.replace(/^> /, '') ?? 'Session'
            updatedSessions.unshift({
              id: crypto.randomUUID(),
              prompt: prevPrompt,
              threadId: undefined,
              projectDir,
              planText,
              execLog,
              pendingDiffs,
              timestamp: Date.now(),
            })
          }
        }

        // Add the new session immediately to history so it appears in the list right away
        updatedSessions.unshift({
          id: newId,
          threadId,
          prompt,
          projectDir,
          planText: '',
          execLog: [],
          pendingDiffs: [],
          timestamp: Date.now(),
        })

        set({
          sessions: updatedSessions,
          activeSessionId: newId,
          planText: '',
          execLog: [],
          pendingDiffs: [],
          isRunning: false,
        })
      },

      saveCurrentSession: () => {
        const { planText, execLog, pendingDiffs, projectDir, activeSessionId } = get()
        if (!execLog.length && !planText) return
        set((s) => {
          const idx = s.sessions.findIndex((sess) => sess.id === activeSessionId)
          let sessions: CodingSession[]
          if (idx !== -1) {
            sessions = [...s.sessions]
            // Merge: append new lines to whatever was already saved — prevents double-save from overwriting
            const existing = sessions[idx].execLog
            const merged = existing.length
              ? [...existing, ...execLog.filter((l) => !existing.some((e) => e.timestamp === l.timestamp && e.content === l.content))]
              : execLog
            sessions[idx] = { ...sessions[idx], planText: planText || sessions[idx].planText, execLog: merged, pendingDiffs }
          } else {
            const prompt = execLog.find((l) => l.type === 'text_delta')?.content?.replace(/^> /, '') ?? 'Session'
            sessions = [{
              id: activeSessionId ?? crypto.randomUUID(),
              threadId: undefined,
              prompt,
              projectDir,
              planText,
              execLog,
              pendingDiffs,
              timestamp: Date.now(),
            }, ...s.sessions]
          }
          return { sessions, execLog: [], planText: '', pendingDiffs: [], showFree: true }
        })
      },

      loadSession: (id) => {
        const session = get().sessions.find((s) => s.id === id)
        if (!session) return
        set({
          activeSessionId: id,
          planText: session.planText,
          execLog: session.execLog,
          pendingDiffs: session.pendingDiffs,
          projectDir: session.projectDir,
          isRunning: false,
        })
      },

      deleteSession: (id) => {
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }))
      },

      clearSession: () =>
        set({ planText: '', execLog: [], pendingDiffs: [], isRunning: false, activeSessionId: null }),
    }),
    {
      name: 'coding-agent-store',
      partialize: (s) => ({
        projectDir: s.projectDir,
        draftPrompt: s.draftPrompt,
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
        planText: s.planText,
        execLog: s.execLog,
        pendingDiffs: s.pendingDiffs,
      }),
    }
  )
)
