import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconRefresh, IconCheck, IconCpu, IconSparkles } from '@tabler/icons-react'
import {
  CodingAgentBackend,
  CLINE_ACP_BACKEND,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_DEFAULT_MODEL_DISPLAY_NAME,
  getBackendCapabilities,
  persistCodingAgentBackend,
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

  useEffect(() => {
    void checkInstall()
  }, [checkInstall])

  const handleTabClick = (next: CodingAgentBackend) => {
    if (disabled || next === backend) return
    onBackendChange(next)
    persistCodingAgentBackend(next)
    if (next === CLINE_ACP_BACKEND) {
      onModelChange(CLINE_DEFAULT_MODEL_ID)
    }
  }

  const capabilities = getBackendCapabilities(CLINE_ACP_BACKEND)

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
                disabled={disabled || isChecking}
                aria-label="Refresh Cline CLI status"
                onClick={() => void checkInstall()}
              >
                <IconRefresh size={12} stroke={1.5} />
              </button>
            </div>

            <div className="provider-model-picker__model-box">
              <div className="provider-model-picker__model-name">
                {CLINE_DEFAULT_MODEL_DISPLAY_NAME} ({CLINE_DEFAULT_MODEL_ID})
                {selectedModel === CLINE_DEFAULT_MODEL_ID ? (
                  <IconCheck size={12} stroke={2} style={{ marginLeft: 4, verticalAlign: '-2px' }} />
                ) : null}
              </div>
              <div className="provider-model-picker__model-desc">Zhipu AI via local Cline ACP</div>
              <div className="provider-model-picker__capabilities">
                {capabilities.tools ? (
                  <span className="provider-model-picker__capability">
                    <IconCpu size={9} stroke={1.5} /> Tools
                  </span>
                ) : null}
                {capabilities.streaming ? (
                  <span className="provider-model-picker__capability">
                    <IconSparkles size={9} stroke={1.5} /> Streaming
                  </span>
                ) : null}
                {capabilities.thinking ? (
                  <span className="provider-model-picker__capability">Thinking</span>
                ) : null}
                {capabilities.requestPermissions ? (
                  <span className="provider-model-picker__capability">Permissions</span>
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
