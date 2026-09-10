import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListChecks, Search } from 'lucide-react';
import { apiErrorMessage, fetchJobs, type Job } from '@/api';
import { ActivityList } from '@/components/activity/ActivityList';
import { TargetDrawer } from '@/components/activity/TargetDrawer';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { ALL, filterJobs, foldJobsByTarget, JOB_WINDOW, PHASES, STATUSES, type TargetGroup } from '@/lib/jobs';
import { jobStatusLabel, pipelineLabel } from '@/lib/labels';

const PAGE_SIZE = 50;

const PIPELINE_ITEMS: Record<string, string> = {
  [ALL]: 'All work',
  ...Object.fromEntries(PHASES.map((p) => [p, pipelineLabel(p)])),
};
const STATUS_ITEMS: Record<string, string> = {
  [ALL]: 'Any status',
  ...Object.fromEntries(STATUSES.map((s) => [s, jobStatusLabel(s)])),
};

function parseRunId(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default function Activity() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [userLimit, setUserLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pipeline, setPipeline] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [searchParams, setSearchParams] = useSearchParams();
  const [widenedForTarget, setWidenedForTarget] = useState<string | null>(null);

  // The bookmark's wide window is not the operator's "Load older jobs"
  // count. Deriving keeps closing the drawer from leaving every SSE refetch
  // at 1000, without throwing away a limit they chose themselves.
  const targetParam = searchParams.get('target');
  const widened = targetParam !== null && widenedForTarget === targetParam;
  const limit = widened ? JOB_WINDOW : userLimit;

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchJobs(limit)
      .then((j) => {
        if (isStale()) return;
        setJobs(j);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load jobs'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch, limit]);

  useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  const visible = useMemo(() => filterJobs(jobs, { query, pipeline, status }), [jobs, query, pipeline, status]);

  const filtered = query.trim() !== '' || pipeline !== ALL || status !== ALL;

  // Resolve against the unfiltered window so a deep link still opens after the
  // list is narrowed, and so the drawer shows every run for that target.
  // A stale `run` is ignored: a job can be pruned while a link to it survives,
  // and the drawer should still open at its default phase. An unknown `target`
  // opens nothing.
  const openGroup = useMemo(() => {
    const target = searchParams.get('target');
    if (!target) return null;
    return foldJobsByTarget(jobs).find((g) => g.key === target) ?? null;
  }, [jobs, searchParams]);

  // A /jobs/:id redirect or bookmark can name a job older than the newest 50.
  // Widen once after the first window comes back empty for that target. Skip when
  // the window was not full (the server had nothing more) or we already tried this
  // target, so a missing job cannot loop.
  useEffect(() => {
    if (loading) return;
    const target = searchParams.get('target');
    if (!target || openGroup || widenedForTarget === target || jobs.length < limit) return;
    setWidenedForTarget(target);
  }, [loading, searchParams, openGroup, widenedForTarget, jobs.length, limit]);

  const runId = parseRunId(searchParams.get('run'));

  const onOpen = useCallback(
    (group: TargetGroup) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('target', group.key);
        next.delete('run');
        return next;
      });
    },
    [setSearchParams],
  );

  const onClose = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('target');
      next.delete('run');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="One row per title, covering every find, import, and subtitle run. Select a row for the full story."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search by title or instance…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={pipeline} onValueChange={(v) => setPipeline(v ?? ALL)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PIPELINE_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v ?? ALL)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <StatusNotice message={error} onRetry={refetch} />}

      <div>
        {loading && jobs.length === 0 ? (
          <div className="space-y-3 py-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListChecks />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No titles match those filters' : 'No activity yet'}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'Try widening the search or clearing the filters.'
                  : 'Add a series or movie in Sonarr/Radarr, or wait for the next import to land.'}
              </EmptyDescription>
            </EmptyHeader>
            {filtered && (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setPipeline(ALL);
                    setStatus(ALL);
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ActivityList jobs={visible} onOpen={onOpen} />
        )}
      </div>

      {/* Only offered when the server actually filled the window. Otherwise there is
          demonstrably nothing more to fetch. */}
      {jobs.length >= limit && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setUserLimit((n) => n + PAGE_SIZE)}>
            Load older jobs
          </Button>
        </div>
      )}

      <TargetDrawer group={openGroup} runId={runId} onClose={onClose} />
    </div>
  );
}
