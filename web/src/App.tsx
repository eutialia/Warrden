import { useEffect } from 'react';
import { ThemeProvider } from 'next-themes';
import { BrowserRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchJob } from '@/api';
import { AppHeader } from '@/components/AppHeader';
import { AppSidebar } from '@/components/AppSidebar';
import { DebugFrame } from '@/components/DebugFrame';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { OverviewProvider } from '@/hooks/useOverview';
import { jobTargetKey } from '@/lib/jobs';
import { cn } from '@/lib/utils';
import Activity from '@/pages/Activity';
import Attention from '@/pages/Attention';
import ConfigPage from '@/pages/Config';
import DebugPage from '@/pages/Debug';
import ManagedObjects from '@/pages/ManagedObjects';
import NotFound from '@/pages/NotFound';
import Overview from '@/pages/Overview';
import Sites from '@/pages/Sites';

/** Needs review still links by job id, and bookmarks exist. Fetch the job, fold it
 * into the target key the drawer already understands, then replace this URL so
 * back does not restage the hop. A missing job goes to the list, not an error. */
function JobRedirect() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      navigate('/activity', { replace: true });
      return;
    }
    fetchJob(id)
      .then((result) => {
        if (cancelled) return;
        const key = jobTargetKey(result.job);
        navigate(`/activity?target=${encodeURIComponent(key)}&run=${id}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        navigate('/activity', { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  return <Skeleton className="h-40 w-full" />;
}

/** Debug is the one page that earns the whole viewport: four regions side by side. */
function Shell() {
  const wide = useLocation().pathname.startsWith('/debug');
  return (
    <main className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <div className={cn('mx-auto w-full', !wide && 'max-w-7xl')}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/attention" element={<Attention />} />
          <Route path="/jobs/:id" element={<JobRedirect />} />
          <Route path="/managed" element={<ManagedObjects />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/debug" element={<DebugPage />} />
          <Route path="/debug/:jobId" element={<DebugPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </main>
  );
}

export default function App() {
  return (
    // Dark by default: Warrden sits alongside the arrs in a media stack, which are
    // dark-first, and it is usually left open on a wall display or second monitor.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <BrowserRouter>
        <OverviewProvider>
          <DebugFrame />
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader />
              <Shell />
            </SidebarInset>
          </SidebarProvider>
        </OverviewProvider>
        <Toaster />
      </BrowserRouter>
    </ThemeProvider>
  );
}
