/**
 * Vision analyzer: extracts visible text from screenshots using a vision model.
 * Ported from PromptMaster's VisionService.cs (Step 1: text extraction + parsing).
 */

export interface VisibleWord {
  text: string
  type: 'field' | 'step' | 'action' | 'text'
}

export interface VisionExtractionResult {
  screenDescription: string
  words: VisibleWord[]
  rawWords: string[] // with [F] prefix for fields
}

const VISION_PROMPT = `Analyze this mobile app screenshot. Output:

LINE 1: Screen type description in English (e.g. "Login screen with email field and login button")

Then for each visible UI element, output: COMPONENT|TEXT
Components: title, input_label, input_value, button, link, logo, tab, header, footer, text

Example:
SCREEN: Login page with email field, sign-in button, forgot password link
title|Welcome Back
input_label|Email
input_value|user@example.com
button|Sign In
link|Forgot Password?
logo|MyApp

Output ONLY the structured lines, nothing else.`

function normalizeType(t: string): 'field' | 'step' | 'action' | 'text' | 'skip' {
  const lower = t.trim().toLowerCase().replace(/_/g, '')
  switch (lower) {
    case 'field': case 'label': case 'inputlabel':
    case '\u05E9\u05D3\u05D4': case '\u05EA\u05D5\u05D5\u05D9\u05EA': // שדה, תווית
      return 'field'
    case 'step': case 'title':
    case '\u05E9\u05DC\u05D1': case '\u05DB\u05D5\u05EA\u05E8\u05EA': // שלב, כותרת
      return 'step'
    case 'button': case 'link': case 'action': case 'tab':
      return 'action'
    case 'inputvalue': case 'logo': case 'header': case 'footer':
      return 'skip'
    case 'text':
      return 'text'
    default:
      return 'skip'
  }
}

/**
 * Send screenshot to a vision model and extract structured text.
 * Uses Atomic Chat's local API server (localhost:1337).
 */
export async function extractVisibleText(
  imageBase64: string,
  imageMediaType = 'image/png',
  modelId?: string
): Promise<VisionExtractionResult> {
  const payload = {
    model: modelId || undefined,
    max_tokens: 500,
    temperature: 0.0,
    messages: [
      {
        role: 'system',
        content: 'You are a UI component analyzer. Output ONLY structured lines: first a SCREEN: description, then COMPONENT|TEXT lines. No explanations.',
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${imageMediaType};base64,${imageBase64}` } },
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ],
  }

  const response = await fetch('http://localhost:1337/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Vision API error: ${response.status}`)
  }

  const data = await response.json()
  const raw = data.choices?.[0]?.message?.content || ''

  return parseVisionOutput(raw)
}

/**
 * Parse the raw vision model output into structured words.
 */
export function parseVisionOutput(raw: string): VisionExtractionResult {
  // Extract SCREEN description
  const screenLine = raw.split('\n')
    .map(l => l.trim())
    .find(l => l.toUpperCase().startsWith('SCREEN:'))
  const screenDescription = screenLine
    ? screenLine.slice('SCREEN:'.length).trim()
    : ''

  // Parse structured lines: TYPE|TEXT or TYPE: TEXT
  const linePattern = /^[-*•]?\s*([A-Za-z_\u0590-\u05FF]+)\s*[|:]\s*(.+)$/
  const structured: VisibleWord[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.toUpperCase().startsWith('SCREEN:')) continue

    const match = linePattern.exec(trimmed)
    if (!match) continue

    const type = normalizeType(match[1])
    const text = match[2].trim().replace(/^["']|["']$/g, '')

    if (type !== 'skip' && text.length >= 2) {
      structured.push({ text, type })
    }
  }

  if (structured.length >= 2) {
    const rawWords = buildRawWords(screenDescription, structured)
    return { screenDescription, words: structured, rawWords }
  }

  // Fallback A: natural language format ("Field 1 Label: ...")
  const nlFieldPattern = /Field\s*\d+\s*Label:\s*"([^"]+)"/gi
  const nlStepPattern = /(?:Progress|Step)\s*(?:bar)?\s*(?:label|name)?:\s*"([^"]+)"/gi

  const nlResults: VisibleWord[] = []
  let m
  while ((m = nlFieldPattern.exec(raw)) !== null) {
    const text = m[1].trim().replace(/\*\s*$/, '').trim()
    if (text.length >= 2) nlResults.push({ text, type: 'field' })
  }
  while ((m = nlStepPattern.exec(raw)) !== null) {
    const text = m[1].trim().replace(/\*\s*$/, '').trim()
    if (text.length >= 2) nlResults.push({ text, type: 'step' })
  }

  if (nlResults.length > 0) {
    const combined = [...nlResults, ...structured]
    const unique = combined.filter((w, i, arr) =>
      arr.findIndex(x => x.text === w.text) === i
    )
    const rawWords = buildRawWords(screenDescription, unique)
    return { screenDescription, words: unique, rawWords }
  }

  // Fallback B: extract Hebrew via regex
  const hebrewPattern = /[\u0590-\u05FF][\u0590-\u05FF\s.,:\-/\u05BE\u05C0\u05C3]{1,30}[\u0590-\u05FF]|[\u0590-\u05FF]{3,}/g
  const hebrewWords: VisibleWord[] = []
  while ((m = hebrewPattern.exec(raw)) !== null) {
    const text = m[0].trim()
    if (text.length >= 3) hebrewWords.push({ text, type: 'text' })
  }

  const quotedPattern = /"([A-Za-z][A-Za-z ]{2,30})"/g
  while ((m = quotedPattern.exec(raw)) !== null) {
    const text = m[1].trim()
    if (text.length >= 4) hebrewWords.push({ text, type: 'text' })
  }

  const rawWords = buildRawWords(screenDescription, hebrewWords)
  return { screenDescription, words: hebrewWords, rawWords }
}

function buildRawWords(screenDesc: string, words: VisibleWord[]): string[] {
  const result: string[] = []
  if (screenDesc) result.push(`[SCREEN]${screenDesc}`)
  for (const w of words.sort((a, b) => {
    const order = { field: 0, action: 1, step: 2, text: 3 }
    return (order[a.type] || 3) - (order[b.type] || 3)
  })) {
    result.push(w.type === 'field' ? `[F]${w.text}` : w.text)
  }
  return result
}
