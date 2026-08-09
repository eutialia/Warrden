import { useLocation } from 'react-router-dom';
import { StatusDot } from '@/components/ToneBadge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOverview } from '@/hooks/useOverview';

const SECTION_TITLES: { prefix: string; title: string }[] = [
  { prefix: '/activity', title: 'Activity' },
  { prefix: '/jobs/', title: 'Activity' },
  { prefix: '/attention', title: 'Needs review' },
  { prefix: '/sites', title: 'Subtitle sources' },
  { prefix: '/managed', title: 'Arr objects' },
  { prefix: '/config', title: 'Settings' },
];

function sectionTitle(pathname: string): string {
  if (pathname === '/') return 'Overview';
  return SECTION_TITLES.find((s) => pathname.startsWith(s.prefix))?.title ?? 'Warrden';
}

/**
 * The shell's top bar. It used to hold nothing but the sidebar toggle; now it
 * carries where-am-I, whether the live stream is actually live, and the theme
 * control — the three things that belong on every page rather than one.
 */
export function AppHeader() {
  const location = useLocation();
  const { disconnected } = useOverview();

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <h1 className="text-sm font-medium">{sectionTitle(location.pathname)}</h1>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground">
                <StatusDot tone={disconnected ? 'warning' : 'success'} pulse={!disconnected} />
                <span className="hidden sm:inline">{disconnected ? 'Reconnecting' : 'Live'}</span>
              </span>
            }
          />
          <TooltipContent>
            {disconnected
              ? 'Lost the live update stream — retrying automatically.'
              : 'Receiving live updates from Warrden.'}
          </TooltipContent>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  );
}
