import { DownloadManagement } from '@/containers/DownloadManegement'
import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { useLeftPanel } from '@/hooks/useLeftPanel'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'

export function LeftSidebar() {
  const { open: isLeftPanelOpen } = useLeftPanel()
  return (
    <div className="relative z-50">
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader className="flex flex-col gap-1 px-1">
          <div className="flex w-full items-center justify-end">
            {isLeftPanelOpen && <DownloadManagement />}
            <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
          </div>
          <div className="mt-1 flex w-full items-center gap-2 pl-2">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-lg p-[2px]"
              title="JoinAIForce Chat"
            >
              <img
                src="/images/transparent-logo.png"
                alt="JoinAIForce Chat"
                className="size-full min-h-0 min-w-0 object-contain"
              />
            </div>
            <span className="text-muted-foreground text-xs">v{VERSION}</span>
          </div>
          <NavMain />
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          <NavProjects />
          <NavChats />
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
