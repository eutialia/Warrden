import { useOverview } from '@/hooks/useOverview';

export function DebugFrame() {
  const { data } = useOverview();
  if (!data?.debugEnabled) return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-50 border-4 border-amber-500" aria-hidden />
      <div className="fixed bottom-2 left-1/2 z-50 -translate-x-1/2 rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-black shadow">
        Debug mode: everything is logged, including secrets. Performance may be impacted.
      </div>
    </>
  );
}
