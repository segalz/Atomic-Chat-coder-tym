import { Plus, Search } from 'lucide-react'
import { route } from '@/constants/routes'
import { useNavigate } from '@tanstack/react-router'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { createNewChatId, resetNewChatState } from '@/lib/new-chat'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'

export function NavMain() {
  const navigate = useNavigate()
  const { addFolder } = useThreadManagement()
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } = useProjectDialog()

  const handleNewChat = async () => {
    resetNewChatState()
    navigate({
      to: route.home,
      search: { newChatId: createNewChatId() },
    })
  }

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const newProject = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: newProject.id },
    })
  }

  return (
    <>
      <button
        onClick={handleNewChat}
        className="w-full flex items-center justify-between px-3 py-2 bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white rounded-lg text-xs font-medium shadow-sm transition-all group glow-cyan"
      >
        <div className="flex items-center gap-2">
          <Plus className="w-3.5 h-3.5" />
          <span>New Work Thread</span>
        </div>
        <kbd className="text-[10px] bg-black/25 px-1.5 py-0.5 rounded font-mono text-sky-100 group-hover:bg-black/40">
          Ctrl N
        </kbd>
      </button>

      <nav className="mt-2.5 space-y-0.5 text-xs text-slate-400">
        <button
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[#141a24] hover:text-slate-200 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Search className="w-3.5 h-3.5 text-slate-500" />
            <span>Search</span>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">Ctrl K</span>
        </button>
      </nav>

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}