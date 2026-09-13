import { useCallback, useEffect, useState } from 'react'
import {
  IconCheck,
  IconEdit,
  IconMessageQuestion,
  IconPencil,
  IconStack2,
  IconTarget,
} from '@tabler/icons-react'
import type { WorkState } from '@/stores/coding-agent-store'

export interface WorkStateCardProps {
  workState?: WorkState
  onUpdateWorkState: (patch: Partial<WorkState>) => void
  disabled?: boolean
}

const INPUT_CLASS =
  'bg-[#0e121a] border border-[#273244] text-slate-100 rounded px-2 py-1 text-xs w-full focus:border-sky-500 outline-none'

const STATUS_OPTIONS = ['In Progress', 'Active', 'Done'] as const

function StatusBadge({ status }: { status?: string }) {
  const normalized = (status ?? '').toLowerCase()
  const className = normalized.includes('done')
    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
    : normalized.includes('active')
      ? 'bg-sky-500/10 border-sky-500/30 text-sky-400'
      : 'bg-amber-500/10 border-amber-500/30 text-amber-400'

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${className}`}
    >
      {status || 'In Progress'}
    </span>
  )
}


export function WorkStateCard({
  workState,
  onUpdateWorkState,
  disabled = false,
}: WorkStateCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<WorkState>({})

  const startEditing = useCallback(() => {
    setDraft({
      goal: workState?.goal ?? '',
      status: workState?.status ?? 'In Progress',
      keyContext: workState?.keyContext ?? '',
      openQuestions: workState?.openQuestions ?? '',
      nextStep: workState?.nextStep ?? '',
    })
    setEditing(true)
  }, [workState])

  const commitEditing = useCallback(() => {
    onUpdateWorkState({
      goal: draft.goal?.trim() || undefined,
      status: draft.status?.trim() || undefined,
      keyContext: draft.keyContext?.trim() || undefined,
      openQuestions: draft.openQuestions?.trim() || undefined,
      nextStep: draft.nextStep?.trim() || undefined,
    })
    setEditing(false)
  }, [draft, onUpdateWorkState])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setDraft({})
  }, [])

  // Exit edit mode automatically when the card is disabled (e.g. busy session).
  useEffect(() => {
    if (disabled && editing) setEditing(false)
  }, [disabled, editing])

  const updateDraft = (key: keyof WorkState) => (value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const isEditing = editing && !disabled

  return (
    <div
      className="bg-[#141824] border border-[#232c3d] rounded-xl p-3 space-y-2.5 text-xs text-slate-300 select-text"
      aria-label="Work state"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-sky-400">
          <IconTarget size={12} stroke={2} aria-hidden />
          <span>Work State</span>
        </div>
        <button
          type="button"
          onClick={isEditing ? commitEditing : startEditing}
          disabled={disabled}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide transition-colors disabled:opacity-40 ${
            isEditing
              ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-[#1b2334] text-slate-400 hover:text-sky-400 hover:bg-[#202a3e]'
          }`}
          title={isEditing ? 'Save work state' : 'Edit work state'}
        >
          {isEditing ? (
            <>
              <IconCheck size={11} stroke={2.5} aria-hidden />
              Done
            </>
          ) : (
            <>
              <IconPencil size={11} stroke={2} aria-hidden />
              Edit
            </>
          )}
        </button>
      </div>

      {/* Edit mode fields */}
      {isEditing ? (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Status
            </span>
            <select
              value={draft.status ?? ''}
              onChange={(e) => updateDraft('status')(e.target.value)}
              className={INPUT_CLASS}
              disabled={disabled}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Goal
            </span>
            <input
              value={draft.goal ?? ''}
              onChange={(e) => updateDraft('goal')(e.target.value)}
              placeholder="What is this thread trying to accomplish?"
              className={INPUT_CLASS}
              disabled={disabled}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Key Context
            </span>
            <textarea
              value={draft.keyContext ?? ''}
              onChange={(e) => updateDraft('keyContext')(e.target.value)}
              placeholder="Context another AI would need to continue"
              rows={2}
              className={`${INPUT_CLASS} resize-y font-mono`}
              disabled={disabled}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Open Questions
            </span>
            <textarea
              value={draft.openQuestions ?? ''}
              onChange={(e) => updateDraft('openQuestions')(e.target.value)}
              placeholder="Outstanding questions or issues"
              rows={2}
              className={`${INPUT_CLASS} resize-y font-mono`}
              disabled={disabled}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Next Step
            </span>
            <input
              value={draft.nextStep ?? ''}
              onChange={(e) => updateDraft('nextStep')(e.target.value)}
              placeholder="The immediate next action"
              className={INPUT_CLASS}
              disabled={disabled}
            />
          </label>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={disabled}
            className="text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        /* View mode */
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Goal
              </div>
              <div
                className={`mt-0.5 font-bold leading-snug text-slate-100 ${
                  workState?.goal ? '' : 'font-medium text-slate-500 italic'
                }`}
              >
                {workState?.goal || 'No goal specified yet'}
              </div>
            </div>
            <StatusBadge status={workState?.status} />
          </div>

          {workState?.keyContext && (
            <div>
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <IconStack2 size={10} stroke={2} aria-hidden />
                Key Context
              </div>
              <div className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-400">
                {workState.keyContext}
              </div>
            </div>
          )}

          {workState?.openQuestions && (
            <div>
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <IconMessageQuestion size={10} stroke={2} aria-hidden />
                Open Questions
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
                {workState.openQuestions}
              </div>
            </div>
          )}

          {workState?.nextStep ? (
            <div className="rounded-md border border-sky-500/20 bg-sky-500/5 px-2 py-1.5">
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
                <IconEdit size={10} stroke={2} aria-hidden />
                Next Step
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-sky-200">
                {workState.nextStep}
              </div>
            </div>
          ) : (
            <div className="text-[11px] italic text-slate-600">
              No next step defined
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default WorkStateCard

