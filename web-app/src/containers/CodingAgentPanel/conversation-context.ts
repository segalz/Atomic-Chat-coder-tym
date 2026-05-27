import type { CodingSession } from '@/stores/coding-agent-store'

const MAX_CONTEXT_CHARS = 6000
const MAX_PROMPT_CHARS = 400
const MAX_SESSION_SUMMARY_CHARS = 800
const MAX_STORED_SUMMARY_CHARS = 2400

const STATUS_PREFIXES = [
  '>',
  'Backend:',
  'Model:',
  'Starting agent',
  'Ollama agent started',
  'Agent iteration',
  'Diff proposed for',
]

interface BuildCodingAgentPromptOptions {
  prompt: string
  projectDir: string
  sessions: CodingSession[]
  activeSessionId?: string | null
  includeHistory?: boolean
  includeSummaryContext?: boolean
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars).trimEnd()}\n[truncated]`
}

function isStatusLine(content: string): boolean {
  const trimmed = content.trimStart()
  return STATUS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function summarizeLogLine(type: string, content: string): string | null {
  const normalized = normalizeText(content)
  if (!normalized) return null

  if (normalized.startsWith('>')) {
    return `User: ${normalized.replace(/^>\s*/, '')}`
  }

  if (isStatusLine(normalized)) return null
  if (type === 'done') return null
  if (type === 'error') return `Error: ${normalized}`

  return `Assistant: ${normalized}`
}

function summarizeSession(session: CodingSession): string {
  const logText = session.execLog
    .filter((line) => line.type === 'text_delta' || line.type === 'thinking' || line.type === 'done' || line.type === 'error')
    .map((line) => summarizeLogLine(line.type, line.content))
    .filter((content): content is string => Boolean(content))
    .join('\n')

  const normalizedLogText = normalizeText(logText)
  if (normalizedLogText) return truncate(normalizedLogText, MAX_SESSION_SUMMARY_CHARS)

  return truncate(normalizeText(session.planText), MAX_SESSION_SUMMARY_CHARS)
}

function getActiveContextSession(
  sessions: CodingSession[],
  projectDir: string,
  activeSessionId?: string | null
): CodingSession | null {
  if (!activeSessionId) return null

  const session = sessions.find((item) => item.id === activeSessionId)
  if (!session) return null
  if (session.projectDir !== projectDir) return null
  if (session.source === 'loop') return null
  if (!session.prompt.trim() && !session.planText.trim() && session.execLog.length === 0) return null

  return session
}

export function buildCodingAgentPrompt({
  prompt,
  projectDir,
  sessions,
  activeSessionId,
  includeHistory = true,
  includeSummaryContext = includeHistory,
}: BuildCodingAgentPromptOptions): string {
  const currentPrompt = normalizeText(prompt)
  if (!includeHistory && !includeSummaryContext) return currentPrompt

  const activeSession = getActiveContextSession(sessions, projectDir, activeSessionId)
  if (!activeSession) return currentPrompt

  const storedSummary = normalizeText(activeSession.conversationSummary ?? '')
  if (includeSummaryContext && storedSummary) {
    const contextText = truncate([
      'Coding-agent summary context from the active conversation follows.',
      'Use it only as background. The current request is authoritative.',
      '',
      'Saved conversation summary:',
      truncate(storedSummary, MAX_STORED_SUMMARY_CHARS),
    ].join('\n'), MAX_CONTEXT_CHARS)

    return [
      contextText,
      '',
      'Current request:',
      currentPrompt,
    ].join('\n')
  }

  if (!includeHistory) return currentPrompt

  const summary = summarizeSession(activeSession)
  const contextBlock = [
    'Current conversation so far:',
    `First request: ${truncate(normalizeText(activeSession.prompt), MAX_PROMPT_CHARS)}`,
  ]

  if (summary) {
    contextBlock.push(`Relevant result:\n${summary}`)
  }

  const contextText = truncate([
    'Coding-agent context from the active conversation follows.',
    'Use it only as background. The current request is authoritative.',
    '',
    contextBlock.join('\n'),
  ].join('\n'), MAX_CONTEXT_CHARS)

  return [
    contextText,
    '',
    'Current request:',
    currentPrompt,
  ].join('\n')
}
