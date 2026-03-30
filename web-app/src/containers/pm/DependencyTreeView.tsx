import { useState } from 'react'
import type { DependencyNode } from '@/types/pm/dependency-tree'
import { IconFile, IconPackage, IconQuestionMark, IconChevronRight, IconChevronDown } from '@tabler/icons-react'

interface DependencyTreeViewProps {
  tree: DependencyNode
}

export function DependencyTreeView({ tree }: DependencyTreeViewProps) {
  return (
    <div className="font-mono text-sm">
      <TreeNode node={tree} depth={0} />
    </div>
  )
}

function TreeNode({ node, depth }: { node: DependencyNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 3)
  const localChildren = node.children.filter(c => !c.isExternal)
  const externalChildren = node.children.filter(c => c.isExternal)
  const hasChildren = localChildren.length > 0 || externalChildren.length > 0

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 rounded px-2 py-0.5 hover:bg-accent cursor-pointer ${
          node.isUnresolved ? 'text-destructive' : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + 4}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          expanded ? (
            <IconChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <IconChevronRight size={14} className="shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5" />
        )}

        {node.isUnresolved ? (
          <IconQuestionMark size={14} className="shrink-0 text-destructive" />
        ) : node.isExternal ? (
          <IconPackage size={14} className="shrink-0 text-blue-500" />
        ) : (
          <IconFile size={14} className="shrink-0 text-muted-foreground" />
        )}

        <span className="truncate">
          {node.relativePath}
        </span>
      </div>

      {expanded && (
        <>
          {localChildren.map((child, i) => (
            <TreeNode key={`${child.relativePath}-${i}`} node={child} depth={depth + 1} />
          ))}
          {externalChildren.length > 0 && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 20 + 4}px` }}
            >
              <IconPackage size={14} className="shrink-0 text-blue-500" />
              <span className="text-xs">
                {externalChildren.length} external package{externalChildren.length > 1 ? 's' : ''}: {' '}
                {externalChildren.slice(0, 5).map(c => c.relativePath).join(', ')}
                {externalChildren.length > 5 && ` +${externalChildren.length - 5} more`}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
