import { createFileRoute } from '@tanstack/react-router'
import { ProjectModePanel } from '@/containers/pm/ProjectModePanel'

export const Route = createFileRoute('/project-mode/')({
  component: ProjectModePage,
})

function ProjectModePage() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ProjectModePanel />
    </div>
  )
}
