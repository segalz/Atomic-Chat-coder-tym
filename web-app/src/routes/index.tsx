/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import { useTools } from '@/hooks/useTools'
import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { predefinedProviders } from '@/constants/providers'
import { localStorageKey } from '@/constants/localStorage'
import { useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { CodingAgentPanel } from '@/containers/CodingAgentPanel'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
  newChatId?: string
}

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
      newChatId: search.newChatId as string | undefined,
    }

    return result
  },
})

function Index() {
  const { providers } = useModelProvider()
  const { setCurrentThreadId } = useThreads()
  useTools()

  //* После Skip без перемонтирования роутера — поднимаем флаг, иначе ре-рендер не гарантирован
  const [setupSkippedThisSession, setSetupSkippedThisSession] =
    useState(false)
  const setupCompletedOrSkipped =
    setupSkippedThisSession ||
    (typeof window !== 'undefined' &&
      localStorage.getItem(localStorageKey.setupCompleted) === 'true')

  // Conditional to check if there are any valid providers
  // required min 1 api_key or 1 model in llama.cpp or jan provider
  // Custom providers (not in predefinedProviders) don't require api_key but need models
  const hasValidProviders = providers.some((provider) => {
    const isPredefinedProvider = predefinedProviders.some(
      (p) => p.provider === provider.provider
    )

    // Custom providers don't need API key validation but must have models
    if (!isPredefinedProvider) {
      return provider.models.length > 0
    }

    // Predefined providers need either API key or models (for llamacpp/jan)
    return (
      provider.api_key?.length ||
      (provider.provider === 'llamacpp' && provider.models.length) ||
      (provider.provider === 'jan' && provider.models.length)
    )
  })

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (!hasValidProviders && !setupCompletedOrSkipped) {
    return (
      <SetupScreen
        onSkipped={() => setSetupSkippedThisSession(true)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <CodingAgentPanel />
    </div>
  )
}
