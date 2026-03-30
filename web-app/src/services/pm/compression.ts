export enum CompressionLevel {
  None = 'None',
  Light = 'Light',
  Medium = 'Medium',
  Aggressive = 'Aggressive'
}

function compressLight(text: string): string {
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]+$/gm, '')
  return text.trim()
}

function compressMedium(text: string): string {
  text = compressLight(text)
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  return text
}

function compressAggressive(text: string): string {
  text = compressMedium(text)
  text = text.replace(/\n{2,}/g, '\n')
  text = text.replace(/[ \t]{2,}/g, ' ')
  return text
}

export function compressPrompt(content: string, level: CompressionLevel): string {
  if (!content) return ''
  
  switch (level) {
    case CompressionLevel.Light:
      return compressLight(content)
    case CompressionLevel.Medium:
      return compressMedium(content)
    case CompressionLevel.Aggressive:
      return compressAggressive(content)
    case CompressionLevel.None:
    default:
      return content
  }
}
