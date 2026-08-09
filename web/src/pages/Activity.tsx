import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, Search } from 'lucide-react';
import { apiErrorMessage, fetchJobs, type Job, type JobStatus } from '@/api';
import { AcquireOutcomeBadge, PipelineBadge, StatusBadge } from '@/components/StatusBadge';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { jobDuration, jobTitle } from '@/lib/jobs';
import { jobStatusLabel, pipelineLabel, targetKindLabel } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 50;
const PIPELINES = ['acquire', 'ingest', 'subtitle'] as const;
const STATUSES: JobStatus[] = ['running', 'pending', 'done', 'failed'];

const ALL = 'all';

// base-ui renders the raw value in a select trigger unless the root gets a
// value→label map.
const PIPELINE_ITEMS: Record<string, string> = {
  [ALL]: 'All work',
  ...Object.fromEntries(PIPELINES.map((p) => [p, pipelineLabel(p)])),
};
const STATUS_ITEMS: Record<string, string> = {
  [ALL]: 'Any status',
  ...Object.fromEntries(STATUSES.map((s) => [s, jobStatusLabel(s)])),
};

export default function Activity() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pipeline, setPipeline] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const navigate = useNavigate();

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

  // Filtering is client-side over the fetched window: the API returns a bounded
  // list already, and a homelab's job history is small enough that a round-trip
  // per keystroke would be the slower option.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (pipeline !== ALL && job.pipeline !== pipeline) return false;
      if (status !== ALL && job.status !== status) return false;
      if (!needle) return true;
      return `${jobTitle(job)} ${job.arr_instance}`.toLowerCase().includes(needle);
    });
  }, [jobs, query, pipeline, status]);

  const filtered = query.trim() !== '' || pipeline !== ALL || status !== ALL;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="Every job Warrden has run — finding releases, cleaning up imports, and fetching subtitles. Select a row for the full story."
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
        <Select items={PIPELINE_ITEMS} value={pipeline} onValueChange={(v) => setPipeline(v ?? ALL)}>
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
        <Select items={STATUS_ITEMS} value={status} onValueChange={(v) => setStatus(v ?? ALL)}>
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

      <Card className="overflow-hidden py-0">
        <CardContent className="p-0">
          {loading && jobs.length === 0 ? (
            <div className="space-y-3 p-4">
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
                <EmptyTitle>{filtered ? 'No jobs match those filters' : 'No jobs yet'}</EmptyTitle>
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
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Title</TableHead>
                  <TableHead className="w-40">Work</TableHead>
                  <TableHead className="w-56">Status</TableHead>
                  <TableHead className="w-20 text-right">Took</TableHead>
                  <TableHead className="w-28 text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((job) => (
                  <TableRow key={job.id} className="cursor-pointer" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <TableCell>
                      <div className="font-medium">{jobTitle(job)}</div>
                      <div className="text-xs text-muted-foreground">
                        {job.arr_instance} · {targetKindLabel(job.target_kind)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <PipelineBadge pipeline={job.pipeline} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={job.status} />
                        <AcquireOutcomeBadge outcome={job.acquireOutcome} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {jobDuration(job) ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger render={<span>{formatRelativeTime(job.updated_at)}</span>} />
                        <TooltipContent>{new Date(job.updated_at).toLocaleString()}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Only offered when the server actually filled the window — otherwise there is
          demonstrably nothing more to fetch. */}
      {jobs.length >= limit && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Load older jobs
          </Button>
        </div>
      )}
    </div>
  );
}
