import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { PromptLibraryList } from '@/containers/pm/PromptLibraryList'
import { PromptEditor } from '@/containers/pm/PromptEditor'
import { usePromptLibraryStore } from '@/stores/prompt-library-store'

export const Route = createFileRoute('/prompt-library/')({
  component: PromptLibraryPage,
})

function PromptLibraryPage() {
  const { load, templates, isLoading } = usePromptLibraryStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    load()
  }, [load])

  const selectedTemplate = templates.find(t => t.id === selectedId)

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <div className="w-1/3 border-r bg-muted/10 h-full">
        <PromptLibraryList 
          selectedId={selectedId} 
          onSelect={setSelectedId} 
        />
      </div>
      <div className="w-2/3 flex-1 h-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading library...
          </div>
        ) : selectedTemplate ? (
          <PromptEditor 
            template={selectedTemplate} 
            onClose={() => setSelectedId(null)} 
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground flex-col gap-2">
            <div className="text-4xl text-muted-foreground/30">📚</div>
            <p>Select a prompt to edit or create a new one.</p>
          </div>
        )}
      </div>
    </div>
  )
}
