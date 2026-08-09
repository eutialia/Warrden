import { Boxes, Globe, LayoutDashboard, ListChecks, Settings, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useOverview } from '@/hooks/useOverview';
import { cn } from '@/lib/utils';

interface NavItem {
  title: string;
  url: string;
  icon: typeof LayoutDashboard;
  match: (path: string) => boolean;
}

/** Two groups, because the pages split cleanly into "what is happening" and
 * "what is set up" — a flat list of five gave no such hint. */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Monitor',
    items: [
      { title: 'Overview', url: '/', icon: LayoutDashboard, match: (p) => p === '/' },
      {
        title: 'Activity',
        url: '/activity',
        icon: ListChecks,
        match: (p) => p.startsWith('/activity') || p.startsWith('/jobs/'),
      },
      { title: 'Needs review', url: '/attention', icon: TriangleAlert, match: (p) => p.startsWith('/attention') },
    ],
  },
  {
    label: 'Manage',
    items: [
      { title: 'Subtitle sources', url: '/sites', icon: Globe, match: (p) => p.startsWith('/sites') },
      { title: 'Arr objects', url: '/managed', icon: Boxes, match: (p) => p.startsWith('/managed') },
      { title: 'Settings', url: '/config', icon: Settings, match: (p) => p.startsWith('/config') },
    ],
  },
];

export function AppSidebar() {
  const location = useLocation();
  const { data } = useOverview();
  const openReview = data?.attention.open ?? 0;

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <ShieldCheck className="size-4.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">Warrden</div>
            <div className="truncate text-xs text-muted-foreground">Housekeeping for Sonarr &amp; Radarr</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const showBadge = item.url === '/attention' && openReview > 0;
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton isActive={item.match(location.pathname)} render={<Link to={item.url} />}>
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {/* The review queue replaces notifications, so its backlog has to be
                          visible from every page rather than only once you navigate there. */}
                      {showBadge && (
                        <SidebarMenuBadge
                          className={cn(
                            'bg-warning-muted text-warning-foreground border border-warning-border',
                            'pointer-events-none tabular-nums',
                          )}
                        >
                          {openReview > 99 ? '99+' : openReview}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
