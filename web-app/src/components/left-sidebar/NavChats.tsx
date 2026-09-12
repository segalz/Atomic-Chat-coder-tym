import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarGroupAction,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { memo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useCodingAgentStore, type CodingSession } from '@/stores/coding-agent-store'
import { useCodeModeStore } from '@/stores/code-mode-store'
import { useThreads } from '@/hooks/useThreads'
import { RenameSessionDialog } from '@/containers/dialogs/RenameSessionDialog'
import { DeleteSessionDialog } from '@/containers/dialogs/DeleteSessionDialog'
import { DeleteAllSessionsDialog } from '@/containers/dialogs/DeleteAllSessionsDialog'

const SessionItem = memo(function SessionItem({
  session,
  isMobile,
}: {
  session: CodingSession
  isMobile: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const activeSessionId = useCodingAgentStore((s) => s.activeSessionId)
  const loadSession = useCodingAgentStore((s) => s.loadSession)
  const renameSession = useCodingAgentStore((s) => s.renameSession)
  const deleteSession = useCodingAgentStore((s) => s.deleteSession)
  const setMode = useCodeModeStore((s) => s.setMode)
  const { setOpenMobile } = useSidebar()

  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const isActive = activeSessionId === session.id
  const title = session.prompt?.trim() || t('common:newThread')

  const handleSelect = () => {
    loadSession(session.id)
    setMode('coding')
    navigate({ to: route.home })
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={handleSelect}
        title={session.prompt}
      >
        <span className="truncate">{title}</span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            className="hover:bg-sidebar-foreground/8"
          >
            <MoreHorizontal />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-40"
          side={isMobile ? 'bottom' : 'right'}
          align={isMobile ? 'end' : 'start'}
        >
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-4 mr-2" />
            <span>{t('common:rename')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="size-4 mr-2" />
            <span>{t('common:delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameSessionDialog
        session={session}
        onRename={renameSession}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <DeleteSessionDialog
        session={session}
        onDelete={deleteSession}
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
      />
    </SidebarMenuItem>
  )
})

export function NavChats() {
  const { t } = useTranslation()
  const sessions = useCodingAgentStore((state) => state.sessions)
  const deleteAllSessions = useCodingAgentStore((state) => state.deleteAllSessions)
  const deleteAllThreads = useThreads((state) => state.deleteAllThreads)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { isMobile } = useSidebar()

  const handleDeleteAll = () => {
    deleteAllSessions()
    deleteAllThreads()
  }

  if (sessions.length === 0) {
    return null
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t('common:chats')}</SidebarGroupLabel>
      {sessions.length > 1 && (
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarGroupAction className="hover:bg-sidebar-foreground/8">
              <MoreHorizontal className="text-muted-foreground" />
              <span className="sr-only">More</span>
            </SidebarGroupAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DeleteAllSessionsDialog
              onDeleteAll={handleDeleteAll}
              onDropdownClose={() => setDropdownOpen(false)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <SidebarMenu>
        {sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isMobile={isMobile}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
