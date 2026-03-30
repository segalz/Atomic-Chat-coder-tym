import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { translateToEnglish } from '@/services/pm/translation-service'
import { searchTranslations, type TranslationMatch } from '@/services/pm/translation-search'
import { route } from '@/constants/routes'
import {
  IconArrowLeft,
  IconSearch,
  IconLanguage,
  IconFileText,
} from '@tabler/icons-react'

export function TranslationSearchPanel() {
  const navigate = useNavigate()

  const [hebrewInput, setHebrewInput] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [isTranslating, setIsTranslating] = useState(false)
  const [jsonFilePath, setJsonFilePath] = useState('')
  const [searchResults, setSearchResults] = useState<TranslationMatch[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTranslate = async () => {
    if (!hebrewInput.trim()) return
    setIsTranslating(true)
    setError(null)
    try {
      const result = await translateToEnglish(hebrewInput.trim())
      setTranslatedText(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTranslating(false)
    }
  }

  const handleSelectJsonFile = async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: {
          directory: false,
          multiple: false,
          title: 'Select translation JSON file',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        },
      })
      if (selected) setJsonFilePath(selected)
    } catch (err) {
      console.error('Failed to open dialog:', err)
    }
  }

  const handleSearch = async () => {
    if (!jsonFilePath || !hebrewInput.trim()) return
    setIsSearching(true)
    setError(null)
    try {
      const phrases = hebrewInput
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length >= 2)
      const results = await searchTranslations(jsonFilePath, phrases)
      setSearchResults(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: route.projectMode.index })}>
          <IconArrowLeft size={16} />
        </Button>
        <h1 className="text-lg font-semibold">Translation Search</h1>
      </div>

      <div className="flex flex-1 gap-6 overflow-hidden p-6">
        {/* Left: input */}
        <div className="flex w-1/2 flex-col gap-4">
          {/* Hebrew input */}
          <div>
            <label className="mb-1.5 block text-xs font-medium">Hebrew Text</label>
            <textarea
              dir="rtl"
              className="w-full rounded-lg border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              rows={4}
              placeholder="הזן טקסט בעברית לתרגום או חיפוש..."
              value={hebrewInput}
              onChange={(e) => setHebrewInput(e.target.value)}
            />
          </div>

          {/* Translate button */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTranslate}
              disabled={!hebrewInput.trim() || isTranslating}
              className="gap-1.5"
            >
              <IconLanguage size={14} />
              {isTranslating ? 'Translating...' : 'Translate to English'}
            </Button>
          </div>

          {/* Translation result */}
          {translatedText && (
            <div className="rounded-lg border bg-muted/30 px-4 py-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">English Translation</p>
              <p className="text-sm">{translatedText}</p>
            </div>
          )}

          {/* JSON file search */}
          <div className="border-t pt-4">
            <p className="mb-2 text-xs font-medium">Search in Translation File</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectJsonFile} className="gap-1.5">
                <IconFileText size={14} />
                {jsonFilePath ? jsonFilePath.split('/').pop() : 'Select JSON file'}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleSearch}
                disabled={!jsonFilePath || !hebrewInput.trim() || isSearching}
                className="gap-1.5"
              >
                <IconSearch size={14} />
                {isSearching ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        {/* Right: search results */}
        <div className="flex w-1/2 flex-col overflow-auto">
          {searchResults.length > 0 ? (
            <>
              <p className="mb-3 text-xs font-medium text-muted-foreground">
                {searchResults.length} result{searchResults.length > 1 ? 's' : ''} found
              </p>
              <div className="space-y-2">
                {searchResults.map((match, i) => (
                  <div key={i} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-medium text-primary">{match.key}</span>
                      <span className="text-[10px] text-muted-foreground">
                        Line {match.line} [{match.parentObject}]
                      </span>
                    </div>
                    <p dir="rtl" className="mt-1 text-sm">{match.hebrewText}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground truncate">{match.rowContext}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <IconSearch size={48} className="mx-auto mb-4 opacity-20" />
                <p className="text-sm">Enter Hebrew text and select a JSON file to search</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
