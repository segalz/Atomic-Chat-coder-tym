import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { usePlanStore } from '@/stores/plan-store'
import { useProjectModeStore } from '@/stores/project-mode-store'
import { PlanResultView } from './PlanResultView'
import { route } from '@/constants/routes'
import {
  IconArrowLeft,
  IconSend,
  IconCode,
  IconEye,
  IconEyeOff,
  IconX,
  IconChevronDown,
} from '@tabler/icons-react'
import { createImageAttachment } from '@/types/attachment'
import type { Attachment } from '@/types/attachment'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export function PlanComposer() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const {
    userQuery,
    planResult,
    composedUserMessage,
    isGenerating,
    error,
    setUserQuery,
    composeAndPreview,
    setPlanResult,
    setIsGenerating,
    setError,
  } = usePlanStore()

  const { projectRoot, dependencyTree, projectDna } = useProjectModeStore()
  const { providers, selectedModel, selectModelProvider } = useModelProvider()

  const [showPreview, setShowPreview] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const MAX_IMAGES = 3
  const MAX_SIZE = 10 * 1024 * 1024
  const ALLOWED_TYPES = ['image/jpg', 'image/jpeg', 'image/png']

  const availableModels = useMemo(() => {
    const llamacppProvider = providers.find((p) => p.provider === 'llamacpp')
    return llamacppProvider?.models || []
  }, [providers])

  const selectedModelLabel =
    selectedModel?.displayName || selectedModel?.name || selectedModel?.id || ''

  const [showModelSelector, setShowModelSelector] = useState(false)

  const processImageFiles = useCallback(async (files: File[]) => {
    const validFiles: File[] = []
    const maxFiles = MAX_IMAGES - attachments.length

    for (let i = 0; i < files.length; i++) {
      if (i >= maxFiles) break

      const file = files[i]
      const detectedType = file.type
      if (
        !ALLOWED_TYPES.includes(detectedType) ||
        file.size > MAX_SIZE
      ) {
        continue
      }

      validFiles.push(file)
    }

    if (validFiles.length === 0) return

    const preparedFiles: Attachment[] = []
    for (const file of validFiles) {
      const reader = new FileReader()
      await new Promise<void>((resolve) => {
        reader.onload = () => {
          const result = reader.result
          if (typeof result === 'string') {
            const base64String = result.split(',')[1]
            const att = createImageAttachment({
              name: file.name,
              size: file.size,
              mimeType: file.type,
              base64: base64String,
              dataUrl: result,
            })
            preparedFiles.push(att)
          }
          resolve()
        }
        reader.readAsDataURL(file)
      })
    }

    setAttachments((prev) => [...prev, ...preparedFiles])
  }, [attachments.length])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        processImageFiles(Array.from(files))
      }
    },
    [processImageFiles]
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        processImageFiles(Array.from(files))
      }
      e.target.value = ''
    },
    [processImageFiles]
  )

  // Update preview when query changes
  useEffect(() => {
    if (userQuery.trim()) {
      composeAndPreview()
    }
  }, [userQuery, dependencyTree, projectDna, composeAndPreview])

  const handleGeneratePlan = async () => {
    if (!userQuery.trim()) return

    setIsGenerating(true)
    setError(null)
    composeAndPreview()

    try {
      // Use Atomic Chat's inference by creating a message through the chat system.
      // For now, we compose the prompt and the user can copy it to use with any model.
      // Full integration with the inference pipeline will be added in a future iteration.
      //
      // The composed prompt is available in `composedUserMessage` and can be:
      // 1. Copied to clipboard and pasted into the chat
      // 2. Sent to the local API server programmatically
      // 3. Sent to any OpenAI-compatible endpoint

      // For the initial version, we'll use a direct fetch to the local API server
      const response = await fetch('http://localhost:1337/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: usePlanStore.getState().systemPrompt },
            { role: 'user', content: composedUserMessage },
          ],
          temperature: 0.3,
          max_tokens: 16384,
          stream: false,
        }),
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const result = data.choices?.[0]?.message?.content || 'No response received'
      setPlanResult(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const lowerMsg = msg.toLowerCase()
      if (lowerMsg.includes('fetch') || lowerMsg.includes('failed') || msg.includes('ECONNREFUSED')) {
        setError(
          'Could not connect to the local API server. Make sure a model is loaded and the server is running (Settings → Local API Server).'
        )
      } else {
        setError(msg)
      }
    }
  }

  const handleCopyPrompt = async () => {
    composeAndPreview()
    const fullPrompt = `${usePlanStore.getState().systemPrompt}\n\n---\n\n${composedUserMessage}`
    await navigator.clipboard.writeText(fullPrompt)
  }

  const hasContext = !!dependencyTree || !!projectDna

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-6 py-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: route.projectMode.index })}
        >
          <IconArrowLeft size={16} />
        </Button>
        <h1 className="text-lg font-semibold">{t('common:planByAi')}</h1>
        {projectRoot && (
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {projectRoot.split('/').pop()}
          </span>
        )}
      </div>

      {/* Context indicator */}
      {hasContext && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <IconCode size={14} />
            <span>
              {projectDna ? projectDna.techStack.join(', ') : 'No DNA'} |{' '}
              {dependencyTree ? 'Tree loaded' : 'No tree'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground">Model:</span>
            {availableModels.length > 0 ? (
              <DropdownMenu open={showModelSelector} onOpenChange={setShowModelSelector}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 max-w-[420px]"
                  >
                    <span className="truncate font-mono text-xs">
                      {selectedModelLabel || 'Select model'}
                    </span>
                    <IconChevronDown size={14} className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-96">
                  {availableModels.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      className={cn(
                        'cursor-pointer my-0.5 flex items-center justify-between gap-3',
                        selectedModel?.id === model.id && 'bg-secondary-foreground/8'
                      )}
                      onClick={() => {
                        selectModelProvider('llamacpp', model.id)
                        setShowModelSelector(false)
                      }}
                    >
                      <span className="truncate font-mono text-xs">
                        {model.displayName || model.name || model.id}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        llamacpp
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
                Download a model
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Plan result area */}
        {planResult ? (
          <PlanResultView />
        ) : (
          <div className="flex flex-1 flex-col overflow-auto p-6">
            {/* Image attachments */}
            {attachments.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {attachments.map((att, index) => (
                  <div
                    key={`${att.name}-${index}`}
                    className="relative size-24 rounded-lg border bg-muted overflow-hidden"
                  >
                    {att.dataUrl && (
                      <img
                        src={att.dataUrl}
                        alt={att.name}
                        className="size-full object-cover"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      className="absolute right-0 top-0 size-5 bg-destructive text-destructive-foreground rounded-bl-md flex items-center justify-center hover:opacity-80"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Query input */}
            <div className="mb-4">
              <label className="mb-2 block text-sm font-medium">
                {t('common:planByAi')} - Describe what you want to build
              </label>
              
              <div
                className={`relative rounded-lg border-2 border-dashed transition-colors ${
                  isDragging
                    ? 'border-primary bg-primary/5'
                    : 'border-muted hover:border-muted-foreground/30'
                }`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  max={MAX_IMAGES}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  onChange={handleFileInput}
                  disabled={attachments.length >= MAX_IMAGES}
                />
                <textarea
                  dir="auto"
                  className="w-full rounded-lg border-0 bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  rows={5}
                  placeholder={`Drop images here or click to upload (${attachments.length}/${MAX_IMAGES} max) + Describe what you want to build...`}
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                />
              </div>
              
              <p className="mt-2 text-xs text-muted-foreground">
                support: jpg, jpeg, png (max 10MB each, {MAX_IMAGES} images max)
              </p>
            </div>

            {/* Enriched prompt preview */}
            {composedUserMessage && (
              <div className="mb-4">
                <button
                  className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  {showPreview ? 'Hide' : 'Show'} enriched prompt ({composedUserMessage.length.toLocaleString()} chars)
                </button>
                {showPreview && (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                    {composedUserMessage}
                  </pre>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* No context warning */}
            {!hasContext && (
              <div className="mb-4 rounded-md bg-yellow-500/10 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-400">
                No project context loaded. Go to{' '}
                <button
                  className="underline"
                  onClick={() => navigate({ to: route.projectMode.index })}
                >
                  Project Mode
                </button>{' '}
                to analyze a folder first for better results.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      {!planResult && (
        <div className="flex items-center justify-between border-t px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyPrompt}
            disabled={!userQuery.trim()}
          >
            Copy Prompt
          </Button>
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleGeneratePlan}
              disabled={!userQuery.trim() || isGenerating}
              className="gap-2"
            >
              <IconSend size={14} />
              {isGenerating ? t('common:thinking') : t('common:generatePlan')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
