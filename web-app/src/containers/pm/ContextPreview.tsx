import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fs } from '@janhq/core'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { IconCopy, IconCheck, IconDownload } from '@tabler/icons-react'

interface ContextPreviewProps {
  context: string
}

export function ContextPreview({ context }: ContextPreviewProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(context)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleExport = async () => {
    try {
      const path = await invoke<string | null>('save_dialog', {
        options: {
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          defaultPath: 'project-context.md',
        },
      })
      if (path) {
        await fs.writeFileSync(path, context)
      }
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  const tokenEstimate = estimateTokens(context)

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          ~{tokenEstimate.toLocaleString()} tokens | {context.length.toLocaleString()} chars
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? t('common:copied') : t('common:copy')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <IconDownload size={14} />
            {t('common:exportContext')}
          </Button>
        </div>
      </div>

      {/* Preview */}
      <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
        {context}
      </pre>
    </div>
  )
}

function estimateTokens(text: string): number {
  let hebrewChars = 0
  let otherChars = 0
  for (const ch of text) {
    if (/[\u0590-\u05FF]/.test(ch)) hebrewChars++
    else otherChars++
  }
  return Math.ceil(hebrewChars / 2 + otherChars / 4)
}
