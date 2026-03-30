import { fs, joinPath } from '@janhq/core'
import type { ProjectDna, FolderGroup } from '@/types/pm/dependency-tree'

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.cs', '.py', '.go', '.java', '.swift', '.kt',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'bin', 'obj', '__pycache__', 'dist', '.next', 'build', '.expo',
])

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

function baseName(path: string): string {
  return normalizeSeparators(path).split('/').pop() || path
}

function toRelative(root: string, fullPath: string): string {
  let rel = fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath
  rel = rel.replace(/^[\\/]/, '')
  rel = normalizeSeparators(rel)
  return rel
}

export async function analyzeProjectDna(projectRoot: string): Promise<ProjectDna> {
  const techStack = await detectTechStack(projectRoot)
  const folderGroups = await buildFolderGroups(projectRoot)
  const namingConventions = detectNamingConventions(folderGroups)

  return { projectRoot, techStack, folderGroups, namingConventions }
}

async function detectTechStack(root: string): Promise<string[]> {
  const techs: string[] = []

  const pkgPath = await joinPath([root, 'package.json'])
  if (await fs.existsSync(pkgPath)) {
    try {
      const raw = await fs.readFileSync(pkgPath)
      if (raw && typeof raw === 'string') {
        const pkg = JSON.parse(raw)
        const allDeps = new Set<string>([
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ].map(k => k.toLowerCase()))

        if ([...allDeps].some(k => k.includes('react-native'))) techs.push('React Native')
        if ([...allDeps].some(k => k.includes('expo'))) techs.push('Expo')
        if ([...allDeps].some(k => k.includes('gluestack'))) techs.push('Gluestack UI')
        if ([...allDeps].some(k => k.includes('react-navigation'))) techs.push('React Navigation')
        if ([...allDeps].some(k => k.includes('redux'))) techs.push('Redux')
        if ([...allDeps].some(k => k.includes('mobx'))) techs.push('MobX')
        if (allDeps.has('react')) techs.push('React')
        if ([...allDeps].some(k => k.includes('next'))) techs.push('Next.js')
        if ([...allDeps].some(k => k.includes('vue'))) techs.push('Vue')
        if ([...allDeps].some(k => k.includes('angular'))) techs.push('Angular')
        if ([...allDeps].some(k => k.includes('axios'))) techs.push('Axios')
        if ([...allDeps].some(k => k.includes('tauri'))) techs.push('Tauri')
        if ([...allDeps].some(k => k.includes('svelte'))) techs.push('Svelte')
      }
    } catch { /* ignore parse errors */ }
  }

  // Check .NET
  try {
    const entries = (await fs.readdirSync(root)) as unknown
    if (Array.isArray(entries)) {
      const names = entries
        .filter((e): e is string => typeof e === 'string')
        .map(baseName)
        .filter(Boolean)
      if (names.some((n: string) => n.endsWith('.csproj'))) techs.push('.NET / C#')
      if (names.some((n: string) => n.endsWith('.sln'))) techs.push('.NET Solution')
    }
  } catch { /* ignore */ }

  // Check Python
  const reqPath = await joinPath([root, 'requirements.txt'])
  const pyprojectPath = await joinPath([root, 'pyproject.toml'])
  if (await fs.existsSync(reqPath) || await fs.existsSync(pyprojectPath)) techs.push('Python')

  // Check Rust
  const cargoPath = await joinPath([root, 'Cargo.toml'])
  if (await fs.existsSync(cargoPath)) techs.push('Rust')

  return techs.length > 0 ? techs : ['Unknown']
}

async function buildFolderGroups(root: string): Promise<FolderGroup[]> {
  const groups = new Map<string, string[]>()

  async function walk(dir: string): Promise<void> {
    try {
      const entries = (await fs.readdirSync(dir)) as unknown
      if (!Array.isArray(entries)) return

      for (const entry of entries) {
        if (typeof entry !== 'string') continue
        const name = baseName(entry)
        if (!name) continue
        if (SKIP_DIRS.has(name)) continue

        const info = await fs.fileStat(entry)

        if (info?.isDirectory) {
          await walk(entry)
        } else {
          const lastDot = name.lastIndexOf('.')
          const ext = lastDot >= 0 ? name.slice(lastDot) : ''
          if (CODE_EXTENSIONS.has(ext)) {
            const relFile = toRelative(root, entry)
            const lastSlash = relFile.lastIndexOf('/')
            const dirPart = lastSlash >= 0 ? relFile.slice(0, lastSlash) : '(root)'

            const nameWithoutExt = name.replace(/\.[^/.]+$/, '')
            if (!groups.has(dirPart)) groups.set(dirPart, [])
            groups.get(dirPart)!.push(nameWithoutExt)
          }
        }
      }
    } catch { /* ignore permission errors */ }
  }

  await walk(root)

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relPath, fileNames]) => ({
      relativePath: relPath,
      fileNames: fileNames.sort(),
      componentType: inferComponentType(relPath, fileNames),
    }))
}

function inferComponentType(dirPath: string, fileNames: string[]): string {
  const dir = dirPath.toLowerCase().replace(/\\/g, '/')

  if (dir.includes('step')) return 'Wizard Steps'
  if (dir.includes('wizard')) return 'Wizard Components'
  if (dir.includes('screen')) return 'Screens'
  if (dir.includes('page')) return 'Pages'
  if (dir.includes('component')) return 'Components / Screens'
  if (dir.includes('service')) return 'Services / Business Logic'
  if (dir.includes('element')) return 'Reusable UI Elements'
  if (dir.includes('hook')) return 'React Hooks'
  if (dir.includes('util')) return 'Utilities'
  if (dir.includes('store')) return 'State Management'
  if (dir.includes('model')) return 'Data Models'
  if (dir.includes('navigation') || dir.includes('route')) return 'Navigation / Routing'
  if (dir.includes('context') || dir.includes('provider')) return 'React Context / Providers'
  if (dir.includes('asset')) return 'Assets'
  if (dir.includes('style')) return 'Styles'
  if (dir.includes('container')) return 'Containers'
  if (dir === '(root)') return 'Entry Points'

  const suffixes = fileNames.map(getSuffix)
  const suffixCounts = new Map<string, number>()
  for (const s of suffixes) suffixCounts.set(s, (suffixCounts.get(s) || 0) + 1)
  const topSuffix = [...suffixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  if (topSuffix === 'Screen' || topSuffix === 'Page' || topSuffix === 'View')
    return `Screens (suffix: ${topSuffix})`
  if (topSuffix === 'Service' || topSuffix === 'Manager')
    return `Services (suffix: ${topSuffix})`

  const prefixes = fileNames.map(getPrefix)
  const prefixCounts = new Map<string, number>()
  for (const p of prefixes) prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1)
  const topPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  if (topPrefix === 'Step') return 'Wizard Steps (prefix: Step)'
  if (topPrefix === 'Use' || topPrefix === 'use') return 'Custom Hooks'

  return 'Mixed Components'
}

function getPrefix(name: string): string {
  const words = name.match(/[A-Z][a-z]*|[a-z]+/g) || [name]
  return words[0] || name
}

function getSuffix(name: string): string {
  const words = name.match(/[A-Z][a-z]*|[a-z]+/g) || [name]
  return words[words.length - 1] || name
}

function detectNamingConventions(groups: FolderGroup[]): string[] {
  const conventions = new Set<string>()
  const allNames = groups.flatMap(g => g.fileNames)
  if (allNames.length === 0) return []

  if (allNames.some(n => n.length > 0 && n[0] === n[0].toUpperCase() && n[0] !== n[0].toLowerCase()))
    conventions.add('PascalCase screens/components')
  if (allNames.some(n => n.length > 1 && n[0] === n[0].toLowerCase() && /[A-Z]/.test(n.slice(1))))
    conventions.add('camelCase services/utils')
  if (allNames.some(n => n.includes('_')))
    conventions.add('snake_case files')
  if (allNames.some(n => n.startsWith('Step')))
    conventions.add('Step-prefixed wizard steps')
  if (allNames.some(n => n.endsWith('Screen')))
    conventions.add('Screen-suffixed pages')
  if (allNames.some(n => n.endsWith('Service')))
    conventions.add('Service-suffixed logic')

  return Array.from(conventions)
}

export function buildAiContext(dna: ProjectDna): string {
  const lines: string[] = []

  lines.push('=== PROJECT DNA ===')
  lines.push(`Tech: ${dna.techStack.join(', ')}`)

  if (dna.namingConventions.length > 0)
    lines.push(`Naming: ${dna.namingConventions.join(', ')}`)

  lines.push('')
  lines.push('=== FOLDER STRUCTURE (folder -> type -> files) ===')

  for (const g of [...dna.folderGroups].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const names = g.fileNames.length <= 12
      ? g.fileNames.join(', ')
      : g.fileNames.slice(0, 10).join(', ') + `... (+${g.fileNames.length - 10} more)`

    lines.push(`[${g.relativePath}] (${g.componentType})`)
    lines.push(`  Files: ${names}`)
  }

  return lines.join('\n')
}
