import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SwitchAiDialog } from './SwitchAiDialog'
import type { ClineFreeModel } from './backend-identity'

const MOCK_CLINE_MODELS: ClineFreeModel[] = [
  {
    id: 'zai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    provider: 'Zhipu AI',
    description: 'Fast multimodal model',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    description: 'Fast reasoning model',
  },
]

const MOCK_OLLAMA_MODELS = ['qwen2.5-coder:7b', 'deepseek-coder:6.7b']

describe('SwitchAiDialog', () => {
  it('renders current active AI and connection protocols', () => {
    render(
      <SwitchAiDialog
        open={true}
        onOpenChange={vi.fn()}
        currentModelId="zai/glm-5.3-flash"
        currentBackend="cline-acp"
        clineModels={MOCK_CLINE_MODELS}
        ollamaModels={MOCK_OLLAMA_MODELS}
        onSelectAi={vi.fn()}
      />
    )

    expect(screen.getByText('Switch AI / Continue Work Thread')).toBeInTheDocument()
    expect(screen.getByText('Currently Active:')).toBeInTheDocument()
    expect(screen.getByText('GLM 5.3 Flash (Zhipu AI)')).toBeInTheDocument()
    expect(screen.getByText('Cline ACP Cloud / Free')).toBeInTheDocument()
    expect(screen.getByText('Local Ollama')).toBeInTheDocument()
  })

  it('allows selecting another model and confirms handoff in the same Work Thread', () => {
    const onSelectAi = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <SwitchAiDialog
        open={true}
        onOpenChange={onOpenChange}
        currentModelId="zai/glm-5.3-flash"
        currentBackend="cline-acp"
        clineModels={MOCK_CLINE_MODELS}
        ollamaModels={MOCK_OLLAMA_MODELS}
        onSelectAi={onSelectAi}
      />
    )

    // Select DeepSeek
    const deepseekOption = screen.getByText('DeepSeek V4 Flash')
    fireEvent.click(deepseekOption)

    // Confirm button
    const confirmButton = screen.getByRole('button', { name: /Continue with this AI/i })
    fireEvent.click(confirmButton)

    expect(onSelectAi).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
      'cline-acp',
      'DeepSeek V4 Flash',
      'DeepSeek'
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('switches to Ollama protocol and shows local models', () => {
    const onSelectAi = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <SwitchAiDialog
        open={true}
        onOpenChange={onOpenChange}
        currentModelId="zai/glm-5.3-flash"
        currentBackend="cline-acp"
        clineModels={MOCK_CLINE_MODELS}
        ollamaModels={MOCK_OLLAMA_MODELS}
        onSelectAi={onSelectAi}
      />
    )

    // Click Local Ollama tab
    const ollamaTab = screen.getByText('Local Ollama')
    fireEvent.click(ollamaTab)

    expect(screen.getByText('qwen2.5-coder:7b')).toBeInTheDocument()

    // Confirm switch to Ollama model
    const confirmButton = screen.getByRole('button', { name: /Continue with this AI/i })
    fireEvent.click(confirmButton)

    expect(onSelectAi).toHaveBeenCalledWith(
      'qwen2.5-coder:7b',
      'direct-ollama',
      'qwen2.5-coder:7b',
      'Ollama'
    )
  })

  it('closes dialog without calling onSelectAi when Cancel is clicked', () => {
    const onSelectAi = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <SwitchAiDialog
        open={true}
        onOpenChange={onOpenChange}
        currentModelId="zai/glm-5.3-flash"
        currentBackend="cline-acp"
        clineModels={MOCK_CLINE_MODELS}
        ollamaModels={MOCK_OLLAMA_MODELS}
        onSelectAi={onSelectAi}
      />
    )

    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelButton)

    expect(onSelectAi).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('prevents horizontal scrolling and renders long descriptions safely', () => {
    const longDescModels: ClineFreeModel[] = [
      {
        id: 'meta/muse-spark-1.2-contributor',
        name: 'Muse Spark 1.3 Contributor',
        provider: 'Meta',
        description:
          'Meta’s multimodal reasoning model for experimentation, learning, and early-stage agentic, multi-agent, and coding workflows that extends beyond standard limits',
      },
    ]

    render(
      <SwitchAiDialog
        open={true}
        onOpenChange={vi.fn()}
        currentModelId="meta/muse-spark-1.2-contributor"
        currentBackend="cline-acp"
        clineModels={longDescModels}
        ollamaModels={[]}
        onSelectAi={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('overflow-x-hidden')

    const desc = screen.getByText(/Meta’s multimodal reasoning model/)
    expect(desc).toHaveClass('truncate')
  })
})

