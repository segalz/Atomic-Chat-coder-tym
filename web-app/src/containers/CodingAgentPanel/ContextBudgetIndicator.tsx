import './ContextBudgetIndicator.css'

const CONTEXT_WINDOW_TOKENS = 32768

type ContextBudgetLevel = 'normal' | 'warning' | 'recommend' | 'critical'

interface ContextBudgetIndicatorProps {
  characterCount: number
  contextEnabled: boolean
}

function getContextBudgetLevel(percent: number): ContextBudgetLevel {
  if (percent >= 90) return 'critical'
  if (percent >= 80) return 'recommend'
  if (percent >= 60) return 'warning'
  return 'normal'
}

function getContextBudgetMessage(level: ContextBudgetLevel, contextEnabled: boolean): string {
  if (!contextEnabled) return 'Loop mode sends the prompt without conversation context.'

  switch (level) {
    case 'critical':
      return 'Summarize before continuing.'
    case 'recommend':
      return 'Summarizing soon is recommended.'
    case 'warning':
      return 'Context is getting larger.'
    default:
      return 'Context usage is in range.'
  }
}

export function estimateContextBudget(characterCount: number) {
  const estimatedTokens = Math.ceil(Math.max(0, characterCount) / 4)
  const contextPercent = estimatedTokens / CONTEXT_WINDOW_TOKENS
  const percent = Math.min(100, Math.round(contextPercent * 100))

  return {
    estimatedTokens,
    percent,
    level: getContextBudgetLevel(percent),
  }
}

export function ContextBudgetIndicator({
  characterCount,
  contextEnabled,
}: ContextBudgetIndicatorProps) {
  const budget = estimateContextBudget(characterCount)
  const className = [
    'context-budget-indicator',
    `context-budget-indicator--${budget.level}`,
    !contextEnabled ? 'context-budget-indicator--muted' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} aria-label="Code Mode context usage">
      <div className="context-budget-indicator__track" aria-hidden>
        <div
          className="context-budget-indicator__bar"
          style={{ width: `${budget.percent}%` }}
        />
      </div>
      <div className="context-budget-indicator__text flex items-center gap-2">
        <span className="context-budget-indicator__value text-slate-300 font-semibold text-xs">
          Context <span className="text-sky-400">{budget.percent}%</span>
        </span>
        <span className="text-slate-500 font-mono text-[11px]">
          ~{budget.estimatedTokens.toLocaleString()} tokens
        </span>
        <span className="text-slate-600">-</span>
        <span className="context-budget-indicator__detail text-slate-400 text-[11px]">
          {getContextBudgetMessage(budget.level, contextEnabled)}
        </span>
      </div>
    </div>
  )
}
