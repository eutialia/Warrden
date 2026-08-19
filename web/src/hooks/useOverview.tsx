import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiErrorMessage, fetchOverview, type Overview } from '@/api';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';

interface OverviewState {
  data: Overview | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
  setDebugEnabled: (enabled: boolean) => void;
}

const OverviewContext = createContext<OverviewState | null>(null);

/**
 * One shared `/api/overview` subscription for the whole shell. The sidebar's review
 * badge and the home screen both read these counts, and a second independent
 * poller would double the request rate for identical data.
 */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchOverview()
      .then((res) => {
        if (isStale()) return;
        setData(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load status'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);

  useSseRefetch(refetch);
  useEffect(refetch, [refetch]);

  const setDebugEnabled = useCallback((enabled: boolean) => {
    setData((prev) => (prev ? { ...prev, debugEnabled: enabled } : prev));
  }, []);

  const value = useMemo(
    () => ({ data, error, loading, refetch, setDebugEnabled }),
    [data, error, loading, refetch, setDebugEnabled],
  );

  return <OverviewContext value={value}>{children}</OverviewContext>;
}

export function useOverview(): OverviewState {
  const ctx = use(OverviewContext);
  if (!ctx) throw new Error('useOverview must be used inside <OverviewProvider>');
  return ctx;
}
