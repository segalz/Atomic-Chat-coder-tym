import { useState, useEffect } from 'react'
import { usePromptLibraryStore } from '@/stores/prompt-library-store'
import type { PromptTemplate } from '@/types/pm/prompt-template'
import { estimateTokens, formatTokenLabel } from '@/services/pm/token-counter'
import { extractVariables } from '@/types/pm/prompt-template'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { IconDeviceFloppy, IconTrash } from '@tabler/icons-react'

interface Props {
  template: PromptTemplate
  onClose: () => void
}

export function PromptEditor({ template, onClose }: Props) {
  const { update, delete: deleteTemplate } = usePromptLibraryStore()
  const [formData, setFormData] = useState<PromptTemplate>(template)

  useEffect(() => {
    setFormData(template)
  }, [template])

  const tokens = estimateTokens(formData.content || '')
  const tokenLabel = formatTokenLabel(tokens)
  const vars = extractVariables(formData.content || '')

  const handleSave = async () => {
    await update(formData)
  }

  const handleDelete = async () => {
    if (confirm('Are you sure you want to delete this prompt?')) {
      await deleteTemplate(template.id)
      onClose()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="font-semibold">Edit Prompt</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleDelete} className="text-destructive hover:text-destructive">
            <IconTrash size={16} />
          </Button>
          <Button size="sm" onClick={handleSave} className="gap-2">
            <IconDeviceFloppy size={16} /> Save
          </Button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input 
              value={formData.name || ''} 
              onChange={e => setFormData({ ...formData, name: e.target.value })} 
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Category</label>
            <Input 
              value={formData.category || ''} 
              onChange={e => setFormData({ ...formData, category: e.target.value })} 
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Tags (comma separated)</label>
          <Input 
            value={(formData.tags || []).join(', ')} 
            onChange={e => setFormData({ ...formData, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} 
          />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-xs font-medium text-muted-foreground">Prompt Content</label>
            <div className="text-xs font-mono bg-muted px-2 py-1 rounded">
              {tokenLabel}
            </div>
          </div>
          <Textarea 
            className="min-h-[300px] font-mono whitespace-pre-wrap"
            value={formData.content || ''}
            onChange={e => setFormData({ ...formData, content: e.target.value })}
            placeholder="Write your prompt logic here... Use {{variableName}} for dynamic inserts."
            dir="auto"
          />
        </div>

        {vars.length > 0 && (
          <div className="rounded-lg border p-4 bg-muted/20">
            <h3 className="text-sm font-medium mb-2">Detected Variables</h3>
            <div className="flex flex-wrap gap-2">
              {vars.map(v => (
                <span key={v} className="bg-primary/10 text-primary px-2 py-1 rounded-md text-xs font-mono">
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
