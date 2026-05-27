import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ExecLogLineType =
  | 'text_delta'
  | 'thinking'
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

export type CodingSessionSource = 'manual' | 'loop'

export interface CodingSession {
  id: string
  threadId?: string
  prompt: string
  source: CodingSessionSource
  projectDir: string
  planText: string
  execLog: ExecLogLine[]
  pendingDiffs: PendingDiff[]
  conversationSummary?: string
  conversationSummaryUpdatedAt?: number
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
  diagnostics: Record<string, any[]>
  conversationSummary?: string
  conversationSummaryUpdatedAt?: number
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
  clearPendingDiffs: () => void
  setDiagnostics: (filePath: string, diagnostics: any[]) => void
  setConversationSummary: (summary: string) => void
  /** Save current session to history then clear runtime state */
  startNewSession: (prompt: string, threadId?: string, source?: CodingSessionSource) => void
  /** Continue the active session without clearing visible output */
  continueSession: (prompt: string, source?: CodingSessionSource) => void
  /** Persist the current running session into history (call when agent finishes) */
  saveCurrentSession: () => void
  /** Load a past session into the view (read-only) */
  loadSession: (id: string) => void
  /** Delete a session from history */
  deleteSession: (id: string) => void
  clearSession: () => void
}

function normalizeExecLog(value: unknown): ExecLogLine[] {
  return Array.isArray(value) ? value.filter((line) => line && typeof line === 'object') as ExecLogLine[] : []
}

function normalizePendingDiffs(value: unknown): PendingDiff[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((diff) => diff && typeof diff === 'object')
    .map((diff) => {
      const d = diff as Partial<PendingDiff>
      return {
        id: typeof d.id === 'string' ? d.id : crypto.randomUUID(),
        filePath: typeof d.filePath === 'string' ? d.filePath : '',
        search: typeof d.search === 'string' ? d.search : '',
        replace: typeof d.replace === 'string' ? d.replace : '',
        status: d.status === 'approved' || d.status === 'rejected' ? d.status : 'rejected',
      }
    })
}

function normalizeDiagnostics(value: unknown): Record<string, any[]> {
  if (!value || typeof value !== 'object') return {}

  return value as Record<string, any[]>
}

function normalizeSessions(value: unknown): CodingSession[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((session) => session && typeof session === 'object')
    .map((session) => {
      const s = session as Partial<CodingSession>
      const normalized: CodingSession = {
        id: typeof s.id === 'string' ? s.id : crypto.randomUUID(),
        threadId: typeof s.threadId === 'string' ? s.threadId : undefined,
        prompt: typeof s.prompt === 'string' ? s.prompt : 'Session',
        source: s.source === 'loop' ? 'loop' : 'manual',
        projectDir: typeof s.projectDir === 'string' ? s.projectDir : '',
        planText: typeof s.planText === 'string' ? s.planText : '',
        execLog: normalizeExecLog(s.execLog),
        pendingDiffs: normalizePendingDiffs(s.pendingDiffs),
        timestamp: typeof s.timestamp === 'number' ? s.timestamp : Date.now(),
      }

      if (typeof s.conversationSummary === 'string') {
        normalized.conversationSummary = s.conversationSummary
      }

      if (typeof s.conversationSummaryUpdatedAt === 'number') {
        normalized.conversationSummaryUpdatedAt = s.conversationSummaryUpdatedAt
      }

      return normalized
    })
}

function migrateCodingAgentState(persistedState: unknown): Partial<CodingAgentState> {
  if (!persistedState || typeof persistedState !== 'object') return {}

  const state = persistedState as Partial<CodingAgentState>
  const sessions = normalizeSessions(state.sessions)
  const activeSessionId = typeof state.activeSessionId === 'string' ? state.activeSessionId : null
  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId && session.source === 'manual')
    : undefined

  return {
    projectDir: typeof state.projectDir === 'string' ? state.projectDir : '',
    draftPrompt: typeof state.draftPrompt === 'string' ? state.draftPrompt : '',
    sessions,
    activeSessionId,
    planText: typeof state.planText === 'string' ? state.planText : '',
    execLog: normalizeExecLog(state.execLog),
    pendingDiffs: normalizePendingDiffs(state.pendingDiffs),
    diagnostics: normalizeDiagnostics(state.diagnostics),
    conversationSummary: activeSession?.conversationSummary,
    conversationSummaryUpdatedAt: activeSession?.conversationSummaryUpdatedAt,
    isRunning: false,
  }
}

function updateActiveSession(
  state: Pick<CodingAgentState, 'activeSessionId' | 'sessions'>,
  patch: Partial<Pick<CodingSession, 'planText' | 'execLog' | 'pendingDiffs' | 'conversationSummary' | 'conversationSummaryUpdatedAt'>>
): CodingSession[] {
  if (!state.activeSessionId) return state.sessions

  const index = state.sessions.findIndex((session) => session.id === state.activeSessionId)
  if (index === -1) return state.sessions

  const sessions = [...state.sessions]
  sessions[index] = { ...sessions[index], ...patch }
  return sessions
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
      diagnostics: {},
      conversationSummary: undefined,
      conversationSummaryUpdatedAt: undefined,
      showFree: false,

      setProjectDir: (dir) => set({ projectDir: dir }),
      setDraftPrompt: (text) => set({ draftPrompt: text }),
      setRunning: (v) => set(v ? { isRunning: true, showFree: false } : { isRunning: false }),
      setShowFree: (v) => set({ showFree: v }),
      appendPlanText: (text) =>
        set((s) => {
          const planText = s.planText + text
          return {
            planText,
            sessions: updateActiveSession(s, { planText }),
          }
        }),
      appendLog: (line) =>
        set((s) => {
          const execLog = [...s.execLog, line]
          return {
            execLog,
            sessions: updateActiveSession(s, { execLog }),
          }
        }),
      addDiff: (diff) =>
        set((s) => {
          const pendingDiffs = [...s.pendingDiffs, diff]
          return {
            pendingDiffs,
            sessions: updateActiveSession(s, { pendingDiffs }),
          }
        }),
      updateDiffStatus: (id, status) =>
        set((s) => {
          const pendingDiffs = s.pendingDiffs.map((d) => (d.id === id ? { ...d, status } : d))
          return {
            pendingDiffs,
            sessions: updateActiveSession(s, { pendingDiffs }),
          }
        }),
      clearPendingDiffs: () =>
        set((s) => ({
          pendingDiffs: [],
          sessions: updateActiveSession(s, { pendingDiffs: [] }),
        })),
      setDiagnostics: (filePath, diagnostics) =>
        set((s) => ({
          diagnostics: { ...s.diagnostics, [filePath]: diagnostics },
        })),
      setConversationSummary: (summary) => {
        const trimmedSummary = summary.trim()
        const conversationSummaryUpdatedAt = Date.now()
        set((s) => {
          const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
          if (!activeSession || activeSession.source !== 'manual') return {}

          return {
            conversationSummary: trimmedSummary,
            conversationSummaryUpdatedAt,
            sessions: updateActiveSession(s, {
              conversationSummary: trimmedSummary,
              conversationSummaryUpdatedAt,
            }),
          }
        })
      },

      startNewSession: (prompt, threadId, source = 'manual') => {
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
              source: 'manual',
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
          source,
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
          conversationSummary: undefined,
          conversationSummaryUpdatedAt: undefined,
          isRunning: false,
        })
      },

      continueSession: (prompt, source = 'manual') => {
        set((s) => {
          if (!s.activeSessionId) return {}

          const idx = s.sessions.findIndex((session) => session.id === s.activeSessionId)
          if (idx === -1) return {}

          const sessions = [...s.sessions]
          sessions[idx] = {
            ...sessions[idx],
            prompt: sessions[idx].prompt || prompt,
            source,
            timestamp: Date.now(),
          }

          return { sessions, showFree: false }
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
              source: 'manual',
              projectDir,
              planText,
              execLog,
              pendingDiffs,
              timestamp: Date.now(),
            }, ...s.sessions]
          }
          return { sessions, showFree: true }
        })
      },

      loadSession: (id) => {
        const session = get().sessions.find((s) => s.id === id)
        if (!session) return
        set({
          activeSessionId: id,
          planText: session.planText,
          execLog: session.execLog,
          pendingDiffs: normalizePendingDiffs(session.pendingDiffs).filter((diff) => diff.status === 'pending'),
          conversationSummary: session.conversationSummary,
          conversationSummaryUpdatedAt: session.conversationSummaryUpdatedAt,
          projectDir: session.projectDir,
          isRunning: false,
        })
      },

      deleteSession: (id) => {
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }))
      },

      clearSession: () =>
        set({
          planText: '',
          execLog: [],
          pendingDiffs: [],
          conversationSummary: undefined,
          conversationSummaryUpdatedAt: undefined,
          isRunning: false,
          activeSessionId: null,
        }),
    }),
    {
      name: 'coding-agent-store',
      version: 0,
      storage: createJSONStorage(() => ({
        getItem: (name) => (typeof window !== 'undefined' ? localStorage.getItem(name) : null),
        setItem: (name, value) => {
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem(name, value)
            } catch (e) {
              console.warn('coding-agent-store: Failed to persist state to localStorage (quota exceeded)', e)
            }
          }
        },
        removeItem: (name) => {
          if (typeof window !== 'undefined') {
            localStorage.removeItem(name)
          }
        },
      })),
      migrate: migrateCodingAgentState,
      partialize: (s) => ({
        projectDir: s.projectDir,
        draftPrompt: s.draftPrompt,
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
        planText: s.planText,
        execLog: s.execLog,
        pendingDiffs: s.pendingDiffs,
        diagnostics: s.diagnostics,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isRunning = false
          state.pendingDiffs = []
          state.sessions = state.sessions.map((session) => ({
            ...session,
            pendingDiffs: normalizePendingDiffs(session.pendingDiffs).filter((diff) => diff.status !== 'pending'),
          }))
        }
      },
    }
  )
)
