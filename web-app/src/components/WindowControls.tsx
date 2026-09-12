import { Minus, Square, X } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button } from '@/components/ui/button'

export const WindowControls = () => {
  const appWindow = getCurrentWebviewWindow()

  const handleMinimize = async () => {
    try {
      await appWindow.minimize()
    } catch (err) {
      console.error('[WindowControls] Failed to minimize:', err)
    }
  }

  const handleMaximize = async () => {
    try {
      await appWindow.toggleMaximize()
    } catch (err) {
      console.error('[WindowControls] Failed to maximize:', err)
    }
  }

  const handleClose = async () => {
    try {
      await appWindow.close()
    } catch (err) {
      console.error('[WindowControls] Failed to close:', err)
    }
  }

  return (
    <div
      className="absolute top-0 z-50 right-4 h-15"
      data-tauri-drag-region="false"
    >
      <div className="flex items-center h-full" data-tauri-drag-region="false">
        <Button
          onClick={handleMinimize}
          aria-label="Minimize"
          variant="ghost"
          size="icon-sm"
          data-tauri-drag-region="false"
          className="hover:bg-muted hover:text-foreground"
        >
          <Minus className="size-4" />
        </Button>
        <Button
          onClick={handleMaximize}
          variant="ghost"
          size="icon-sm"
          aria-label="Maximize"
          data-tauri-drag-region="false"
          className="hover:bg-muted hover:text-foreground"
        >
          <Square className="size-3" />
        </Button>
        <Button
          onClick={handleClose}
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          data-tauri-drag-region="false"
          className="hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
