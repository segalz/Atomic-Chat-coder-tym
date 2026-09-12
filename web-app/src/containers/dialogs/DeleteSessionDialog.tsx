import { useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
import type { CodingSession } from '@/stores/coding-agent-store'

interface DeleteSessionDialogProps {
  session: CodingSession
  onDelete: (sessionId: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteSessionDialog({
  session,
  onDelete,
  open,
  onOpenChange,
}: DeleteSessionDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const deleteButtonRef = useRef<HTMLButtonElement>(null)

  const handleDelete = () => {
    onDelete(session.id)
    onOpenChange(false)
    toast.success(t('common:toast.deleteThread.title'), {
      id: 'delete-session',
      description: t('common:toast.deleteThread.description'),
    })
    navigate({ to: route.home })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleDelete()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          deleteButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:deleteThread')}</DialogTitle>
          <DialogDescription>
            {t('common:dialogs.deleteThread.description')}
          </DialogDescription>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={handleDelete}
              onKeyDown={handleKeyDown}
              size="sm"
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
