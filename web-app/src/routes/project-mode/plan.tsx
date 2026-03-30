import { createFileRoute } from '@tanstack/react-router'
import { PlanComposer } from '@/containers/pm/PlanComposer'

export const Route = createFileRoute('/project-mode/plan')({
  component: PlanPage,
})

function PlanPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PlanComposer />
    </div>
  )
}
