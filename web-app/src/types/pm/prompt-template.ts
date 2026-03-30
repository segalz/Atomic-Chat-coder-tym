export interface PromptTemplate {
  id: string
  name: string
  category: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
  entryFilePath?: string
}

export function extractVariables(content: string): string[] {
  if (!content) return []
  const matches = [...content.matchAll(/\{\{(\w+)\}\}/g)]
  return Array.from(new Set(matches.map(m => m[1])))
}
