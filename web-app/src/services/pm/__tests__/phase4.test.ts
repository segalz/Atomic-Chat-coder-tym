import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFs, mockPath } = vi.hoisted(() => {
  const mockFs = {
    existsSync: vi.fn<[], Promise<boolean>>(),
    readFileSync: vi.fn<[], Promise<string | Uint8Array | null>>(),
    writeFileSync: vi.fn<[], Promise<void>>(),
    mkdir: vi.fn<[], Promise<void>>(),
  }

  const mockPath = {
    homeDir: vi.fn<[], Promise<string>>(),
    join: vi.fn<[string, ...string[]], Promise<string>>(),
    dirname: vi.fn<[string], Promise<string>>(),
  }

  return { mockFs, mockPath }
})

vi.mock('@janhq/core', () => ({
  fs: mockFs,
}))

vi.mock('@tauri-apps/api/path', () => mockPath)

describe('Phase 4 - Prompt Library', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPath.homeDir.mockResolvedValue('/home/user')
    mockPath.join.mockImplementation(async (...parts: string[]) => parts.join('/'))
    mockPath.dirname.mockImplementation(async (p: string) => {
      const idx = p.lastIndexOf('/')
      return idx > 0 ? p.slice(0, idx) : '/'
    })
  })

  it('extracts variables from template content', async () => {
    const { extractVariables } = await import('@/types/pm/prompt-template')
    expect(extractVariables('Hello {{name}}')).toEqual(['name'])
    expect(extractVariables('{{a}} {{a}} {{b}}')).toEqual(['a', 'b'])
    expect(extractVariables('')).toEqual([])
  })

  it('renders templates and errors on missing variables', async () => {
    const { renderTemplate } = await import('@/services/pm/template-engine')
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World')
    expect(() => renderTemplate('Hello {{name}} {{missing}}', { name: 'World' })).toThrow(
      'Missing values for: missing'
    )
  })

  it('estimates tokens and formats token label', async () => {
    const { estimateTokens, formatTokenLabel } = await import('@/services/pm/token-counter')

    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBeGreaterThan(0)
    expect(estimateTokens('שלום')).toBeGreaterThan(0)

    expect(formatTokenLabel(10)).toContain('~10')
    expect(formatTokenLabel(1000)).toContain('~1,000')
    expect(formatTokenLabel(10000)).toContain('~10,000')
  })

  it('compresses prompts by level', async () => {
    const { compressPrompt, CompressionLevel } = await import('@/services/pm/compression')

    const input = 'Line 1\n\n\nLine 2   \n<!-- comment -->\n\nLine 3'
    expect(compressPrompt(input, CompressionLevel.None)).toBe(input)
    expect(compressPrompt(input, CompressionLevel.Light)).not.toContain('\n\n\n')
    expect(compressPrompt(input, CompressionLevel.Medium)).not.toContain('<!-- comment -->')
    expect(compressPrompt(input, CompressionLevel.Aggressive)).not.toContain('\n\n')
  })

  it('reads and writes library.json under ~/prompt-master', async () => {
    const { getLibraryPath, loadTemplates, saveTemplates } = await import('@/services/pm/prompt-library')

    const path = await getLibraryPath()
    expect(path).toBe('/home/user/prompt-master/library.json')

    // No file -> []
    mockFs.existsSync.mockResolvedValueOnce(false)
    await expect(loadTemplates()).resolves.toEqual([])

    // Valid file -> parsed
    mockFs.existsSync.mockResolvedValueOnce(true)
    mockFs.readFileSync.mockResolvedValueOnce('[{"id":"1","name":"n","category":"c","content":"x","tags":[],"createdAt":"a","updatedAt":"b"}]')
    const loaded = await loadTemplates()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('1')

    // Save should mkdir when missing and write file
    mockFs.existsSync.mockResolvedValueOnce(false) // dir missing
    await saveTemplates(loaded)
    expect(mockFs.mkdir).toHaveBeenCalled()
    expect(mockFs.writeFileSync).toHaveBeenCalled()
  })
})

