import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconRefresh, IconCpu, IconSparkles, IconBulb } from '@tabler/icons-react'
import {
  CodingAgentBackend,
  CLINE_ACP_BACKEND,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_FREE_MODELS,
  type ClineFreeModel,
  getBackendCapabilities,
  persistCodingAgentBackend,
  fetchClineCliModels,
  getCachedClineModels,
} from './backend-identity'
import './ProviderModelPicker.css'

export interface ClineInstallStatus {
  installed: boolean
  path?: string | null
  version?: string | null
}

export interface ProviderModelPickerProps {
  backend: CodingAgentBackend
  onBackendChange: (backend: CodingAgentBackend) => void
  selectedModel: string
  onModelChange: (model: string) => void
  disabled?: boolean
  children?: React.ReactNode
}

export function ProviderModelPicker({
  backend,
  onBackendChange,
  selectedModel,
  onModelChange,
  disabled = false,
  children,
}: ProviderModelPickerProps) {
  const [status, setStatus] = useState<ClineInstallStatus | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [models, setModels] = useState<ClineFreeModel[]>(() => getCachedClineModels())
  const [isLoadingModels, setIsLoadingModels] = useState(false)

  const checkInstall = useCallback(async () => {
    setIsChecking(true)
    try {
      const result = await invoke<ClineInstallStatus>('check_cline_installed')
      setStatus(result)
    } catch {
      setStatus({ installed: false, path: null, version: null })
    } finally {
      setIsChecking(false)
    }
  }, [])

  const loadModels = useCallback(async () => {
    setIsLoadingModels(true)
    try {
      const liveModels = await fetchClineCliModels()
      if (liveModels && liveModels.length > 0) {
        setModels(liveModels)
      }
    } catch (err) {
      console.warn('Failed to load live models from Cline CLI:', err)
    } finally {
      setIsLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void checkInstall()
    if (backend === CLINE_ACP_BACKEND) {
      void loadModels()
    }
  }, [checkInstall, loadModels, backend])

  const handleTabClick = (next: CodingAgentBackend) => {
    if (disabled || next === backend) return
    onBackendChange(next)
    persistCodingAgentBackend(next)
    if (next === CLINE_ACP_BACKEND) {
      onModelChange(CLINE_DEFAULT_MODEL_ID)
    }
  }

  const capabilities = getBackendCapabilities(CLINE_ACP_BACKEND)

  // Resolve active model from the dynamically loaded models (or fallback).
  const activeModel: ClineFreeModel =
    models.find((m) => m.id === selectedModel) ?? models[0] ?? CLINE_FREE_MODELS[0]

  return (
    <div className="provider-model-picker">
      <div className="provider-model-picker__title">Backend Provider</div>
      <div className="provider-model-picker__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={backend === 'direct-ollama'}
          className={`provider-model-picker__tab${backend === 'direct-ollama' ? ' provider-model-picker__tab--active' : ''}`}
          disabled={disabled}
          onClick={() => handleTabClick('direct-ollama')}
        >
          Ollama
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={backend === CLINE_ACP_BACKEND}
          className={`provider-model-picker__tab${backend === CLINE_ACP_BACKEND ? ' provider-model-picker__tab--active' : ''}`}
          disabled={disabled}
          onClick={() => handleTabClick(CLINE_ACP_BACKEND)}
        >
          Cline ACP
        </button>
      </div>

      <div className="provider-model-picker__content">
        {backend === CLINE_ACP_BACKEND ? (
          <>
            <div className="provider-model-picker__status">
              <span
                className={`provider-model-picker__status-dot ${
                  status?.installed
                    ? 'provider-model-picker__status-dot--installed'
                    : 'provider-model-picker__status-dot--missing'
                }`}
              />
              <span className="provider-model-picker__status-text">
                {status?.installed ? 'Cline CLI detected' : 'Cline CLI not detected on PATH'}
              </span>
              {status?.installed && status?.version ? (
                <span className="provider-model-picker__status-badge">v{status.version}</span>
              ) : null}
              <button
                type="button"
                className="provider-model-picker__refresh"
                disabled={disabled || isChecking || isLoadingModels}
                aria-label="Refresh Cline CLI status"
                onClick={() => {
                  void checkInstall()
                  void loadModels()
                }}
              >
                <IconRefresh size={12} stroke={1.5} />
              </button>
            </div>

            <div className="provider-model-picker__model-box bg-[#151a24] border border-[#232c3d] rounded-xl p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold tracking-wider uppercase text-slate-400">Target Model</span>
                <span className="text-[9px] font-mono px-1.5 py-0.5 bg-emerald-950/80 text-emerald-400 border border-emerald-800/40 rounded">
                  Connected
                </span>
              </div>
              <select
                className="provider-model-picker__select w-full rounded-lg border border-[#273244] bg-[#0e121a] px-3 py-2 text-xs font-medium text-slate-100 shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                value={activeModel.id}
                aria-label="Cline free model"
                disabled={disabled}
                onChange={(e) => onModelChange(e.target.value)}
              >
                {models.map((m: ClineFreeModel) => (
                  <option key={m.id} value={m.id} className="bg-[#0e121a] text-slate-100">
                    {`${m.name} (${m.provider})${m.tag ? ' • ' + m.tag : ''}`}
                  </option>
                ))}
              </select>
              <div className="provider-model-picker__model-desc text-[11px] text-slate-400 leading-relaxed">
                {activeModel.description}
              </div>
              <div className="provider-model-picker__capabilities flex flex-wrap gap-1.5 pt-1">
                {capabilities.tools ? (
                  <span className="provider-model-picker__capability inline-flex items-center gap-1 text-[10px] font-mono bg-[#1d2535] text-slate-300 px-2 py-0.5 rounded border border-[#2e3b52]">
                    <IconCpu size={10} className="text-sky-400" /> Tools
                  </span>
                ) : null}
                {capabilities.streaming ? (
                  <span className="provider-model-picker__capability inline-flex items-center gap-1 text-[10px] font-mono bg-[#1d2535] text-slate-300 px-2 py-0.5 rounded border border-[#2e3b52]">
                    <IconSparkles size={10} className="text-purple-400" /> Streaming
                  </span>
                ) : null}
                {capabilities.thinking ? (
                  <span className="provider-model-picker__capability inline-flex items-center gap-1 text-[10px] font-mono bg-[#1d2535] text-slate-300 px-2 py-0.5 rounded border border-[#2e3b52]">
                    <IconBulb size={10} className="text-amber-400" /> Thinking
                  </span>
                ) : null}
                {capabilities.requestPermissions ? (
                  <span className="provider-model-picker__capability inline-flex items-center gap-1 text-[10px] font-mono bg-[#1d2535] text-slate-300 px-2 py-0.5 rounded border border-[#2e3b52]">
                    Permissions
                  </span>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

export default ProviderModelPicker
