import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Settings } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
} from '@/components/ui/sidebar'

export function LeftSidebar() {
  return (
    <Sidebar
      variant="sidebar"
      collapsible="offcanvas"
      className="bg-[#0d1017] border-r border-[#1a202c] select-none"
    >
      <SidebarHeader className="p-3 border-b border-[#171d27]">
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2.5">
            <div className="relative w-7 h-7 flex items-center justify-center rounded-lg bg-gradient-to-br from-sky-500/20 to-sky-900/10 border border-sky-500/30">
              <img
                src="/images/transparent-logo.png"
                alt="JoinAIForce"
                className="w-5 h-5 object-contain"
              />
            </div>
            <div>
              <div className="text-xs font-bold tracking-tight text-white flex items-center gap-1.5">
                JoinAIForce
              </div>
              <div className="text-[11px] text-sky-300 font-mono font-medium">
                Agent Engine v{typeof VERSION !== 'undefined' ? VERSION : '1.2'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 text-slate-500">
            <SidebarTrigger className="text-slate-400 hover:text-slate-200 hover:bg-[#161c27] rounded transition-colors size-7" />
          </div>
        </div>
        <NavMain />
      </SidebarHeader>

      <SidebarContent className="px-2 py-3 space-y-1">
        <NavProjects />
        <NavChats />
      </SidebarContent>

      <SidebarFooter className="p-0">
        <div className="px-2 py-1.5 border-t border-[#171d27]">
          <Link
            to={route.settings.general}
            className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[#141a24] hover:text-slate-200 transition-colors text-xs text-slate-400"
          >
            <div className="flex items-center gap-2.5">
              <Settings className="w-3.5 h-3.5 text-slate-500" />
              <span>Settings</span>
            </div>
          </Link>
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
