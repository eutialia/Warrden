import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import Activity from '@/pages/Activity';
import Attention from '@/pages/Attention';
import ConfigPage from '@/pages/Config';
import JobDetail from '@/pages/JobDetail';
import NotFound from '@/pages/NotFound';

export default function App() {
  return (
    <BrowserRouter>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex items-center gap-2 border-b p-3">
            <SidebarTrigger />
          </header>
          <main className="p-6">
            <Routes>
              <Route path="/" element={<Activity />} />
              <Route path="/attention" element={<Attention />} />
              <Route path="/jobs/:id" element={<JobDetail />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </BrowserRouter>
  );
}
