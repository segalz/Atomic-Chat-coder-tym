import type { CodingSessionSource } from '@/stores/coding-agent-store'

export type EditPermission = 'allowed' | 'ask' | 'denied'

const CLEAR_EDIT_PATTERNS = [
  /\b(fix|implement|modify|edit|update|change|refactor|create|add|remove|delete|write|build)\b/i,
  /\b(file|code|component|function|class|module|screen|page|bug|test|css|style)\b|קוד|קובץ|קומפוננט|פונקציה|מחלקה|מודול|מסך|עמוד|באג|בדיקה|עיצוב/,
  /(תתקן|תקן|לתקן|תוסיף|הוסף|להוסיף|תשנה|שנה|לשנות|תעדכן|עדכן|לעדכן|תממש|לממש|תבנה|בנה|לבנות|תמחק|מחק|למחוק|תיצור|צור|ליצור|ערוך|לערוך)/,
]

const ANSWER_ONLY_PATTERNS = [
  /^(what|why|how|when|where|who)\b/i,
  /\b(calculate|compute|explain|remember|recall|tell me|what is|why is|how do)\b/i,
  /\b(add|subtract|multiply|divide)\s+\d+\b/i,
  /(מה|למה|איך|מתי|איפה|מי|תסביר|הסבר|חשב|תחשב|זוכר|תזכור|תגיד|שאלה)/,
  /^\s*[\d\s+\-*/().=]+\s*$/,
]

export function getEditPermissionForPrompt(prompt: string, source: CodingSessionSource): EditPermission {
  if (source === 'loop') return 'allowed'

  const normalized = prompt.trim()
  if (!normalized) return 'denied'

  const hasEditVerb = CLEAR_EDIT_PATTERNS[0].test(normalized) || CLEAR_EDIT_PATTERNS[2].test(normalized)
  const hasCodeTarget = CLEAR_EDIT_PATTERNS[1].test(normalized)

  if (hasEditVerb && hasCodeTarget) return 'allowed'
  if (ANSWER_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'denied'
  if (hasEditVerb) return 'ask'

  return 'ask'
}
