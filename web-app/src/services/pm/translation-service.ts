/**
 * Hebrew → English translation via Google Translate unofficial API.
 * Ported from PromptMaster's TranslationService.cs
 */

export async function translateToEnglish(text: string): Promise<string> {
  if (!text || !text.trim()) return text

  const encoded = encodeURIComponent(text)
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=iw&tl=en&dt=t&q=${encoded}`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Translation failed: ${response.status}`)
  }

  const json = await response.json()

  // Response: [[["translated","original",...], ...], ...]
  let result = ''
  if (Array.isArray(json) && Array.isArray(json[0])) {
    for (const segment of json[0]) {
      if (Array.isArray(segment) && segment[0]) {
        result += segment[0]
      }
    }
  }

  return result.trim()
}
