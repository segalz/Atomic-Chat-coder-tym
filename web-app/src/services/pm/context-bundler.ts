import { fs } from '@janhq/core'
import type { DependencyNode } from '@/types/pm/dependency-tree'

export async function bundleContext(
  root: DependencyNode,
  projectRoot: string
): Promise<string> {
  const lines: string[] = []

  lines.push(`# Project Context: \`${root.relativePath}\``)
  lines.push(`> Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
  lines.push(`> Project root: \`${projectRoot}\``)
  lines.push('')

  lines.push('## Entry File (full source)')
  lines.push('')
  lines.push(`**\`${root.relativePath}\`**`)
  lines.push('')

  if (root.absolutePath && (await fs.existsSync(root.absolutePath))) {
    const ext = root.relativePath.split('.').pop() || ''
    const content = await fs.readFileSync(root.absolutePath)
    if (content && typeof content === 'string') {
      lines.push('```' + ext)
      lines.push(content)
      lines.push('```')
    }
  }
  lines.push('')

  lines.push('## Dependency Tree (paths only)')
  lines.push('')
  lines.push('```')
  lines.push(root.relativePath)
  appendTree(lines, root, '')
  lines.push('```')
  lines.push('')

  const local = countLocal(root) - 1
  const external = countExternal(root)
  lines.push('---')
  lines.push(`**Local dependencies:** ${local}  |  **External packages:** ${external}`)

  return lines.join('\n')
}

function appendTree(lines: string[], node: DependencyNode, prefix: string): void {
  const visibleChildren = node.children.filter(c => !c.isExternal)

  for (let i = 0; i < visibleChildren.length; i++) {
    const isLast = i === visibleChildren.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    const child = visibleChildren[i]
    const label = child.isUnresolved ? `[?] ${child.relativePath}` : child.relativePath
    lines.push(prefix + connector + label)
    if (!child.isUnresolved) {
      appendTree(lines, child, childPrefix)
    }
  }
}

function countLocal(n: DependencyNode): number {
  return (n.isExternal || n.isUnresolved ? 0 : 1) +
    n.children.reduce((sum, c) => sum + countLocal(c), 0)
}

function countExternal(n: DependencyNode): number {
  return (n.isExternal ? 1 : 0) +
    n.children.reduce((sum, c) => sum + countExternal(c), 0)
}

export function renderTree(root: DependencyNode): string {
  const lines: string[] = []
  lines.push(root.relativePath)
  appendTree(lines, root, '')
  return lines.join('\n')
}
