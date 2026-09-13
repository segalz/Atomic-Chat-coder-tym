import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkStateCard } from './WorkStateCard'
import type { WorkState } from '@/stores/coding-agent-store'

const SAMPLE_WORK_STATE: WorkState = {
  goal: 'Ship the login page',
  status: 'Active',
  keyContext: 'Auth is handled by the backend service',
  openQuestions: 'Which OAuth provider do we support?',
  nextStep: 'Wire up the login form submit handler',
}

function renderCard(
  props: Partial<Parameters<typeof WorkStateCard>[0]> = {},
) {
  const onUpdateWorkState = vi.fn()
  const utils = render(
    <WorkStateCard
      workState={SAMPLE_WORK_STATE}
      onUpdateWorkState={onUpdateWorkState}
      {...props}
    />,
  )
  return { ...utils, onUpdateWorkState }
}

describe('WorkStateCard', () => {
  it('renders Goal, Status, Key Context, Open Questions and Next Step in view mode', () => {
    const { onUpdateWorkState } = renderCard()

    expect(screen.getByText('Work State')).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_WORK_STATE.goal!)).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_WORK_STATE.status!)).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_WORK_STATE.keyContext!)).toBeInTheDocument()
    expect(
      screen.getByText(SAMPLE_WORK_STATE.openQuestions!),
    ).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_WORK_STATE.nextStep!)).toBeInTheDocument()

    // No form is rendered in view mode
    expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument()
    expect(onUpdateWorkState).not.toHaveBeenCalled()
  })

  it('enters edit mode when Edit is clicked and renders the form inputs', async () => {
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Status')).toBeInTheDocument()
    expect(screen.getByLabelText('Goal')).toHaveValue(SAMPLE_WORK_STATE.goal)
    expect(screen.getByLabelText('Key Context')).toHaveValue(
      SAMPLE_WORK_STATE.keyContext,
    )
    expect(screen.getByLabelText('Open Questions')).toHaveValue(
      SAMPLE_WORK_STATE.openQuestions,
    )
    expect(screen.getByLabelText('Next Step')).toHaveValue(
      SAMPLE_WORK_STATE.nextStep,
    )
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('calls onUpdateWorkState with the updated values when Done is clicked', async () => {
    const user = userEvent.setup()
    const { onUpdateWorkState } = renderCard()

    await user.click(screen.getByRole('button', { name: 'Edit' }))

    const goalInput = screen.getByLabelText('Goal')
    await user.clear(goalInput)
    await user.type(goalInput, 'Finish the checkout flow   ')

    await user.selectOptions(screen.getByLabelText('Status'), 'Done')

    const keyContextInput = screen.getByLabelText('Key Context')
    await user.clear(keyContextInput)
    await user.type(keyContextInput, 'Payments are stubbed in test mode')

    const openQuestionsInput = screen.getByLabelText('Open Questions')
    await user.clear(openQuestionsInput)
    await user.type(openQuestionsInput, 'Do we refund partial carts?')

    const nextStepInput = screen.getByLabelText('Next Step')
    await user.clear(nextStepInput)
    await user.type(nextStepInput, 'Add E2E test for checkout')

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onUpdateWorkState).toHaveBeenCalledTimes(1)
    expect(onUpdateWorkState).toHaveBeenCalledWith({
      goal: 'Finish the checkout flow', // trailing whitespace is trimmed
      status: 'Done',
      keyContext: 'Payments are stubbed in test mode',
      openQuestions: 'Do we refund partial carts?',
      nextStep: 'Add E2E test for checkout',
    })

    // Back in view mode after saving
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument()
  })

  it('leaves edit mode without saving when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const { onUpdateWorkState } = renderCard()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Goal')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Goal'))
    await user.type(screen.getByLabelText('Goal'), 'Discarded draft')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onUpdateWorkState).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_WORK_STATE.goal!)).toBeInTheDocument()
  })

  it('disables the Edit button in disabled mode', async () => {
    const user = userEvent.setup()
    const { onUpdateWorkState } = renderCard({ disabled: true })

    const editButton = screen.getByRole('button', { name: 'Edit' })
    expect(editButton).toBeDisabled()

    // Clicking a disabled button must not enter edit mode
    await user.click(editButton)
    expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument()
    expect(onUpdateWorkState).not.toHaveBeenCalled()
  })
})
