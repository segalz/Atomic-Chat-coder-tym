import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconChevronDown } from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface CodeModelSelectorProps {
  value: string
  onChange: (model: string) => void
  availableModels: string[]
  disabled?: boolean
}

// מודלים מומלצים ברירת מחדל
const RECOMMENDED_MODELS = [
  { id: 'qwen3-coder-next',       label: 'Qwen3-Coder-Next',  size: '52GB', note: 'SWE 70.6%' },
  { id: 'qwen3-coder:30b',        label: 'Qwen3-Coder 30B',   size: '~20GB' },
  { id: 'qwen2.5-coder:32b',      label: 'Qwen2.5-Coder 32B', size: '20GB' },
  { id: 'qwen2.5-coder:7b',       label: 'Qwen2.5-Coder 7B',  size: '4.7GB', note: 'מהיר' },
  { id: 'deepseek-coder-v2:16b',  label: 'DeepSeek-Coder V2', size: '9GB' },
]

export function CodeModelSelector({ value, onChange, availableModels, disabled }: CodeModelSelectorProps) {
  const { t } = useTranslation()
  const installed = availableModels
  const recommended = RECOMMENDED_MODELS.filter(m => !installed.includes(m.id))

  const getDisplayLabel = (modelId: string) => {
    const rec = RECOMMENDED_MODELS.find(m => m.id === modelId)
    return rec ? rec.label : modelId
  }

  const triggerLabel = getDisplayLabel(value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="gap-1.5 font-medium"
        >
          {triggerLabel} <IconChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {installed.length > 0 && (
          <>
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{t('code-mode:installed')}</div>
            {installed.map((model) => (
              <DropdownMenuItem
                key={model}
                onClick={() => onChange(model)}
                className="flex items-center justify-between gap-2"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{getDisplayLabel(model)}</span>
                  <span className="text-xs text-muted-foreground">{model}</span>
                </div>
                {model === value && <span>✓</span>}
              </DropdownMenuItem>
            ))}
            {recommended.length > 0 && <DropdownMenuSeparator />}
          </>
        )}

        {recommended.length > 0 && (
          <>
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{t('code-mode:recommendedNotInstalled')}</div>
            {recommended.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onChange(model.id)}
                className="flex items-center justify-between gap-2"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{model.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {model.size} {model.note && `• ${model.note}`}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">ollama pull {model.id}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
