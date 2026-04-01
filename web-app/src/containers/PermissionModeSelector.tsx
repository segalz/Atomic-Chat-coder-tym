import { useCodeModeStore } from '@/stores/code-mode-store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from 'lucide-react'

export function PermissionModeSelector() {
  const permissionMode = useCodeModeStore((s) => s.permissionMode)
  const setPermissionMode = useCodeModeStore((s) => s.setPermissionMode)
  const isAgentRunning = useCodeModeStore((s) => s.isAgentRunning)

  const modeLabel = permissionMode === 'ask' ? 'Ask permissions' : 'Auto accept edits'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isAgentRunning} className="gap-1">
          {modeLabel}
          <ChevronDownIcon size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={permissionMode === 'ask'}
          onCheckedChange={() => setPermissionMode('ask')}
        >
          Ask permissions
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={permissionMode === 'auto_accept'}
          onCheckedChange={() => setPermissionMode('auto_accept')}
        >
          Auto accept edits
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
