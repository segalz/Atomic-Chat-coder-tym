import { fs, joinPath } from '@janhq/core'
import type { DependencyNode } from '@/types/pm/dependency-tree'

const FOLLOW_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']
const TRY_EXTENSIONS = [
  '.tsx', '.ts', '.jsx', '.js',
  '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
]

const IMPORT_PATTERNS = [
  /import\s+.*?from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+.*?from\s+['"]([^'"]+)['"]/g,
]

export async function analyzeProject(
  projectRoot: string,
  entryFilePath: string
): Promise<DependencyNode> {
  const visited = new Set<string>()

  async function resolve(fromDir: string, importPath: string): Promise<string | null> {
    const exact = await joinPath([fromDir, importPath])
    if (await fs.existsSync(exact)) return exact

    for (const ext of TRY_EXTENSIONS) {
      const candidate = await joinPath([fromDir, importPath + ext])
      if (await fs.existsSync(candidate)) return candidate
    }
    return null
  }

  function extractImports(code: string): string[] {
    const results = new Set<string>()
    for (const pattern of IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(code)) !== null) {
        results.add(match[1])
      }
    }
    return Array.from(results)
  }

  function getRelativePath(fullPath: string): string {
    if (fullPath.startsWith(projectRoot)) {
      let rel = fullPath.slice(projectRoot.length)
      if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
      return rel
    }
    return fullPath
  }

  function getExtension(path: string): string {
    const lastDot = path.lastIndexOf('.')
    return lastDot >= 0 ? path.slice(lastDot) : ''
  }

  function getDirname(path: string): string {
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return lastSlash >= 0 ? path.slice(0, lastSlash) : path
  }

  async function buildTree(absolutePath: string): Promise<DependencyNode> {
    const relPath = getRelativePath(absolutePath)
    const node: DependencyNode = {
      absolutePath,
      relativePath: relPath,
      children: [],
      isExternal: false,
      isUnresolved: false,
    }

    if (visited.has(absolutePath.toLowerCase())) return node
    visited.add(absolutePath.toLowerCase())

    if (!(await fs.existsSync(absolutePath))) {
      node.isUnresolved = true
      return node
    }

    const ext = getExtension(absolutePath).toLowerCase()
    if (!FOLLOW_EXTENSIONS.includes(ext)) return node

    const content = await fs.readFileSync(absolutePath)
    if (!content || typeof content !== 'string') return node

    const dir = getDirname(absolutePath)

    for (const importPath of extractImports(content)) {
      if (importPath.startsWith('.')) {
        const resolved = await resolve(dir, importPath)
        if (resolved) {
          node.children.push(await buildTree(resolved))
        } else {
          node.children.push({
            absolutePath: '',
            relativePath: importPath,
            children: [],
            isExternal: false,
            isUnresolved: true,
          })
        }
      } else {
        node.children.push({
          absolutePath: '',
          relativePath: importPath,
          children: [],
          isExternal: true,
          isUnresolved: false,
        })
      }
    }

    return node
  }

  return buildTree(entryFilePath)
}
