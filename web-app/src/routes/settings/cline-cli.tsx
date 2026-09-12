import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { IconCheck, IconRefresh, IconX } from '@tabler/icons-react'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useCodingAgentStore } from '@/stores/coding-agent-store'
import type { ClineInstallStatus } from '@/containers/CodingAgentPanel/ProviderModelPicker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.cline_cli as any)({
  component: ClineCliSettings,
})

function ClineCliSettings() {
  const autoApproveTools = useCodingAgentStore((s) => s.autoApproveTools)
  const setAutoApproveTools = useCodingAgentStore((s) => s.setAutoApproveTools)
  const [status, setStatus] = useState<ClineInstallStatus | null>(null)
  const [isChecking, setIsChecking] = useState(false)

  const checkInstall = useCallback(async () => {
    setIsChecking(true)
    try {
      const result = await invoke<ClineInstallStatus>('check_cline_installed')
      setStatus(result)
    } catch {
      setStatus({ installed: false, path: null, version: null })
    } finally {
      setIsChecking(false)
    }
  }, [])

  useEffect(() => {
    void checkInstall()
  }, [checkInstall])

  const versionLabel = status?.version
    ? `v${status.version.replace(/^v/i, '')}`
    : null
  const statusDescription = status?.installed
    ? [versionLabel, status.path].filter(Boolean).join(' · ') ||
      'Detected on this machine.'
    : status === null
      ? 'Checking whether Cline CLI is available on this machine.'
      : 'Cline CLI was not found on PATH.'

  return (
    <div className="flex h-screen w-full flex-col">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">Cline CLI</span>
        </div>
      </HeaderPage>
      <div className="flex flex-1 overflow-hidden">
        <SettingsMenu />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl space-y-6">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="text-foreground font-medium text-base font-studio">
                  Cline CLI
                </h1>
                <div className="text-xs bg-secondary border text-muted-foreground rounded-full py-0.5 px-2">
                  <span>Experimental</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure local Cline CLI agent integration and tool execution
                permissions.
              </p>
            </div>

            <Card title="Status">
              <CardItem
                title={
                  status?.installed
                    ? 'Cline CLI is installed'
                    : status === null
                      ? 'Checking Cline CLI…'
                      : 'Cline CLI not detected'
                }
                description={statusDescription}
                actions={
                  <div className="flex items-center gap-2">
                    {status?.installed ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <IconCheck size={12} />
                        Installed
                      </span>
                    ) : status !== null ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                        <IconX size={12} />
                        Not installed
                      </span>
                    ) : null}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void checkInstall()}
                      disabled={isChecking}
                      title="Refresh Cline CLI status"
                    >
                      <IconRefresh
                        size={16}
                        className="text-muted-foreground"
                      />
                    </Button>
                  </div>
                }
              />
            </Card>

            <Card title="Settings">
              <CardItem
                title="Auto-Approve All Tool Permissions"
                description="When enabled, all tool calls from Cline (reading files, editing files, and running terminal commands) will be automatically approved without showing permission dialogs. This setting applies globally to all Cline ACP runs."
                actions={
                  <div className="shrink-0 ml-4">
                    <Switch
                      checked={autoApproveTools}
                      onCheckedChange={setAutoApproveTools}
                    />
                  </div>
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
