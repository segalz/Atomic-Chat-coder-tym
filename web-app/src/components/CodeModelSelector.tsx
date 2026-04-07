import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { IconRefresh } from '@tabler/icons-react'

interface CodeModelSelectorProps {
  value: string | null
  onChange: (model: string) => void
  disabled?: boolean
}

export function CodeModelSelector({ value, onChange, disabled }: CodeModelSelectorProps) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadModels = async () => {
    setLoading(true)
    setError(null)
    try {
      const modelList = await invoke<string[]>('list_ollama_models')
      setModels(modelList)
      
      // Auto-select first model if none selected
      if (!value && modelList.length > 0) {
        onChange(modelList[0])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      console.error('[CodeModelSelector] Failed to list ollama models:', err)
    } finally {
      setLoading(false)
    }
  }

  // Load models on mount
  useEffect(() => {
    void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex items-center gap-2">
      <Select value={value || ''} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Select model..." />
        </SelectTrigger>
        <SelectContent>
          {models.length === 0 ? (
            <SelectItem value="" disabled>
              {loading ? 'Loading...' : error ? 'Error loading models' : 'No models available'}
            </SelectItem>
          ) : (
            models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="icon-sm"
        onClick={loadModels}
        disabled={loading || disabled}
        title="Refresh models"
      >
        <IconRefresh size={16} />
      </Button>

      {error && (
        <span className="text-xs text-destructive" title={error}>
          ⚠️
        </span>
      )}
    </div>
  )
}
