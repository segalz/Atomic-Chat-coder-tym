import { useState, useMemo } from 'react'
import { usePromptLibraryStore } from '@/stores/prompt-library-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IconPlus, IconSearch, IconLibrary } from '@tabler/icons-react'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
}

export function PromptLibraryList({ selectedId, onSelect }: Props) {
  const { templates, add } = usePromptLibraryStore()
  const [search, setSearch] = useState('')

  const handleCreate = async () => {
    const id = await add({
      name: 'New Prompt',
      category: 'General',
      content: 'Write your prompt here...',
      tags: []
    })
    onSelect(id)
  }

  const filtered = useMemo(() => {
    const s = search.toLowerCase()
    return templates.filter(t => {
      const nameMatch = (t?.name || '').toLowerCase().includes(s)
      const contentMatch = (t?.content || '').toLowerCase().includes(s)
      return nameMatch || contentMatch
    })
  }, [templates, search])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <IconLibrary size={20} /> Prompt Library
        </h2>
        <Button size="sm" variant="ghost" onClick={handleCreate}>
          <IconPlus size={16} />
        </Button>
      </div>
      <div className="border-b p-4 pb-2">
        <div className="relative">
          <IconSearch className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            type="text"
            placeholder="Search prompts..." 
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.map(t => (
          <div 
            key={t?.id || Math.random().toString()}
            onClick={() => t?.id && onSelect(t.id)}
            className={`cursor-pointer rounded-lg p-3 hover:bg-accent transition-colors ${selectedId === t?.id ? 'bg-accent/80 font-medium' : ''}`}
          >
            <div className="truncate text-sm font-medium">{t?.name || 'Untitled Prompt'}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground flex gap-1">
              <span className="bg-muted px-1.5 py-0.5 rounded mr-1">{t?.category || 'General'}</span>
              {(t?.tags || []).map(tag => (
                <span key={tag} className="text-[10px] opacity-70">#{tag}</span>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center text-sm text-muted-foreground p-4">
            No templates found.
          </div>
        )}
      </div>
    </div>
  )
}
