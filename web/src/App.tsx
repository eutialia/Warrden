import { ThemeProvider } from 'next-themes';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppHeader } from '@/components/AppHeader';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { OverviewProvider } from '@/hooks/useOverview';
import Activity from '@/pages/Activity';
import Attention from '@/pages/Attention';
import ConfigPage from '@/pages/Config';
import JobDetail from '@/pages/JobDetail';
import ManagedObjects from '@/pages/ManagedObjects';
import NotFound from '@/pages/NotFound';
import Overview from '@/pages/Overview';
import Sites from '@/pages/Sites';

export default function App() {
  return (
    // Dark by default: Warrden sits alongside the arrs in a media stack, which are
    // dark-first, and it is usually left open on a wall display or second monitor.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <BrowserRouter>
        <OverviewProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader />
              <main className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">
                <div className="mx-auto w-full max-w-7xl">
                  <Routes>
                    <Route path="/" element={<Overview />} />
                    <Route path="/activity" element={<Activity />} />
                    <Route path="/attention" element={<Attention />} />
                    <Route path="/jobs/:id" element={<JobDetail />} />
                    <Route path="/managed" element={<ManagedObjects />} />
                    <Route path="/sites" element={<Sites />} />
                    <Route path="/config" element={<ConfigPage />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </div>
              </main>
            </SidebarInset>
          </SidebarProvider>
        </OverviewProvider>
        <Toaster />
      </BrowserRouter>
    </ThemeProvider>
  );
}
