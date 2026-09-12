import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import type { CodingSession } from '@/stores/coding-agent-store'

interface RenameSessionDialogProps {
  session: CodingSession
  onRename: (sessionId: string, title: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameSessionDialog({
  session,
  onRename,
  open,
  onOpenChange,
}: RenameSessionDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTitle(session.prompt || t('common:newThread'))
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 100)
    }
  }, [open, session.prompt, t])

  const handleRename = () => {
    const trimmed = title.trim()
    if (trimmed) {
      onRename(session.id, trimmed)
      onOpenChange(false)
      toast.success(t('common:toast.renameThread.title'), {
        id: 'rename-session',
        description: t('common:toast.renameThread.description', { title: trimmed }),
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && title.trim()) {
      handleRename()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('common:threadTitle')}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('common:newThread')}
          />
        </div>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleRename}
            disabled={!title.trim()}
          >
            {t('common:save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
