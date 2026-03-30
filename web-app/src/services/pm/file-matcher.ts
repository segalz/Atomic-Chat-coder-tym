/**
 * File matcher: TF-IDF scoring to match extracted text to project files.
 * Ported from PromptMaster's VisionService.cs (Step 2: deterministic scoring).
 */

import { fs, joinPath } from '@janhq/core'

export interface FileScore {
  file: string
  score: number
}

export interface MatchResult {
  bestFile: string
  topCandidates: string[]
  isHighConfidence: boolean
}

// Synonym dictionary for fuzzy matching
const SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'login', 'signin', 'sign_in', 'authorize'],
  login: ['auth', 'authentication', 'signin', 'sign_in', 'authorize'],
  signin: ['auth', 'authentication', 'login', 'sign_in'],
  nav: ['navigation', 'router', 'routing', 'navigate'],
  navigation: ['nav', 'router', 'routing', 'navigate'],
  home: ['main', 'dashboard', 'feed', 'index'],
  main: ['home', 'dashboard', 'feed', 'index'],
  dashboard: ['home', 'main', 'feed'],
  profile: ['user', 'account', 'settings'],
  user: ['profile', 'account'],
  settings: ['config', 'configuration', 'preferences', 'options'],
  config: ['settings', 'configuration', 'preferences', 'options'],
  list: ['feed', 'items', 'results', 'search'],
  feed: ['list', 'home', 'main'],
  detail: ['details', 'view', 'info', 'item'],
  details: ['detail', 'view', 'info', 'item'],
  search: ['find', 'filter', 'query', 'list'],
  register: ['registration', 'signup', 'sign_up', 'onboarding'],
  signup: ['register', 'registration', 'onboarding'],
  onboard: ['register', 'signup', 'welcome'],
  welcome: ['onboard', 'splash', 'intro'],
  splash: ['welcome', 'intro', 'loading'],
  loading: ['splash', 'spinner'],
  map: ['location', 'geo'],
  chat: ['message', 'messages', 'conversation'],
  message: ['chat', 'conversation', 'notification'],
  report: ['form', 'submit'],
  form: ['report', 'input', 'edit'],
  edit: ['form', 'update'],
  vessel: ['boat', 'ship', 'marine'],
  boat: ['vessel', 'ship'],
}

/**
 * Score project files by TF-IDF matching against visible words.
 * Words prefixed with [F] (field labels) get 2x weight.
 */
export async function scoreFilesByContent(
  relativeFiles: string[],
  projectRoot: string,
  visibleWords: string[]
): Promise<FileScore[]> {
  // Filter meaningful words
  let meaningful = visibleWords
    .filter(w => !w.startsWith('[SCREEN]'))
    .filter(w => w.length >= 4 || w.startsWith('[F]'))
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .sort((a, b) => b.length - a.length)

  if (meaningful.length === 0) {
    meaningful = visibleWords
      .filter(w => !w.startsWith('[SCREEN]') && w.length >= 2)
      .filter((w, i, arr) => arr.indexOf(w) === i)
  }

  if (meaningful.length === 0) return []

  // Load file contents
  const fileContents: { rel: string; content: string }[] = []
  for (const rel of relativeFiles) {
    try {
      const absPath = rel.startsWith('/') ? rel : await joinPath([projectRoot, rel])
      const content = await fs.readFileSync(absPath)
      if (content && typeof content === 'string') {
        fileContents.push({ rel, content })
      }
    } catch { /* skip unreadable files */ }
  }

  // Pass 1: IDF - count how many files contain each word
  const wordFileCount = new Map<string, number>()
  for (const word of meaningful) {
    const bare = word.startsWith('[F]') ? word.slice(3) : word
    let count = 0
    for (const fc of fileContents) {
      if (fc.content.toLowerCase().includes(bare.toLowerCase())) count++
    }
    wordFileCount.set(word, count)
  }

  // Pass 2: score each file
  const results: FileScore[] = []
  for (const { rel, content } of fileContents) {
    let score = 0
    const contentLower = content.toLowerCase()

    for (const word of meaningful) {
      const isField = word.startsWith('[F]')
      const bare = isField ? word.slice(3) : word
      if (!contentLower.includes(bare.toLowerCase())) continue

      const fileCount = wordFileCount.get(word) || 1
      const weight = isField ? 2.0 : 1.0
      score += weight * bare.length / fileCount
    }

    if (score > 0) {
      results.push({ file: rel, score: Math.round(score * 10) })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

/**
 * Determine confidence level and return match result.
 */
export function evaluateConfidence(scores: FileScore[]): MatchResult {
  if (scores.length === 0) {
    return { bestFile: '', topCandidates: [], isHighConfidence: false }
  }

  const topScore = scores[0].score
  const secondScore = scores.length > 1 ? scores[1].score : 0
  const top5 = scores.slice(0, 5).map(s => s.file)

  // High confidence: score > 5 AND top is 3x the second
  const isHigh = topScore >= 50 && topScore >= secondScore * 3.0

  return {
    bestFile: scores[0].file,
    topCandidates: top5,
    isHighConfidence: isHigh,
  }
}

/**
 * Get synonyms for a word (for fuzzy file name matching).
 */
export function getSynonyms(word: string): string[] {
  const lower = word.toLowerCase()
  return SYNONYMS[lower] || []
}
