import { fs } from '@janhq/core'
import { homeDir, join, dirname } from '@tauri-apps/api/path'
import type { PromptTemplate } from '@/types/pm/prompt-template'

export async function getLibraryPath(): Promise<string> {
  const home = await homeDir()
  // Ensure we use the exact path from C#: ~/prompt-master/library.json
  return join(home, 'prompt-master', 'library.json')
}

export async function loadTemplates(): Promise<PromptTemplate[]> {
  try {
    const libraryPath = await getLibraryPath()
    const exists = await fs.existsSync(libraryPath)
    if (!exists) return []
    
    const content = await fs.readFileSync(libraryPath)
    if (!content || typeof content !== 'string') return []
    
    return JSON.parse(content) as PromptTemplate[]
  } catch (err) {
    console.error('Failed to load PromptMaster templates:', err)
    return []
  }
}

export async function saveTemplates(templates: PromptTemplate[]): Promise<void> {
  try {
    const libraryPath = await getLibraryPath()
    const dir = await dirname(libraryPath)
    
    const dirExists = await fs.existsSync(dir)
    if (!dirExists) {
      // In @janhq/core or standard fs, we can try to create the dir
      // If it throws, we can ignore or handle, assuming parent directories might need recursive creation
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch (e) {
         console.warn('Could not create directory, it might already exist', e)
      }
    }
    
    const json = JSON.stringify(templates, null, 2)
    await fs.writeFileSync(libraryPath, json)
  } catch (err) {
    console.error('Failed to save PromptMaster templates:', err)
    throw err
  }
}
