import { useState } from 'react'
import {
  IconArrowsExchange,
  IconTerminal2,
  IconTrash,
  IconCopy,
  IconRefresh,
  IconAdjustmentsHorizontal,
} from '@tabler/icons-react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AIPathStep } from '@/stores/coding-agent-store'

export interface WorkThreadHeaderProps {
  title: string
  status: string
  activeAiName: string
  connectionMethod: string
  aiPath?: AIPathStep[]
  isRunning: boolean
  loopInfo?: string
  isSidebarOpen?: boolean
  onToggleSidebar?: () => void
  isRightPanelOpen: boolean
  onToggleRightPanel: () => void
  onOpenSwitchAi: () => void
  onClearSession?: () => void
  onCopyLog?: () => void
  hasLogs?: boolean
  showOllamaRestart?: boolean
  isRestartingOllama?: boolean
  onRestartOllama?: () => void
}

export function WorkThreadHeader({
  title,
  status,
  activeAiName,
  connectionMethod,
  aiPath = [],
  isRunning,
  loopInfo,
  isSidebarOpen = true,
  onToggleSidebar,
  isRightPanelOpen,
  onToggleRightPanel,
  onOpenSwitchAi,
  onClearSession,
  onCopyLog,
  hasLogs = false,
  showOllamaRestart = false,
  isRestartingOllama = false,
  onRestartOllama,
}: WorkThreadHeaderProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  const isThreadActive = isRunning || status === 'running'

  return (
    <header className="h-11 border-b border-[#1b212f] bg-[#0c1017]/95 px-3.5 flex items-center justify-between shrink-0 select-none">
      {/* Left: Sidebar toggle, Thread Title, Status, and AI Path */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-3">
        {!isSidebarOpen && onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-sky-300 hover:bg-[#161c27] px-2 py-1 rounded border border-[#232a39] transition-colors cursor-pointer mr-0.5 shrink-0"
            title="Expand Sidebar"
          >
            <PanelLeft className="w-3.5 h-3.5 text-sky-400" />
            <span className="font-sans">Sidebar</span>
          </button>
        )}

        {/* Work Thread Title & Status */}
        <div className="flex items-center gap-2 min-w-0 shrink truncate">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isThreadActive
                ? 'bg-emerald-400 animate-pulse'
                : 'bg-sky-400'
            }`}
          />
          <h1
            className="text-xs font-semibold text-slate-100 truncate max-w-[200px] sm:max-w-xs md:max-w-sm"
            title={title}
          >
            {title || 'Work Thread'}
          </h1>
          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#161d2a] border border-[#232d40] text-slate-400 shrink-0">
            {isThreadActive ? 'Active' : 'Ready'}
          </span>
          {loopInfo && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-950/60 border border-sky-800/40 text-sky-400 shrink-0">
              {loopInfo}
            </span>
          )}
        </div>

        {/* AI Path breadcrumb (Continuity trail) */}
        {aiPath && aiPath.length > 0 && (
          <div className="hidden lg:flex items-center gap-1 text-[10px] font-mono text-slate-400 bg-[#121620] border border-[#1e2637] rounded-md px-2 py-0.5 shrink-0 max-w-xs truncate">
            <span className="text-slate-500 font-sans">AI Path:</span>
            {aiPath.slice(-3).map((step, idx) => (
              <span key={`${step.modelId}-${step.timestamp}-${idx}`} className="flex items-center gap-1">
                {idx > 0 && <span className="text-sky-500">→</span>}
                <span className={idx === aiPath.length - 1 ? 'text-sky-300 font-semibold' : 'text-slate-400'}>
                  {step.displayName || step.modelId.split('/').pop()}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Right: Active AI, Switch AI Button, Diagnostics Menu, Right Panel Toggle */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Active AI badge with clear hierarchy */}
        <div
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-[#121722] border border-[#222c3d] rounded-lg text-xs"
          title={`Active Model: ${activeAiName} via ${connectionMethod}`}
        >
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Active:</span>
          <span className="font-semibold text-slate-200 text-[11px] font-mono truncate max-w-[140px]">
            {activeAiName}
          </span>
          <span className="text-[9px] font-mono px-1 rounded bg-[#1a2232] text-slate-400">
            {connectionMethod}
          </span>
        </div>

        {/* Switch AI / Continue With Another AI action button */}
        <button
          type="button"
          onClick={onOpenSwitchAi}
          disabled={isRunning}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 transition-all cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed group"
          title="Switch AI / Continue With Another AI in this Work Thread"
        >
          <IconArrowsExchange size={14} className="text-sky-400 group-hover:rotate-180 transition-transform duration-300" />
          <span className="font-sans">Switch AI</span>
        </button>

        {/* Diagnostics & Tools Progressive Disclosure toggle */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowDiagnostics((prev) => !prev)}
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              showDiagnostics
                ? 'bg-[#1a2232] text-slate-200'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#161c27]'
            }`}
            title="Diagnostics & Session Tools"
          >
            <IconAdjustmentsHorizontal size={15} />
          </button>

          {showDiagnostics && (
            <div className="absolute right-0 top-full mt-1.5 w-60 rounded-xl border border-[#263143] bg-[#10141d] shadow-xl p-2.5 z-50 space-y-2 text-xs">
              <div className="flex items-center justify-between pb-1.5 border-b border-[#1d2636] font-mono text-[11px] text-slate-400">
                <div className="flex items-center gap-1.5">
                  <IconTerminal2 size={13} className="text-sky-400" />
                  <span>Diagnostics</span>
                </div>
                <span className={status === 'running' ? 'text-emerald-400' : 'text-slate-400'}>
                  {status}
                </span>
              </div>

              {showOllamaRestart && onRestartOllama && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start h-7 text-xs text-slate-300 hover:text-white"
                  onClick={onRestartOllama}
                  disabled={isRestartingOllama || isRunning}
                >
                  <IconRefresh size={13} className={isRestartingOllama ? 'animate-spin mr-2' : 'mr-2'} />
                  Restart Ollama memory
                </Button>
              )}

              {hasLogs && onCopyLog && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start h-7 text-xs text-slate-300 hover:text-white"
                  onClick={onCopyLog}
                >
                  <IconCopy size={13} className="mr-2" />
                  Copy Turn Log
                </Button>
              )}

              {hasLogs && onClearSession && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start h-7 text-xs text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    onClearSession()
                    setShowDiagnostics(false)
                  }}
                  disabled={isRunning}
                >
                  <IconTrash size={13} className="mr-2" />
                  Clear Current Session
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Right Inspector toggle */}
        <button
          type="button"
          onClick={onToggleRightPanel}
          className={`p-1.5 rounded transition-colors cursor-pointer ${
            isRightPanelOpen
              ? 'text-sky-400 hover:bg-sky-950/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#161c27]'
          }`}
          title={isRightPanelOpen ? 'Hide Right Inspector Panel' : 'Show Right Inspector Panel'}
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>
    </header>
  )
}

export default WorkThreadHeader
