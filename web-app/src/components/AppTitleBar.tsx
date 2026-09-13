import { Folder, Minus, PanelLeft, PanelRight, Square, X } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import { useSidebarSafe } from '@/components/ui/sidebar'

export const AppTitleBar = () => {
  const projectDir = useCodingAgentStore((s) => s.projectDir)
  const isRightPanelOpen = useCodingAgentStore((s) => s.isRightPanelOpen)
  const toggleRightPanel = useCodingAgentStore((s) => s.toggleRightPanel)
  const sidebar = useSidebarSafe()
  const appWindow = getCurrentWebviewWindow()

  const handleMinimize = async () => {
    try {
      await appWindow.minimize()
    } catch (err) {
      console.error('[AppTitleBar] Failed to minimize:', err)
    }
  }

  const handleMaximize = async () => {
    try {
      await appWindow.toggleMaximize()
    } catch (err) {
      console.error('[AppTitleBar] Failed to maximize:', err)
    }
  }

  const handleClose = async () => {
    try {
      await appWindow.close()
    } catch (err) {
      console.error('[AppTitleBar] Failed to close:', err)
    }
  }

  return (
    <header
      className="h-9 bg-[#0b0e14] border-b border-[#1a202c] flex items-center justify-between px-3 text-xs select-none z-50 shrink-0"
      data-tauri-drag-region
    >
      <div className="flex items-center gap-2" data-tauri-drag-region="false">
        {sidebar && (
          <button
            type="button"
            onClick={() => sidebar.toggleSidebar()}
            className={`p-1 rounded transition-colors cursor-pointer mr-0.5 ${
              sidebar.open
                ? 'text-sky-400 bg-sky-950/40 hover:bg-sky-900/50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#161c27]'
            }`}
            title={sidebar.open ? 'Collapse Left Sidebar (Ctrl+B)' : 'Expand Left Sidebar (Ctrl+B)'}
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <img
          alt="JoinAIForce Logo"
          className="w-4 h-4 object-contain"
          src="/images/transparent-logo.png"
        />
        <span className="font-semibold text-slate-200 tracking-wide text-[11px] flex items-center gap-1.5">
          JoinAIForce{' '}
          <span className="text-[11px] font-semibold font-mono px-2 py-0.5 rounded-md bg-sky-950 text-sky-300 border border-sky-500/70 shadow-xs">
            v{typeof VERSION !== 'undefined' ? VERSION : '1.2 Beta'}
          </span>
        </span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-400 text-[11px] flex items-center gap-1">
          <Folder className="w-3.5 h-3.5 text-slate-500" />
          <span className="font-mono">{projectDir || 'C:\\Develop\\traidAi'}</span>
        </span>
      </div>

      <div className="flex-1 h-full" data-tauri-drag-region />

      <div className="flex items-center gap-1" data-tauri-drag-region="false">
        <button
          type="button"
          onClick={toggleRightPanel}
          className={`p-1.5 rounded transition-colors cursor-pointer mr-1 ${
            isRightPanelOpen
              ? 'text-sky-400 bg-sky-950/40 hover:bg-sky-900/50'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#161c27]'
          }`}
          title={isRightPanelOpen ? 'Hide Inspector Panel' : 'Show Inspector Panel'}
        >
          <PanelRight className="w-3.5 h-3.5" />
        </button>

        {IS_WINDOWS && (
          <div className="flex items-center space-x-1 text-slate-400">
            <button
              onClick={handleMinimize}
              className="hover:text-slate-200 hover:bg-[#161c27] transition-colors p-1.5 rounded"
              title="Minimize"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={handleMaximize}
              className="hover:text-slate-200 hover:bg-[#161c27] transition-colors p-1.5 rounded"
              title="Maximize"
            >
              <Square className="w-3 h-3" />
            </button>
            <button
              onClick={handleClose}
              className="hover:text-rose-400 hover:bg-rose-950/30 transition-colors p-1.5 rounded"
              title="Close"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}