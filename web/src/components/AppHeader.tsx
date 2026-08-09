import { useLocation } from 'react-router-dom';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';

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
 * The shell's top bar: where you are, and the theme control.
 *
 * Deliberately carries no connection or health indicator. Warrden's own status is
 * not something this page can honestly report — you are only ever reading it when
 * it works — and the state of the apps Warrden talks to is not something an
 * operator acts on from here. Data freshness is handled in `useSseRefetch`
 * instead, silently.
 */
export function AppHeader() {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <h1 className="text-sm font-medium">{sectionTitle(location.pathname)}</h1>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
