import { useState, useEffect } from 'react'
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
} from '@tabler/icons-react'

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

  const [showPreview, setShowPreview] = useState(false)

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
        <div className="flex items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs text-muted-foreground">
          <IconCode size={14} />
          <span>
            Context: {projectDna ? projectDna.techStack.join(', ') : 'No DNA'} |{' '}
            {dependencyTree ? 'Tree loaded' : 'No tree'}
          </span>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Plan result area */}
        {planResult ? (
          <PlanResultView />
        ) : (
          <div className="flex flex-1 flex-col overflow-auto p-6">
            {/* Query input */}
            <div className="mb-4">
              <label className="mb-2 block text-sm font-medium">
                {t('common:planByAi')} - Describe what you want to build
              </label>
              <textarea
                dir="auto"
                className="w-full rounded-lg border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                rows={5}
                placeholder="e.g., Add a settings screen with dark mode toggle and language selector..."
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
              />
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
