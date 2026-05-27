import type { CodingSession, ExecLogLine } from '@/stores/coding-agent-store'

const MAX_FIELD_CHARS = 900
const MAX_ITEMS = 8

const SUMMARY_HEADINGS = [
  '## Conversation Goal',
  '## Decisions Made',
  '## Important Files',
  '## Work Already Done',
  '## Errors / Failed Attempts',
  '## Constraints / Do Not Break',
  '## Current State',
  '## Recommended Next Step',
]

const STATUS_PREFIXES = [
  '>',
  'Backend:',
  'Model:',
  'LSP Tools:',
  'Starting agent',
  'Ollama agent started',
  'Agent iteration',
  'Diff proposed for',
  'Diff auto-approved for',
]

const FILE_PATH_PATTERN = /(?:[\w.-]+\/)+[\w.@()[\] -]+\.[A-Za-z0-9]+/g

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

function compactLine(value: string): string {
  return normalizeText(value).replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxChars = MAX_FIELD_CHARS): string {
  const normalized = normalizeText(value)
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}...`
}

function isStatusLine(value: string): boolean {
  const trimmed = value.trimStart()
  return STATUS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function listSection(items: string[], fallback: string): string {
  const uniqueItems = Array.from(new Set(items.map(compactLine).filter(Boolean))).slice(0, MAX_ITEMS)
  if (uniqueItems.length === 0) return fallback
  return uniqueItems.map((item) => `- ${truncate(item, 220)}`).join('\n')
}

function sessionText(session: CodingSession): string {
  return [
    session.prompt,
    session.planText,
    ...session.execLog.map((line) => line.content),
  ].join('\n')
}

function extractFiles(session: CodingSession): string[] {
  const matches = sessionText(session).match(FILE_PATH_PATTERN) ?? []
  return matches.map((match) => match.replace(/[),.;:]+$/, ''))
}

function userPrompts(session: CodingSession): string[] {
  return session.execLog
    .filter((line) => line.type === 'text_delta')
    .map((line) => line.content.trim())
    .filter((content) => content.startsWith('>'))
    .map((content) => content.replace(/^>\s*/, ''))
}

function assistantLines(session: CodingSession): string[] {
  return session.execLog
    .filter((line) => line.type === 'text_delta' || line.type === 'thinking' || line.type === 'done')
    .map((line) => line.content)
    .map(compactLine)
    .filter((content) => content && !isStatusLine(content))
}

function errorLines(lines: ExecLogLine[]): string[] {
  return lines
    .filter((line) => line.type === 'error' || /(?:error|failed|failure|exception|timeout|timed out)/i.test(line.content))
    .map((line) => line.content)
}

function constraintLines(session: CodingSession): string[] {
  return [session.prompt, ...userPrompts(session)]
    .flatMap((text) => normalizeText(text).split('\n'))
    .filter((line) => /\b(?:must|do not|don't|never|keep|without|only|scope|requirement|required)\b/i.test(line))
}

function currentState(session: CodingSession): string {
  const visibleLines = [...session.execLog]
    .reverse()
    .map((line) => compactLine(line.content))
    .filter((content) => content && !isStatusLine(content))

  return visibleLines[0] ?? truncate(session.planText || session.prompt, 260)
}

export function buildConversationSummary(session: CodingSession): string | null {
  if (session.source === 'loop') return null

  const prompts = [session.prompt, ...userPrompts(session)].map(compactLine).filter(Boolean)
  const goal = prompts[0] ?? 'No explicit goal captured.'
  const followUps = prompts.slice(1)
  const workLines = assistantLines(session)
  const errors = errorLines(session.execLog)
  const constraints = constraintLines(session)

  return [
    SUMMARY_HEADINGS[0],
    truncate(goal, 500),
    '',
    SUMMARY_HEADINGS[1],
    listSection(followUps, 'No explicit decisions captured yet.'),
    '',
    SUMMARY_HEADINGS[2],
    listSection(extractFiles(session), 'No specific files captured yet.'),
    '',
    SUMMARY_HEADINGS[3],
    listSection(workLines, 'No completed work captured yet.'),
    '',
    SUMMARY_HEADINGS[4],
    listSection(errors, 'No errors or failed attempts captured.'),
    '',
    SUMMARY_HEADINGS[5],
    listSection(constraints, 'No special constraints captured beyond the current request.'),
    '',
    SUMMARY_HEADINGS[6],
    truncate(currentState(session), 500) || 'No current state captured.',
    '',
    SUMMARY_HEADINGS[7],
    'Continue from the current state above. Treat the next user request as authoritative.',
  ].join('\n')
}
