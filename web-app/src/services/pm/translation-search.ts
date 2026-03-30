/**
 * Search Hebrew phrases in translation JSON files.
 * Ported from PromptMaster's TranslationSearchService.cs
 */

import { fs } from '@janhq/core'

export interface TranslationMatch {
  hebrewText: string
  key: string
  line: number
  parentObject: string
  rowContext: string
}

/** Normalize Hebrew: collapse double-yod (יי → י) for OCR variant matching */
function normalizeHebrew(s: string): string {
  return s.replace(/יי/g, 'י')
}

/**
 * Search a translation JSON file for Hebrew values matching the given phrases.
 * Uses exact phrase match first (with normalization), then falls back to all-tokens match.
 */
export async function searchTranslations(
  jsonFilePath: string,
  hebrewPhrases: string[]
): Promise<TranslationMatch[]> {
  if (!(await fs.existsSync(jsonFilePath))) return []

  // Clean phrases: remove [F] prefix, filter short
  const phrases = hebrewPhrases
    .map(w => w.startsWith('[F]') ? w.slice(3) : w)
    .filter(w => w.length >= 2)
    .filter((w, i, arr) => arr.indexOf(w) === i)

  if (phrases.length === 0) return []

  // Tokenize each phrase
  const phraseData = phrases
    .map(p => {
      const normalized = normalizeHebrew(p)
      const tokens = normalized
        .split(/\s+/)
        .filter(t => t.length >= 3)
      return { original: p, normalized, tokens }
    })
    .filter(x => x.tokens.length > 0)

  if (phraseData.length === 0) return []

  const rawContent = await fs.readFileSync(jsonFilePath)
  if (!rawContent || typeof rawContent !== 'string') return []

  const rawLines = rawContent.split('\n')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return []
  }

  const exactMatches: TranslationMatch[] = []
  const allTokenMatches: TranslationMatch[] = []

  const entries = collectStringEntries(parsed)

  for (const entry of entries) {
    if (!entry.value) continue

    const normalizedValue = normalizeHebrew(entry.value)
    let isExact = false
    let isAllTokens = false

    for (const pd of phraseData) {
      const needle = pd.normalized.toLowerCase()
      const haystack = normalizedValue.toLowerCase()

      // Exact phrase match (normalized, case-insensitive)
      if (haystack.includes(needle)) {
        isExact = true
        break
      }

      // All tokens match
      if (pd.tokens.every((t) => haystack.includes(t.toLowerCase()))) {
        isAllTokens = true
      }
    }

    if (!isExact && !isAllTokens) continue

    const parentPath = entry.path.length > 1 ? entry.path.slice(0, -1).join('.') : ''
    const key = entry.path.join('.')
    const lastKey = entry.path[entry.path.length - 1] || key
    const rowContext = `"${lastKey}": ${JSON.stringify(entry.value)}`
    const line = findLineNumber(rawLines, rowContext) || findLineNumber(rawLines, `"${lastKey}"`)

    const match: TranslationMatch = {
      hebrewText: entry.value,
      key,
      line,
      parentObject: parentPath || '(root)',
      rowContext,
    }

    if (isExact) exactMatches.push(match)
    else allTokenMatches.push(match)
  }

  // Prefer exact matches; fall back to all-token matches
  const results = exactMatches.length > 0
    ? exactMatches.sort((a, b) => a.line - b.line)
    : allTokenMatches.sort((a, b) => a.line - b.line)

  return results
}

function findLineNumber(lines: string[], snippet: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(snippet)) return i + 1
  }
  return 0
}

function collectStringEntries(value: unknown): Array<{ path: string[]; value: string }> {
  const results: Array<{ path: string[]; value: string }> = []

  const walk = (node: unknown, path: string[]) => {
    if (typeof node === 'string') {
      results.push({ path, value: node })
      return
    }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, [...path, k])
    }
  }

  walk(value, [])
  return results
}
