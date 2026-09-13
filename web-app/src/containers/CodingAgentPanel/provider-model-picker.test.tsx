import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  ProviderModelPicker,
  type ClineInstallStatus,
} from './ProviderModelPicker'
import {
  CODING_AGENT_BACKEND_STORAGE_KEY,
  CLINE_DEFAULT_MODEL_ID,
  CLINE_FREE_MODELS,
} from './backend-identity'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

describe('ProviderModelPicker (Stage 10)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'fetch_cline_cli_models') {
        return {
          models: CLINE_FREE_MODELS,
          source: 'test_mock',
        }
      }
      return {
        installed: true,
        path: 'C:\\Users\\user\\AppData\\Roaming\\npm\\cline.cmd',
        version: '3.0.61',
      } satisfies ClineInstallStatus
    })
  })

  it('renders provider tabs and indicates active tab', async () => {
    await act(async () => {
      render(
        <ProviderModelPicker
          backend="direct-ollama"
          onBackendChange={vi.fn()}
          selectedModel="qwen3-coder:30b"
          onModelChange={vi.fn()}
        >
          <div data-testid="ollama-slot">Ollama Slot</div>
        </ProviderModelPicker>
      )
    })

    const ollamaTab = screen.getByRole('tab', { name: 'Ollama' })
    const clineTab = screen.getByRole('tab', { name: 'Cline ACP' })

    expect(ollamaTab).toBeInTheDocument()
    expect(clineTab).toBeInTheDocument()
    expect(ollamaTab).toHaveAttribute('aria-selected', 'true')
    expect(clineTab).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('ollama-slot')).toBeInTheDocument()
  })

  it('switches from direct-ollama to cline-acp on tab click and persists selection', async () => {
    const onBackendChange = vi.fn()
    const onModelChange = vi.fn()

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="direct-ollama"
          onBackendChange={onBackendChange}
          selectedModel="qwen3-coder:30b"
          onModelChange={onModelChange}
        />
      )
    })

    const clineTab = screen.getByRole('tab', { name: 'Cline ACP' })
    await act(async () => {
      fireEvent.click(clineTab)
    })

    expect(onBackendChange).toHaveBeenCalledWith('cline-acp')
    expect(onModelChange).toHaveBeenCalledWith(CLINE_DEFAULT_MODEL_ID)
    expect(localStorage.getItem(CODING_AGENT_BACKEND_STORAGE_KEY)).toBe('cline-acp')
  })

  it('switches from cline-acp to direct-ollama on tab click and persists selection', async () => {
    const onBackendChange = vi.fn()
    const onModelChange = vi.fn()

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={onBackendChange}
          selectedModel={CLINE_DEFAULT_MODEL_ID}
          onModelChange={onModelChange}
        />
      )
    })

    const ollamaTab = screen.getByRole('tab', { name: 'Ollama' })
    await act(async () => {
      fireEvent.click(ollamaTab)
    })

    expect(onBackendChange).toHaveBeenCalledWith('direct-ollama')
    expect(localStorage.getItem(CODING_AGENT_BACKEND_STORAGE_KEY)).toBe('direct-ollama')
  })

  it('displays real host status when Cline is installed', async () => {
    mockedInvoke.mockResolvedValueOnce({
      installed: true,
      path: 'C:\\bin\\cline.cmd',
      version: '3.0.61',
    } satisfies ClineInstallStatus)

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_DEFAULT_MODEL_ID}
          onModelChange={vi.fn()}
        />
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Cline CLI detected')).toBeInTheDocument()
      expect(screen.getByText('v3.0.61')).toBeInTheDocument()
    })
  })

  it('displays missing status when Cline is not installed on host', async () => {
    mockedInvoke.mockResolvedValueOnce({
      installed: false,
      path: null,
      version: null,
    } satisfies ClineInstallStatus)

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_DEFAULT_MODEL_ID}
          onModelChange={vi.fn()}
        />
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Cline CLI not detected on PATH')).toBeInTheDocument()
      expect(screen.queryByText(/v3\./)).not.toBeInTheDocument()
    })
  })

  it('renders the cline free models dropdown and active model description without fake pricing or fake downloads', async () => {
    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_FREE_MODELS[0].id}
          onModelChange={vi.fn()}
        />
      )
    })

    const select = screen.getByRole('combobox', { name: 'Cline free model' })
    expect(select).toBeInTheDocument()

    for (const model of CLINE_FREE_MODELS) {
      const label = `${model.name} (${model.provider})${model.tag ? ' • ' + model.tag : ''}`
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument()
    }

    expect(screen.getByText(CLINE_FREE_MODELS[0].description)).toBeInTheDocument()

    // Capability badges
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Streaming')).toBeInTheDocument()
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.getByText('Permissions')).toBeInTheDocument()

    // Verify NO fake token pricing or fake installation download buttons
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/price|pricing|\$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/pull model|download model/i)).not.toBeInTheDocument()
  })

  it('emits the selected model id when a free model is picked from the dropdown', async () => {
    const onModelChange = vi.fn()

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_FREE_MODELS[0].id}
          onModelChange={onModelChange}
        />
      )
    })

    const select = screen.getByRole('combobox', { name: 'Cline free model' })
    await act(async () => {
      fireEvent.change(select, { target: { value: CLINE_FREE_MODELS[1].id } })
    })

    expect(onModelChange).toHaveBeenCalledWith(CLINE_FREE_MODELS[1].id)
  })

  it('re-probes host status when refresh button is clicked', async () => {
    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_DEFAULT_MODEL_ID}
          onModelChange={vi.fn()}
        />
      )
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('check_cline_installed')
    })

    const refreshBtn = screen.getByRole('button', { name: 'Refresh Cline CLI status' })
    await act(async () => {
      fireEvent.click(refreshBtn)
    })

    const checkCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'check_cline_installed')
    const fetchCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'fetch_cline_cli_models')
    expect(checkCalls.length).toBe(2)
    expect(fetchCalls.length).toBe(2)
  })

  it('renders dynamically fetched models from Cline CLI in the dropdown', async () => {
    const customDynamicModels = [
      {
        id: 'test/dynamic-model-1',
        name: 'Dynamic Model 1',
        provider: 'TestProvider',
        description: 'Dynamically discovered model from CLI',
        tag: 'TestTag',
      },
      {
        id: 'test/dynamic-model-2',
        name: 'Dynamic Model 2',
        provider: 'AnotherProvider',
        description: 'Second dynamic model from CLI',
      },
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'fetch_cline_cli_models') {
        return {
          models: customDynamicModels,
          source: 'test_live_cli',
        }
      }
      return {
        installed: true,
        path: 'C:\\Users\\user\\AppData\\Roaming\\npm\\cline.cmd',
        version: '3.0.61',
      } satisfies ClineInstallStatus
    })

    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel="test/dynamic-model-1"
          onModelChange={vi.fn()}
        />
      )
    })

    await waitFor(() => {
      expect(screen.getByText(/Dynamic Model 1/)).toBeInTheDocument()
      expect(screen.getByText(/Dynamic Model 2/)).toBeInTheDocument()
    })
  })

  it('respects disabled prop on tabs and refresh button', async () => {
    await act(async () => {
      render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_DEFAULT_MODEL_ID}
          onModelChange={vi.fn()}
          disabled={true}
        />
      )
    })

    expect(screen.getByRole('tab', { name: 'Ollama' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Cline ACP' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh Cline CLI status' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Cline free model' })).toBeDisabled()
  })

  it('renders static display card when showSelector is false and updates on selectedModel change', async () => {
    let renderResult: any
    await act(async () => {
      renderResult = render(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_FREE_MODELS[0].id}
          onModelChange={vi.fn()}
          showSelector={false}
        />
      )
    })

    // Verify combobox is not rendered
    expect(screen.queryByRole('combobox', { name: 'Cline free model' })).not.toBeInTheDocument()

    // Verify static display card is rendered with model name
    const display = screen.getByTestId('target-model-display')
    expect(display).toBeInTheDocument()
    expect(display).toHaveTextContent(CLINE_FREE_MODELS[0].name)
    expect(screen.getByText(CLINE_FREE_MODELS[0].description)).toBeInTheDocument()

    // Rerender with different model
    await act(async () => {
      renderResult.rerender(
        <ProviderModelPicker
          backend="cline-acp"
          onBackendChange={vi.fn()}
          selectedModel={CLINE_FREE_MODELS[1].id}
          onModelChange={vi.fn()}
          showSelector={false}
        />
      )
    })

    expect(screen.getByTestId('target-model-display')).toHaveTextContent(CLINE_FREE_MODELS[1].name)
    expect(screen.getByText(CLINE_FREE_MODELS[1].description)).toBeInTheDocument()
  })
})

