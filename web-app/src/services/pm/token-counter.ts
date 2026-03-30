export function estimateTokens(text: string): number {
  if (!text) return 0

  let hebrewChars = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x0590 && code <= 0x05ff) {
      hebrewChars++
    }
  }

  const otherChars = text.length - hebrewChars
  return Math.ceil(hebrewChars / 2.0 + otherChars / 4.0)
}

export function formatTokenLabel(tokens: number): string {
  if (tokens < 1000) {
    return `~${tokens} tokens  ✅`
  }
  if (tokens < 10000) {
    return `~${tokens.toLocaleString()} tokens  ⚠️`
  }
  return `~${tokens.toLocaleString()} tokens  ❌`
}
