import { Activity, AlertTriangle, Boxes, Globe, Settings } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const NAV_ITEMS = [
  {
    title: 'Jobs',
    url: '/',
    icon: Activity,
    match: (path: string) => path === '/' || path.startsWith('/jobs/'),
  },
  {
    title: 'Needs review',
    url: '/attention',
    icon: AlertTriangle,
    match: (path: string) => path.startsWith('/attention'),
  },
  {
    title: 'Arr objects',
    url: '/managed',
    icon: Boxes,
    match: (path: string) => path.startsWith('/managed'),
  },
  {
    title: 'Subtitle sources',
    url: '/sites',
    icon: Globe,
    match: (path: string) => path.startsWith('/sites'),
  },
  {
    title: 'Settings',
    url: '/config',
    icon: Settings,
    match: (path: string) => path.startsWith('/config'),
  },
];

export function AppSidebar() {
  const location = useLocation();

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-1.5">
          <div className="text-sm font-semibold tracking-tight">Warrden</div>
          <div className="text-xs text-muted-foreground">Housekeeping for Sonarr &amp; Radarr</div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton isActive={item.match(location.pathname)} render={<Link to={item.url} />}>
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
