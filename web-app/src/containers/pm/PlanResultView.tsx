import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fs } from '@janhq/core'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { usePlanStore } from '@/stores/plan-store'
import {
  IconCopy,
  IconCheck,
  IconDownload,
  IconArrowBack,
} from '@tabler/icons-react'

export function PlanResultView() {
  const { t } = useTranslation()
  const { planResult, userQuery, exportToMarkdown, clear } = usePlanStore()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(planResult)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleExport = async () => {
    try {
      const markdown = await exportToMarkdown()
      const path = await invoke<string | null>('save_dialog', {
        options: {
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          defaultPath: `plan_${Date.now()}.md`,
        },
      })
      if (path) {
        await fs.writeFileSync(path, markdown)
      }
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-6 py-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={clear} className="gap-1.5">
            <IconArrowBack size={14} />
            New Plan
          </Button>
          <span className="text-xs text-muted-foreground">
            {planResult.length.toLocaleString()} chars
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? t('common:copied') : t('common:copy')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <IconDownload size={14} />
            {t('common:exportPlan')}
          </Button>
        </div>
      </div>

      {/* Query reminder */}
      {userQuery && (
        <div className="border-b bg-muted/20 px-6 py-2">
          <p className="text-xs text-muted-foreground" dir="auto">
            <strong>Request:</strong> {userQuery.length > 200 ? userQuery.slice(0, 200) + '...' : userQuery}
          </p>
        </div>
      )}

      {/* Plan content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="prose prose-sm dark:prose-invert max-w-none" dir="auto">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
            {planResult}
          </pre>
        </div>
      </div>
    </div>
  )
}
