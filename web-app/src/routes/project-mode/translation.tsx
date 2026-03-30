import { createFileRoute } from '@tanstack/react-router'
import { TranslationSearchPanel } from '@/containers/pm/TranslationSearchPanel'

export const Route = createFileRoute('/project-mode/translation')({
  component: TranslationPage,
})

function TranslationPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TranslationSearchPanel />
    </div>
  )
}
