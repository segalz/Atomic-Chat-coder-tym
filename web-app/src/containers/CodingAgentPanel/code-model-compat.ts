export interface OllamaModelCapabilities {
  name: string
  capabilities: string[]
}

export type ModelCapabilitiesByName = Record<string, string[]>

const CODE_AGENT_INCOMPATIBLE_MODEL_PREFIXES = [
  'deepseek-r1',
  'deepseek-coder-v2',
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

function modelFamily(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/:latest$/, '')
  return normalized.split('/').pop() ?? normalized
}

function hasStaticIncompatibility(model: string): boolean {
  const family = modelFamily(model)
  return CODE_AGENT_INCOMPATIBLE_MODEL_PREFIXES.some((prefix) => family.startsWith(prefix))
}

function findCapabilities(
  model: string,
  capabilitiesByModel?: ModelCapabilitiesByName
): string[] | undefined {
  const trimmed = model.trim()
  if (!trimmed || !capabilitiesByModel) return undefined

  if (capabilitiesByModel[trimmed]) return capabilitiesByModel[trimmed]
  if (trimmed.endsWith(':latest')) {
    const withoutLatest = trimmed.replace(/:latest$/, '')
    if (capabilitiesByModel[withoutLatest]) return capabilitiesByModel[withoutLatest]
  }
  if (!trimmed.includes(':')) {
    const match = Object.entries(capabilitiesByModel).find(([installed]) =>
      installed === trimmed || installed.startsWith(`${trimmed}:`)
    )
    return match?.[1]
  }

  return undefined
}

export function buildModelCapabilitiesByName(
  modelCapabilities: OllamaModelCapabilities[]
): ModelCapabilitiesByName {
  return Object.fromEntries(
    modelCapabilities
      .map((model) => [model.name.trim(), model.capabilities] as const)
      .filter(([name]) => Boolean(name))
  )
}

export function isCodeAgentToolCompatible(
  model: string,
  capabilitiesByModel?: ModelCapabilitiesByName
): boolean {
  if (hasStaticIncompatibility(model)) return false

  const capabilities = findCapabilities(model, capabilitiesByModel)
  if (capabilities) return capabilities.includes('tools')

  return true
}
