import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useProjectModeStore } from '@/stores/project-mode-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { extractVisibleText } from '@/services/pm/vision-analyzer'
import { scoreFilesByContent, evaluateConfidence } from '@/services/pm/file-matcher'
import { route } from '@/constants/routes'
import { VisionResultPanel } from './VisionResultPanel'
import {
  IconArrowLeft,
  IconCamera,
  IconChevronDown,
  IconUpload,
} from '@tabler/icons-react'
import type { FileScore } from '@/services/pm/file-matcher'
import type { DependencyNode } from '@/types/pm/dependency-tree'

export function ScreenshotDropZone() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { projectRoot } = useProjectModeStore()
  const { providers, selectedModel } = useModelProvider()

  const visionModels = useMemo(() => {
    const result: Array<{ provider: string; model: Model }> = []
    for (const provider of providers) {
      for (const model of provider.models || []) {
        if ((model.capabilities || []).includes('vision')) {
          result.push({ provider: provider.provider, model })
        }
      }
    }
    return result
  }, [providers])

  const defaultVisionModelId = useMemo(() => {
    if (selectedModel?.capabilities?.includes('vision')) return selectedModel.id
    return visionModels[0]?.model.id || ''
  }, [selectedModel?.capabilities, selectedModel?.id, visionModels])

  const [visionModelId, setVisionModelId] = useState<string>('')

  useEffect(() => {
    if (!visionModelId && defaultVisionModelId) {
      setVisionModelId(defaultVisionModelId)
    }
  }, [defaultVisionModelId, visionModelId])

  const selectedVisionModel = useMemo(() => {
    return visionModels.find((m) => m.model.id === visionModelId)?.model || null
  }, [visionModelId, visionModels])

  const selectedVisionModelLabel =
    selectedVisionModel?.displayName ||
    selectedVisionModel?.name ||
    selectedVisionModel?.id ||
    ''

  const { setEntryFile, analyzeProject: runAnalysis } = useProjectModeStore()

  const [isDragging, setIsDragging] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extractedWords, setExtractedWords] = useState<string[]>([])
  const [scores, setScores] = useState<FileScore[]>([])
  const [bestFile, setBestFile] = useState<string>('')
  const [isHighConfidence, setIsHighConfidence] = useState(false)
  const [screenDesc, setScreenDesc] = useState('')
  const [analyzedTree, setAnalyzedTree] = useState<DependencyNode | null>(null)
  const [bundledContext, setBundledContext] = useState('')
  const [isAnalyzingTree, setIsAnalyzingTree] = useState(false)

  const analyzeFile = useCallback(async (relativeFile: string) => {
    if (!projectRoot || !relativeFile) return
    setIsAnalyzingTree(true)
    setAnalyzedTree(null)
    setBundledContext('')
    try {
      const { joinPath } = await import('@janhq/core')
      const absPath = relativeFile.startsWith('/')
        ? relativeFile
        : await joinPath([projectRoot, relativeFile])

      // Set in store so the main Project Mode panel reflects the selection
      setEntryFile(absPath)

      const { analyzeProject } = await import('@/services/pm/project-analyzer')
      const { bundleContext } = await import('@/services/pm/context-bundler')

      const tree = await analyzeProject(projectRoot, absPath)
      const bundled = await bundleContext(tree, projectRoot)

      setAnalyzedTree(tree)
      setBundledContext(bundled)

      // Also trigger full store analysis so main panel has the tree + DNA
      runAnalysis()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsAnalyzingTree(false)
    }
  }, [projectRoot, setEntryFile, runAnalysis])

  const processImage = useCallback(async (file: File) => {
    setError(null)
    setExtractedWords([])
    setScores([])
    setBestFile('')
    setAnalyzedTree(null)
    setBundledContext('')

    // Preview
    const reader = new FileReader()
    reader.onload = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)

    // Convert to base64
    const arrayBuffer = await file.arrayBuffer()
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    )

    setIsAnalyzing(true)

    try {
      // Step 1: Extract visible text
      const result = await extractVisibleText(base64, file.type, visionModelId || undefined)
      setExtractedWords(result.rawWords)
      setScreenDesc(result.screenDescription)

      // Step 2: Score files if project is loaded
      if (projectRoot && result.rawWords.length > 0) {
        // Get all project files
        const { fs } = await import('@janhq/core')
        const allFiles = await collectProjectFiles(projectRoot, fs)

        const fileScores = await scoreFilesByContent(allFiles, projectRoot, result.rawWords)
        setScores(fileScores)

        const confidence = evaluateConfidence(fileScores)
        setBestFile(confidence.bestFile)
        setIsHighConfidence(confidence.isHighConfidence)

        // Step 3: Auto-analyze on high confidence (like PromptMaster C# app)
        if (confidence.isHighConfidence && confidence.bestFile) {
          setIsAnalyzing(false)
          await analyzeFile(confidence.bestFile)
          return
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsAnalyzing(false)
    }
  }, [projectRoot, visionModelId, analyzeFile])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)

    const file = e.dataTransfer.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    if (!visionModelId) {
      setError('No vision model selected. Download or select a vision-capable model first.')
      return
    }

    await processImage(file)
  }, [processImage, visionModelId])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    if (!visionModelId) {
      setError('No vision model selected. Download or select a vision-capable model first.')
      return
    }
    await processImage(file)
  }, [processImage, visionModelId])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: route.projectMode.index })}
          >
            <IconArrowLeft size={16} />
          </Button>
          <h1 className="text-lg font-semibold">{t('common:vision')}</h1>
          {projectRoot && (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {projectRoot.split('/').pop()}
            </span>
          )}
        </div>

        {visionModels.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 max-w-[420px]"
              >
                <span className="truncate font-mono text-xs">
                  {selectedVisionModelLabel || 'Select vision model'}
                </span>
                <IconChevronDown size={14} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-96">
              {visionModels.map((item) => (
                <DropdownMenuItem
                  key={`${item.provider}:${item.model.id}`}
                  className={cn(
                    'cursor-pointer my-0.5 flex items-center justify-between gap-3',
                    visionModelId === item.model.id && 'bg-secondary-foreground/8'
                  )}
                  onClick={() => setVisionModelId(item.model.id)}
                >
                  <span className="truncate font-mono text-xs">
                    {item.model.displayName || item.model.name || item.model.id}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {item.provider}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate({ to: route.hub.index })}
          >
            Download a vision model
          </Button>
        )}
      </div>

      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        {/* Left: drop zone + preview */}
        <div className="flex w-1/2 flex-col">
          <div
            className={`flex-1 rounded-lg border-2 border-dashed transition-colors ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/30'
            } flex flex-col items-center justify-center`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            {imagePreview ? (
              <img
                src={imagePreview}
                alt="Screenshot"
                className="max-h-full max-w-full rounded object-contain p-4"
              />
            ) : (
              <div className="text-center">
                <IconCamera size={48} className="mx-auto mb-4 text-muted-foreground/30" />
                <p className="text-sm font-medium">Drop screenshot here</p>
                <p className="mt-1 text-xs text-muted-foreground">or</p>
                <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent">
                  <IconUpload size={14} />
                  Browse
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </label>
              </div>
            )}
          </div>

          {isAnalyzing && (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <div className="size-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
              Analyzing screenshot...
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Right: results */}
        <VisionResultPanel
          screenDescription={screenDesc}
          bestFile={bestFile}
          isHighConfidence={isHighConfidence}
          scores={scores}
          extractedWords={extractedWords}
          analyzedTree={analyzedTree}
          bundledContext={bundledContext}
          isAnalyzingTree={isAnalyzingTree}
          onAnalyzeFile={analyzeFile}
        />
      </div>
    </div>
  )
}

/** Collect all code files recursively from a project root */
async function collectProjectFiles(root: string, fsModule: typeof import('@janhq/core').fs): Promise<string[]> {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.expo', '__pycache__', 'obj', 'bin'])
  const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.cs', '.py', '.vue', '.svelte'])
  const files: string[] = []

  const normalizeSeparators = (path: string) => path.replace(/\\/g, '/')
  const baseName = (path: string) => normalizeSeparators(path).split('/').pop() || path
  const toRelative = (path: string) => {
    let rel = path.startsWith(root) ? path.slice(root.length) : path
    rel = rel.replace(/^[\\/]/, '')
    rel = normalizeSeparators(rel)
    return rel
  }

  async function walk(dir: string) {
    try {
      const entries = (await fsModule.readdirSync(dir)) as unknown
      if (!Array.isArray(entries)) return

      for (const entry of entries) {
        if (typeof entry !== 'string') continue
        const name = baseName(entry)
        if (!name || SKIP.has(name)) continue

        const info = await fsModule.fileStat(entry)

        if (info?.isDirectory) {
          await walk(entry)
        } else {
          const lastDot = name.lastIndexOf('.')
          const ext = lastDot >= 0 ? name.slice(lastDot) : ''
          if (CODE_EXT.has(ext)) {
            files.push(toRelative(entry))
          }
        }
      }
    } catch { /* skip */ }
  }

  await walk(root)
  return files
}
