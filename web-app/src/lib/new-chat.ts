import { invoke } from '@tauri-apps/api/core'
import {
  SESSION_STORAGE_KEY,
  TEMPORARY_CHAT_ID,
} from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { NEW_THREAD_ATTACHMENT_KEY, useChatAttachments } from '@/hooks/useChatAttachments'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useCodeModeStore } from '@/stores/code-mode-store'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import { useChatSessions } from '@/stores/chat-session-store'

export function createNewChatId() {
  return globalThis.crypto?.randomUUID?.() ?? Date.now().toString()
}

export function resetNewChatState() {
  // Agent shutdown can be slow or fail when no agent is running; never block the UI reset.
  void invoke('stop_code_agent').catch(() => undefined)
  void invoke('stop_ollama_agent').catch(() => undefined)

  localStorage.setItem(localStorageKey.setupCompleted, 'true')
  sessionStorage.removeItem(SESSION_STORAGE_KEY.INITIAL_MESSAGE_TEMPORARY)
  sessionStorage.removeItem('temp-chat-nav')

  const threads = useThreads.getState()
  threads.setCurrentThreadId(undefined)
  if (threads.getThreadById(TEMPORARY_CHAT_ID)) {
    threads.deleteThread(TEMPORARY_CHAT_ID)
  }

  usePrompt.getState().resetPrompt()
  useChatAttachments.getState().clearAttachments(NEW_THREAD_ATTACHMENT_KEY)
  useChatAttachments.getState().clearAttachments(TEMPORARY_CHAT_ID)
  useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
  useChatSessions.getState().removeSession(TEMPORARY_CHAT_ID)
  useChatSessions.getState().setActiveConversationId(undefined)

  const { setMode, setAgentRunning, clearOutput } = useCodeModeStore.getState()
  setMode('chat')
  setAgentRunning(false)
  clearOutput()
  useCodingAgentStore.getState().clearSession()
}
