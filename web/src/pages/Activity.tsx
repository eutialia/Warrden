import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ListChecks, Search } from 'lucide-react';
import { apiErrorMessage, fetchJobs, type Job, type JobStatus } from '@/api';
import { AcquireOutcomeBadge, StatusBadge } from '@/components/StatusBadge';
import { PageHeader } from '@/components/PageHeader';
import { SectionStack } from '@/components/SectionStack';
import { StatusNotice } from '@/components/StatusNotice';
import { ToneBadge } from '@/components/ToneBadge';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { foldJobsByTarget, groupJobsByDay, jobDuration, jobTitle, type JobTargetGroup } from '@/lib/jobs';
import { jobRunLineStatus, jobStatusLabel, pipelineLabel, targetKindLabel } from '@/lib/labels';
import { TONE_TEXT } from '@/lib/tone';
import { cn, formatTimeOfDay } from '@/lib/utils';

const PAGE_SIZE = 50;
const PIPELINES = ['acquire', 'ingest', 'subtitle'] as const;
const STATUSES: JobStatus[] = ['running', 'pending', 'done', 'failed'];

const ALL = 'all';

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
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (pipeline !== ALL && job.pipeline !== pipeline) return false;
      if (status !== ALL && job.status !== status) return false;
      if (!needle) return true;
      return `${jobTitle(job)} ${job.arr_instance}`.toLowerCase().includes(needle);
    });
  }, [jobs, query, pipeline, status]);

  const days = useMemo(() => groupJobsByDay(visible), [visible]);
  const filtered = query.trim() !== '' || pipeline !== ALL || status !== ALL;

  function toggleKey(key: string): void {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="Every title Warrden has touched. Expand a row for the individual runs."
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
          <SectionStack>
            {days.map((day) => {
              const groups = foldJobsByTarget(day.jobs);
              return (
                <div key={day.key}>
                  <div className="flex items-baseline justify-between gap-4">
                    <h2 className="font-serif text-xl">{day.label}</h2>
                    <span className="text-xs text-muted-foreground">
                      {groups.length} title{groups.length === 1 ? '' : 's'} · {day.jobs.length} run
                      {day.jobs.length === 1 ? '' : 's'}
                      {day.failed > 0 ? ` · ${day.failed} failed` : ''}
                    </span>
                  </div>
                  <Table className="mt-3">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-16">Time</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead className="w-56">Status</TableHead>
                        <TableHead className="w-20 text-right">Took</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {groups.map((group) => (
                        <TargetRows
                          key={group.key}
                          group={group}
                          open={openKeys.has(group.key)}
                          onToggle={() => toggleKey(group.key)}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              );
            })}
          </SectionStack>
        )}
      </div>

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

function TargetRows({
  group,
  open,
  onToggle,
}: {
  group: JobTargetGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const { latest, runs, failed } = group;
  return (
    <>
      <TableRow
        className="cursor-pointer"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
          <Tooltip>
            <TooltipTrigger render={<span>{formatTimeOfDay(latest.updated_at)}</span>} />
            <TooltipContent>{new Date(latest.updated_at).toLocaleString()}</TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="whitespace-normal">
          <div className="flex items-center gap-1.5 font-medium">
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-90' : 'rotate-0')}
            />
            <span>{jobTitle(latest)}</span>
            <span className="font-normal text-muted-foreground">
              · {runs.length} run{runs.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="pl-5 text-xs text-muted-foreground">
            {latest.arr_instance} · {targetKindLabel(latest.target_kind)} · #{latest.target_id}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={latest.status} />
            {latest.acquireOutcome && <AcquireOutcomeBadge outcome={latest.acquireOutcome} />}
            {failed && latest.status !== 'failed' && <ToneBadge tone="danger">Has a failure</ToneBadge>}
          </div>
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
          {jobDuration(latest) ?? '—'}
        </TableCell>
      </TableRow>
      {open &&
        runs.map((job) => {
          const line = jobRunLineStatus(job);
          return (
            <TableRow key={job.id} className="relative cursor-pointer [transform:translateZ(0)] hover:bg-muted/30">
              <TableCell className="py-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                {formatTimeOfDay(job.updated_at)}
              </TableCell>
              <TableCell className="py-0.5 pl-5">
                <Link to={`/jobs/${job.id}`} className="text-sm after:absolute after:inset-0 hover:underline">
                  {pipelineLabel(job.pipeline)}{' '}
                  <span className="text-muted-foreground">#{job.id}</span>
                </Link>
              </TableCell>
              <TableCell className={cn('py-0.5 text-sm', TONE_TEXT[line.tone])}>{line.label}</TableCell>
              <TableCell className="py-0.5 text-right text-xs text-muted-foreground tabular-nums">
                {jobDuration(job) ?? '—'}
              </TableCell>
            </TableRow>
          );
        })}
    </>
  );
}
