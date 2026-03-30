import { useState } from 'react'
import { IconAlertTriangle, IconCheck, IconFile, IconSearch, IconCopy, IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { DependencyTreeView } from './DependencyTreeView'
import type { FileScore } from '@/services/pm/file-matcher'
import type { DependencyNode } from '@/types/pm/dependency-tree'

export function VisionResultPanel({
  screenDescription,
  bestFile,
  isHighConfidence,
  scores,
  extractedWords,
  analyzedTree,
  bundledContext,
  isAnalyzingTree,
  onAnalyzeFile,
}: {
  screenDescription: string
  bestFile: string
  isHighConfidence: boolean
  scores: FileScore[]
  extractedWords: string[]
  analyzedTree: DependencyNode | null
  bundledContext: string
  isAnalyzingTree: boolean
  onAnalyzeFile: (file: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [showContext, setShowContext] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(bundledContext)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex w-1/2 flex-col overflow-auto">
      {screenDescription && (
        <div className="mb-3 rounded-lg border bg-muted/30 px-4 py-2">
          <p className="text-xs font-medium text-muted-foreground">Screen</p>
          <p className="text-sm">{screenDescription}</p>
        </div>
      )}

      {bestFile && (
        <div
          className={`mb-3 rounded-lg border px-4 py-3 ${
            isHighConfidence
              ? 'border-green-500/30 bg-green-500/5'
              : 'border-yellow-500/30 bg-yellow-500/5'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isHighConfidence ? (
                <IconCheck size={16} className="text-green-600" />
              ) : (
                <IconAlertTriangle size={16} className="text-yellow-600" />
              )}
              <span className="text-xs font-medium">
                {isHighConfidence ? 'High Confidence' : 'Best Match'}
              </span>
            </div>
            {!isHighConfidence && !analyzedTree && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                disabled={isAnalyzingTree}
                onClick={() => onAnalyzeFile(bestFile)}
              >
                <IconSearch size={14} />
                Analyze
              </Button>
            )}
          </div>
          <p className="mt-1 font-mono text-sm">{bestFile}</p>
        </div>
      )}

      {/* Analyzing indicator */}
      {isAnalyzingTree && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <div className="size-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
          Analyzing dependency tree...
        </div>
      )}

      {/* Dependency Tree */}
      {analyzedTree && (
        <div className="mb-3 rounded-lg border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Dependency Tree</p>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={handleCopy}
            >
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              {copied ? 'Copied' : 'Copy Context'}
            </Button>
          </div>
          <div className="max-h-64 overflow-auto">
            <DependencyTreeView tree={analyzedTree} />
          </div>
        </div>
      )}

      {/* Bundled Context Preview */}
      {bundledContext && (
        <div className="mb-3">
          <button
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowContext(!showContext)}
          >
            {showContext ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            Full Context ({Math.ceil(bundledContext.length / 4).toLocaleString()} ~tokens)
          </button>
          {showContext && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
              {bundledContext}
            </pre>
          )}
        </div>
      )}

      {scores.length > 0 && (
        <div className="mb-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Top Candidates
          </p>
          <div className="space-y-1">
            {scores.slice(0, 8).map((s) => (
              <div
                key={s.file}
                className="group flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
              >
                <span className="w-8 text-right font-mono text-muted-foreground">
                  {s.score}
                </span>
                <IconFile size={12} className="shrink-0" />
                <span className="flex-1 truncate font-mono">{s.file}</span>
                {s.file !== bestFile && !analyzedTree && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hidden h-5 gap-1 px-1.5 text-[10px] group-hover:flex"
                    disabled={isAnalyzingTree}
                    onClick={() => onAnalyzeFile(s.file)}
                  >
                    <IconSearch size={10} />
                    Analyze
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {extractedWords.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Extracted Text (
            {extractedWords.filter((w) => !w.startsWith('[SCREEN]')).length} items)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {extractedWords
              .filter((w) => !w.startsWith('[SCREEN]'))
              .map((w, i) => (
                <span
                  key={i}
                  dir="auto"
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    w.startsWith('[F]')
                      ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {w.startsWith('[F]') ? w.slice(3) : w}
                  {w.startsWith('[F]') && (
                    <span className="ml-1 text-[10px] opacity-60">field</span>
                  )}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
