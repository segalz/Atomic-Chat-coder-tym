import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { IconSparkles, IconArrowsExchange, IconCpu, IconServer } from '@tabler/icons-react'
import type { CodingAgentBackend, ClineFreeModel } from './backend-identity'

export interface SwitchAiDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentModelId: string
  currentBackend: CodingAgentBackend
  clineModels: ClineFreeModel[]
  ollamaModels: string[]
  onSelectAi: (modelId: string, backend: CodingAgentBackend, displayName: string, provider?: string) => void
  disabled?: boolean
}

export function SwitchAiDialog({
  open,
  onOpenChange,
  currentModelId,
  currentBackend,
  clineModels,
  ollamaModels,
  onSelectAi,
  disabled = false,
}: SwitchAiDialogProps) {
  const [selectedBackend, setSelectedBackend] = useState<CodingAgentBackend>(currentBackend)
  const [selectedModelId, setSelectedModelId] = useState<string>(currentModelId)

  // Sync state when opened
  const currentModelDisplayName = useMemo(() => {
    if (currentBackend === 'cline-acp') {
      const m = clineModels.find((model) => model.id === currentModelId)
      return m ? `${m.name} (${m.provider})` : currentModelId
    }
    return currentModelId || 'Local Ollama Model'
  }, [currentBackend, currentModelId, clineModels])

  const handleConfirm = () => {
    let displayName = selectedModelId
    let provider: string | undefined

    if (selectedBackend === 'cline-acp') {
      const m = clineModels.find((model) => model.id === selectedModelId)
      if (m) {
        displayName = m.name
        provider = m.provider
      }
    } else {
      displayName = selectedModelId
      provider = 'Ollama'
    }

    onSelectAi(selectedModelId, selectedBackend, displayName, provider)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg md:max-w-lg lg:max-w-lg xl:max-w-lg w-full bg-[#10141d] border-[#222b3d] text-slate-100 p-5 overflow-x-hidden max-h-[90vh] overflow-y-auto">
        <DialogHeader className="w-full min-w-0">
          <DialogTitle className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
            <IconArrowsExchange size={18} className="shrink-0" />
            <span>Switch AI / Continue Work Thread</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400 mt-1 leading-relaxed">
            Transition smoothly to another AI. Your conversation history, files, and Work State will be preserved seamlessly in this Work Thread.
          </DialogDescription>
        </DialogHeader>

        <div className="my-3 space-y-3.5 w-full min-w-0">
          {/* Active AI banner */}
          <div className="w-full min-w-0 rounded-lg bg-[#151b27] border border-[#232c3d] p-2.5 flex items-center justify-between gap-2.5 text-xs">
            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="text-slate-400 font-medium shrink-0">Currently Active:</span>
              <span className="text-slate-200 font-bold font-mono truncate" title={currentModelDisplayName}>
                {currentModelDisplayName}
              </span>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-950/60 border border-sky-800/40 text-sky-300 shrink-0 whitespace-nowrap">
              {currentBackend === 'cline-acp' ? 'Cline ACP' : 'Direct Ollama'}
            </span>
          </div>

          {/* Backend Selector Tabs */}
          <div className="w-full min-w-0">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Select Connection Protocol
            </label>
            <div className="grid grid-cols-2 gap-2 w-full min-w-0">
              <button
                type="button"
                onClick={() => {
                  setSelectedBackend('cline-acp')
                  if (clineModels.length > 0 && !clineModels.some((m) => m.id === selectedModelId)) {
                    setSelectedModelId(clineModels[0].id)
                  }
                }}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all min-w-0 ${
                  selectedBackend === 'cline-acp'
                    ? 'bg-sky-500/15 border-sky-500 text-sky-300'
                    : 'bg-[#151a24] border-[#222b3d] text-slate-400 hover:text-slate-200 hover:bg-[#1a212e]'
                }`}
              >
                <IconSparkles size={14} className="shrink-0" />
                <span className="truncate">Cline ACP Cloud / Free</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedBackend('direct-ollama')
                  if (ollamaModels.length > 0 && !ollamaModels.includes(selectedModelId)) {
                    setSelectedModelId(ollamaModels[0])
                  }
                }}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all min-w-0 ${
                  selectedBackend === 'direct-ollama'
                    ? 'bg-sky-500/15 border-sky-500 text-sky-300'
                    : 'bg-[#151a24] border-[#222b3d] text-slate-400 hover:text-slate-200 hover:bg-[#1a212e]'
                }`}
              >
                <IconServer size={14} className="shrink-0" />
                <span className="truncate">Local Ollama</span>
              </button>
            </div>
          </div>

          {/* Model Choice */}
          <div className="w-full min-w-0">
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Select Target AI
              </label>
              <span className="text-[10px] text-slate-500 font-mono">
                {selectedBackend === 'cline-acp'
                  ? `${clineModels.length} models available`
                  : `${ollamaModels.length} models available`}
              </span>
            </div>
            {selectedBackend === 'cline-acp' ? (
              <div className="space-y-1.5 max-h-60 overflow-y-auto overflow-x-hidden pr-1.5 overscroll-y-contain [scrollbar-gutter:stable] w-full min-w-0">
                {clineModels.map((m) => {
                  const isSelected = selectedModelId === m.id
                  return (
                    <div
                      key={m.id}
                      onClick={() => setSelectedModelId(m.id)}
                      className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-center justify-between gap-2.5 w-full min-w-0 ${
                        isSelected
                          ? 'bg-[#182234] border-sky-500 text-white shadow-sm ring-1 ring-sky-500/30'
                          : 'bg-[#121620] border-[#202736] text-slate-300 hover:bg-[#161c28]'
                      }`}
                    >
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="font-semibold text-xs text-slate-100 shrink-0">{m.name}</span>
                          <span className="text-[10px] text-slate-400 font-mono shrink-0">({m.provider})</span>
                          {m.tag && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-sky-950/80 border border-sky-800/40 text-sky-300 font-mono shrink-0">
                              {m.tag}
                            </span>
                          )}
                        </div>
                        {m.description && (
                          <p
                            className="text-[11px] text-slate-400 truncate mt-0.5"
                            title={m.description}
                          >
                            {m.description}
                          </p>
                        )}
                      </div>
                      {isSelected && (
                        <span className="w-2.5 h-2.5 rounded-full bg-sky-400 shrink-0 ml-1 shadow-[0_0_8px_rgba(56,189,248,0.8)]" />
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-60 overflow-y-auto overflow-x-hidden pr-1.5 overscroll-y-contain [scrollbar-gutter:stable] w-full min-w-0">
                {ollamaModels.length === 0 ? (
                  <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-[#202736] rounded-lg">
                    No Ollama models found
                  </div>
                ) : (
                  ollamaModels.map((model) => {
                    const isSelected = selectedModelId === model
                    return (
                      <div
                        key={model}
                        onClick={() => setSelectedModelId(model)}
                        className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-center justify-between gap-2.5 w-full min-w-0 ${
                          isSelected
                            ? 'bg-[#182234] border-sky-500 text-white ring-1 ring-sky-500/30'
                            : 'bg-[#121620] border-[#202736] text-slate-300 hover:bg-[#161c28]'
                        }`}
                      >
                        <div className="flex items-center gap-2 font-mono text-xs min-w-0 flex-1 overflow-hidden">
                          <IconCpu size={14} className="text-slate-400 shrink-0" />
                          <span className="truncate" title={model}>{model}</span>
                        </div>
                        {isSelected && (
                          <span className="w-2.5 h-2.5 rounded-full bg-sky-400 shrink-0 ml-1 shadow-[0_0_8px_rgba(56,189,248,0.8)]" />
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 mt-3 pt-2 border-t border-[#1b2332] bg-transparent w-full min-w-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="border-[#263143] text-slate-300 hover:bg-[#171d29]"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={disabled || !selectedModelId}
            onClick={handleConfirm}
            className="bg-sky-500 hover:bg-sky-400 text-white gap-1.5 shadow-sm shrink-0"
          >
            <IconArrowsExchange size={14} />
            <span>Continue with this AI</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SwitchAiDialog
