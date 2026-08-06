import { describe, expect, it } from 'vitest'
import { buildModelCapabilitiesByName, isCodeAgentToolCompatible } from './code-model-compat'

describe('code model compatibility', () => {
  it('allows MLX models when Ollama reports tool support', () => {
    const capabilities = buildModelCapabilitiesByName([
      { name: 'gemma4:12b-mlx', capabilities: ['completion', 'tools', 'thinking'] },
    ])

    expect(isCodeAgentToolCompatible('gemma4:12b-mlx', capabilities)).toBe(true)
  })

  it('blocks models when Ollama reports no tool support', () => {
    const capabilities = buildModelCapabilitiesByName([
      { name: 'some-model:latest', capabilities: ['completion'] },
    ])

    expect(isCodeAgentToolCompatible('some-model:latest', capabilities)).toBe(false)
  })

  it('keeps known incompatible model families blocked without metadata', () => {
    expect(isCodeAgentToolCompatible('deepseek-coder-v2:16b')).toBe(false)
  })

  it('keeps existing permissive fallback for unknown installed model metadata', () => {
    expect(isCodeAgentToolCompatible('qwen3-coder:30b')).toBe(true)
  })
})
