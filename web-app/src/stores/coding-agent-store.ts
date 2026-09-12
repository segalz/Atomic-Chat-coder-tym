import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  CodingAgentBackend,
  isCodingAgentBackend,
  resolveCodingAgentBackend,
} from '@/containers/CodingAgentPanel/backend-identity'

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

export type SessionStatus = 'completed' | 'interrupted' | 'failed' | 'running'

export type SessionIdentityPatch = Partial<
  Pick<CodingSession, 'backend' | 'providerId' | 'modelId' | 'externalSessionId' | 'status' | 'interruptedReason'>
>

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
  backend?: CodingAgentBackend
  providerId?: string
  modelId?: string
  externalSessionId?: string
  status?: SessionStatus
  interruptedReason?: string
}

interface CodingAgentState {
  // Persisted
  projectDir: string
  draftPrompt: string
  sessions: CodingSession[]
  activeSessionId: string | null
  autoApproveTools: boolean

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
  setAutoApproveTools: (enabled: boolean) => void
  appendPlanText: (text: string) => void
  appendLog: (line: ExecLogLine) => void
  addDiff: (diff: PendingDiff) => void
  updateDiffStatus: (id: string, status: PendingDiff['status']) => void
  clearPendingDiffs: () => void
  setDiagnostics: (filePath: string, diagnostics: any[]) => void
  setConversationSummary: (summary: string) => void
  /** Save current session to history then clear runtime state */
  startNewSession: (
    prompt: string,
    threadId?: string,
    source?: CodingSessionSource,
    meta?: Partial<
      Pick<CodingSession, 'backend' | 'providerId' | 'modelId' | 'externalSessionId' | 'status'>
    >
  ) => void
  /** Continue the active session without clearing visible output */
  continueSession: (prompt: string, source?: CodingSessionSource) => void
  /** Persist the current running session into history (call when agent finishes) */
  saveCurrentSession: () => void
  /** Update identity metadata (backend, provider, model, ACP session id) for a session */
  setSessionIdentity: (
    sessionId: string,
    identity: Partial<
      Pick<CodingSession, 'backend' | 'providerId' | 'modelId' | 'externalSessionId' | 'status' | 'interruptedReason'>
    >
  ) => void
  /** Mark a session (or the active one) as interrupted with an optional reason */
  markSessionInterrupted: (sessionId?: string, reason?: string) => void
  /** Update the lifecycle status of a session, with an optional reason */
  setSessionStatus: (sessionId: string, status: SessionStatus, reason?: string) => void
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

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === 'completed' || value === 'interrupted' || value === 'failed' || value === 'running'
}

function normalizeIdentityPatch(value: unknown): SessionIdentityPatch {
  if (!value || typeof value !== 'object') return {}

  const identity = value as Partial<CodingSession>
  const patch: SessionIdentityPatch = {}

  if (identity.backend !== undefined) {
    patch.backend = resolveCodingAgentBackend(identity.backend)
  }
  if (typeof identity.providerId === 'string' && identity.providerId.length > 0) {
    patch.providerId = identity.providerId
  }
  if (typeof identity.modelId === 'string' && identity.modelId.length > 0) {
    patch.modelId = identity.modelId
  }
  if (typeof identity.externalSessionId === 'string' && identity.externalSessionId.length > 0) {
    patch.externalSessionId = identity.externalSessionId
  }
  if (isSessionStatus(identity.status)) {
    patch.status = identity.status
  }
  if (typeof identity.interruptedReason === 'string' && identity.interruptedReason.length > 0) {
    patch.interruptedReason = identity.interruptedReason
  }

  return patch
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

      if (isCodingAgentBackend(s.backend)) {
        normalized.backend = s.backend
      }

      if (typeof s.providerId === 'string' && s.providerId.length > 0) {
        normalized.providerId = s.providerId
      }

      if (typeof s.modelId === 'string' && s.modelId.length > 0) {
        normalized.modelId = s.modelId
      }

      if (typeof s.externalSessionId === 'string' && s.externalSessionId.length > 0) {
        normalized.externalSessionId = s.externalSessionId
      }

      if (isSessionStatus(s.status)) {
        normalized.status = s.status
      }

      if (typeof s.interruptedReason === 'string' && s.interruptedReason.length > 0) {
        normalized.interruptedReason = s.interruptedReason
      }

      return normalized
    })
}

export function migrateCodingAgentState(persistedState: unknown, _version?: number): Partial<CodingAgentState> {
  if (!persistedState || typeof persistedState !== 'object') return {}

  const state = persistedState as Partial<CodingAgentState>
  const sessions = normalizeSessions(state.sessions)
  const activeSessionId = typeof state.activeSessionId === 'string' ? state.activeSessionId : null
  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId && session.source === 'manual')
    : undefined

  const wasRunning = Boolean(state.isRunning)
  // Sessions persisted with status 'running', or active session if the app crashed while isRunning was true (e.g. v0 / unversioned)
  const migratedSessions = sessions.map((session) => {
    const isInterruptedRun =
      session.status === 'running' ||
      (wasRunning && session.id === activeSessionId && session.status !== 'completed' && session.status !== 'failed')

    if (isInterruptedRun) {
      return {
        ...session,
        status: 'interrupted' as SessionStatus,
        interruptedReason: session.interruptedReason || 'Application restarted while run was active',
      }
    }
    return session
  })

  return {
    projectDir: typeof state.projectDir === 'string' ? state.projectDir : '',
    draftPrompt: typeof state.draftPrompt === 'string' ? state.draftPrompt : '',
    sessions: migratedSessions,
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
      autoApproveTools: false,
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
      setAutoApproveTools: (enabled) => set({ autoApproveTools: enabled }),
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

      startNewSession: (prompt, threadId, source = 'manual', meta) => {
        const { planText, execLog, pendingDiffs, projectDir, sessions, activeSessionId } = get()
        const newId = crypto.randomUUID()
        const identity = meta ? normalizeIdentityPatch(meta) : {}

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
          ...identity,
          status: identity.status ?? 'running',
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

      setSessionIdentity: (sessionId, identity) =>
        set((s) => {
          const patch = normalizeIdentityPatch(identity)
          return {
            sessions: s.sessions.map((sess) => (sess.id === sessionId ? { ...sess, ...patch } : sess)),
          }
        }),

      markSessionInterrupted: (sessionId, reason = 'User stopped run') =>
        set((s) => {
          const targetId = sessionId ?? s.activeSessionId
          if (!targetId) return {}
          return {
            sessions: s.sessions.map((sess) =>
              sess.id === targetId
                ? { ...sess, status: 'interrupted' as SessionStatus, interruptedReason: reason }
                : sess
            ),
          }
        }),

      setSessionStatus: (sessionId, status, reason) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  status,
                  interruptedReason:
                    reason !== undefined
                      ? reason
                      : status === 'completed' || status === 'running'
                      ? undefined
                      : sess.interruptedReason,
                }
              : sess
          ),
        })),

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
      version: 1,
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
        autoApproveTools: s.autoApproveTools,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const wasRunning = state.isRunning
          state.isRunning = false
          state.pendingDiffs = []
          state.sessions = state.sessions.map((session) => {
            const normalizedDiffs = normalizePendingDiffs(session.pendingDiffs).filter((diff) => diff.status !== 'pending')
            const isInterruptedRun =
              session.status === 'running' ||
              (wasRunning && session.id === state.activeSessionId && session.status !== 'completed' && session.status !== 'failed')

            if (isInterruptedRun) {
              return {
                ...session,
                pendingDiffs: normalizedDiffs,
                status: 'interrupted',
                interruptedReason: session.interruptedReason || 'Application restarted while run was active',
              }
            }
            return {
              ...session,
              pendingDiffs: normalizedDiffs,
            }
          })
        }
      },
    }
  )
)
