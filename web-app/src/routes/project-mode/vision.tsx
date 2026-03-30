import { createFileRoute } from '@tanstack/react-router'
import { ScreenshotDropZone } from '@/containers/pm/ScreenshotDropZone'

export const Route = createFileRoute('/project-mode/vision')({
  component: VisionPage,
})

function VisionPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenshotDropZone />
    </div>
  )
}
