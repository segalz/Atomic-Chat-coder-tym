import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavChats } from '../NavChats'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import { SidebarProvider } from '@/components/ui/sidebar'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to, onClick }: any) => (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('NavChats Code Agent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCodingAgentStore.setState({
      sessions: [],
      activeSessionId: null,
      planText: '',
      execLog: [],
      pendingDiffs: [],
      projectDir: '',
      isRunning: false,
    })
  })

  it('renders nothing when there are no sessions', () => {
    render(
      <SidebarProvider>
        <NavChats />
      </SidebarProvider>
    )

    expect(screen.queryByText('common:chats')).not.toBeInTheDocument()
  })

  it('renders sessions list with their prompt titles', () => {
    useCodingAgentStore.setState({
      sessions: [
        {
          id: 'sess-1',
          prompt: 'Create a new feature for dashboard',
          source: 'manual',
          projectDir: '/test',
          planText: '',
          execLog: [],
          pendingDiffs: [],
          timestamp: Date.now(),
        },
        {
          id: 'sess-2',
          prompt: 'Fix button styling bug',
          source: 'manual',
          projectDir: '/test',
          planText: '',
          execLog: [],
          pendingDiffs: [],
          timestamp: Date.now() - 1000,
        },
      ],
      activeSessionId: 'sess-1',
    })

    render(
      <SidebarProvider>
        <NavChats />
      </SidebarProvider>
    )

    expect(screen.getByText('Create a new feature for dashboard')).toBeInTheDocument()
    expect(screen.getByText('Fix button styling bug')).toBeInTheDocument()
  })

  it('loads session and navigates home when a session is clicked', () => {
    useCodingAgentStore.setState({
      sessions: [
        {
          id: 'sess-target',
          prompt: 'Investigate memory leak',
          source: 'manual',
          projectDir: '/my-project',
          planText: 'Plan to investigate',
          execLog: [{ type: 'text_delta', content: 'hello', timestamp: 123 }],
          pendingDiffs: [],
          timestamp: Date.now(),
        },
      ],
      activeSessionId: null,
    })

    render(
      <SidebarProvider>
        <NavChats />
      </SidebarProvider>
    )

    const sessionBtn = screen.getByText('Investigate memory leak')
    fireEvent.click(sessionBtn)

    expect(useCodingAgentStore.getState().activeSessionId).toBe('sess-target')
    expect(useCodingAgentStore.getState().planText).toBe('Plan to investigate')
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
  })
})
