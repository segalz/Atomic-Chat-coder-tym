import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { WindowControls } from '../WindowControls'

// Mock the Tauri webview window API
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(),
}))

const mockGetCurrentWebviewWindow = getCurrentWebviewWindow as ReturnType<
  typeof vi.fn
>

describe('WindowControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCurrentWebviewWindow.mockReturnValue({
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
    })
  })

  it('calls minimize() when the Minimize button is clicked', async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole('button', { name: 'Minimize' }))

    const appWindow = mockGetCurrentWebviewWindow.mock.results[0].value
    expect(appWindow.minimize).toHaveBeenCalledTimes(1)
  })

  it('calls toggleMaximize() when the Maximize button is clicked', async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole('button', { name: 'Maximize' }))

    const appWindow = mockGetCurrentWebviewWindow.mock.results[0].value
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('calls close() when the Close button is clicked', async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    const appWindow = mockGetCurrentWebviewWindow.mock.results[0].value
    expect(appWindow.close).toHaveBeenCalledTimes(1)
  })
})
