import {
  IconChevronDown,
  IconCloudDownload,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-react'

import './CodeModelSelector.css'

interface RecommendedCodeModel {
  id: string
  label: string
  size?: string
  note?: string
}

const RECOMMENDED_CODE_MODELS: RecommendedCodeModel[] = [
  { id: 'qwen3-coder-next', label: 'Qwen3-Coder Next', size: '52 GB', note: 'strongest' },
  { id: 'qwen3-coder:30b', label: 'Qwen3-Coder 30B', size: '~20 GB' },
  { id: 'qwen2.5-coder:32b', label: 'Qwen2.5-Coder 32B', size: '20 GB' },
  { id: 'qwen2.5-coder:14b', label: 'Qwen2.5-Coder 14B', size: '9 GB' },
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5-Coder 7B', size: '5 GB', note: 'fast' },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek-Coder V2', size: '9 GB' },
]

const recommendedById = new Map(RECOMMENDED_CODE_MODELS.map((model) => [model.id, model]))

const CODE_AGENT_INCOMPATIBLE_MODEL_PREFIXES = [
  'deepseek-r1',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen2.5vl',
  'llama3.2-vision',
  'granite3.2-vision',
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'minicpm-o',
]

function isCodeAgentToolCompatible(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/:latest$/, '')
  const family = normalized.split('/').pop() ?? normalized
  return !CODE_AGENT_INCOMPATIBLE_MODEL_PREFIXES.some((prefix) => family.startsWith(prefix))
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)))
}

function isOllamaModelInstalled(model: string, installedModels: string[]): boolean {
  const trimmed = model.trim()
  if (!trimmed) return false

  return installedModels.some((installed) => {
    if (installed === trimmed) return true
    if (trimmed.includes(':')) return false
    return installed.startsWith(`${trimmed}:`)
  })
}

function formatModelOption(modelId: string): string {
  const metadata = recommendedById.get(modelId)
  if (!metadata) return modelId

  const details = [modelId, metadata.size, metadata.note].filter(Boolean).join(' | ')
  return `${metadata.label} (${details})`
}

interface CodeModelSelectorProps {
  value: string
  installedModels: string[]
  disabled?: boolean
  isPulling?: boolean
  pullProgress?: string
  onChange: (model: string) => void
  onPull: (model: string) => void
  onRefresh: () => void
}

export function CodeModelSelector({
  value,
  installedModels,
  disabled = false,
  isPulling = false,
  pullProgress,
  onChange,
  onPull,
  onRefresh,
}: CodeModelSelectorProps) {
  const installed = normalizeModels(installedModels)
  const compatibleInstalled = installed.filter(isCodeAgentToolCompatible)
  const incompatibleInstalled = installed.filter((model) => !isCodeAgentToolCompatible(model))
  const recommendedMissing = RECOMMENDED_CODE_MODELS.filter(
    (model) => isCodeAgentToolCompatible(model.id) && !isOllamaModelInstalled(model.id, installed)
  )
  const hasValueInOptions =
    !value ||
    installed.includes(value) ||
    RECOMMENDED_CODE_MODELS.some((model) => model.id === value)
  const selectedInstalled = isOllamaModelInstalled(value, installed)
  const selectedCompatible = isCodeAgentToolCompatible(value)
  const selectedMetadata = recommendedById.get(value)
  const canPull = Boolean(value) && selectedCompatible && !selectedInstalled && !isPulling && !disabled

  return (
    <div className="code-model-selector">
      <div className="code-model-selector__field">
        <select
          className="code-model-selector__select"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label="Code model"
        >
          {!value && <option value="">Select model</option>}
          {compatibleInstalled.length > 0 && (
            <optgroup label="Installed">
              {compatibleInstalled.map((model) => (
                <option key={model} value={model}>
                  {formatModelOption(model)}
                </option>
              ))}
            </optgroup>
          )}
          {recommendedMissing.length > 0 && (
            <optgroup label="Recommended">
              {recommendedMissing.map((model) => (
                <option key={model.id} value={model.id}>
                  {formatModelOption(model.id)}
                </option>
              ))}
            </optgroup>
          )}
          {incompatibleInstalled.length > 0 && (
            <optgroup label="Not compatible">
              {incompatibleInstalled.map((model) => (
                <option key={model} value={model} disabled>
                  {model} (does not support tools)
                </option>
              ))}
            </optgroup>
          )}
          {!hasValueInOptions && (
            <optgroup label="Selected">
              <option value={value} disabled={!selectedCompatible}>
                {selectedCompatible ? value : `${value} (does not support tools)`}
              </option>
            </optgroup>
          )}
        </select>
        <IconChevronDown className="code-model-selector__chevron" size={13} aria-hidden />
      </div>

      <div className="code-model-selector__meta">
        <span
          className={
            selectedInstalled
              ? selectedCompatible
                ? 'code-model-selector__status code-model-selector__status--installed'
                : 'code-model-selector__status code-model-selector__status--incompatible'
              : 'code-model-selector__status code-model-selector__status--missing'
          }
        >
          {!selectedCompatible ? 'Not compatible' : selectedInstalled ? 'Installed' : 'Pull required'}
        </span>
        {!selectedCompatible ? (
          <span className="code-model-selector__detail">Code Agent requires tool support</span>
        ) : (selectedMetadata?.size || selectedMetadata?.note) && (
          <span className="code-model-selector__detail">
            {[selectedMetadata.size, selectedMetadata.note].filter(Boolean).join(' | ')}
          </span>
        )}
        <button
          type="button"
          className="code-model-selector__refresh"
          disabled={disabled}
          onClick={onRefresh}
          aria-label="Refresh Ollama models"
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {selectedCompatible && !selectedInstalled && value && (
        <button
          type="button"
          className="code-model-selector__pull"
          disabled={!canPull}
          onClick={() => onPull(value)}
        >
          {isPulling ? (
            <IconLoader2 size={12} className="animate-spin" />
          ) : (
            <IconCloudDownload size={12} />
          )}
          <span className="code-model-selector__pull-label">
            {isPulling ? (pullProgress ?? 'Pulling model') : `Pull ${value}`}
          </span>
        </button>
      )}
    </div>
  )
}
