export function renderTemplate(template: string, variables: Record<string, string>): string {
  if (!template) return ''
  let result = template

  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }

  const missing = [...result.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])
  if (missing.length > 0) {
    throw new Error(`Missing values for: ${missing.join(', ')}`)
  }

  return result
}
