import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import { fetchJobs, type Job, type Overview as OverviewData } from '@/api';
import { MountHealth, unreachableMounts } from '@/components/MountHealth';
import { PageHeader } from '@/components/PageHeader';
import { StatBand, StatTile } from '@/components/StatTile';
import { StatusBadge, PipelineBadge } from '@/components/StatusBadge';
import { StatusNotice } from '@/components/StatusNotice';
import { StatusDot } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useOverview } from '@/hooks/useOverview';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { jobTitle } from '@/lib/jobs';
import { storageStatusLabel, storageStatusTone, targetKindLabel } from '@/lib/labels';
import { TONE_SOFT, TONE_TEXT, type Tone } from '@/lib/tone';
import { cn, formatElapsed, formatUsage } from '@/lib/utils';

const RECENT_JOBS = 6;

interface Verdict {
  tone: Tone;
  headline: string;
  detail: string;
  /** The one thing to do about it — always the fix for the headline, never a
   * generic call to action that sends you somewhere unrelated. */
  action?: { label: string; to: string };
}

/**
 * The one sentence the home screen exists to produce. Ordered by how much a human
 * needs to act: a broken mount stops all filesystem work, a review backlog is
 * waiting on a decision, failures are informational after the fact.
 */
function verdictOf(data: OverviewData): Verdict {
  const bad = unreachableMounts(data.storage);
  if (bad > 0) {
    return {
      tone: 'danger',
      headline: `${bad} storage ${bad === 1 ? 'mount is' : 'mounts are'} unreachable`,
      detail: 'Warrden pauses filesystem work until the mounts come back. Check the container bind mounts.',
      action: { label: 'Check mounts', to: '/config#storage' },
    };
  }
  if (data.attention.open > 0) {
    return {
      tone: 'warning',
      headline: `${data.attention.open} ${data.attention.open === 1 ? 'thing needs' : 'things need'} your review`,
      detail: 'Warrden stopped short of deciding these on its own.',
      action: { label: 'Review now', to: '/attention' },
    };
  }
  if (data.jobs.running > 0 || data.jobs.pending > 0) {
    return {
      tone: 'info',
      headline: 'Working through the queue',
      detail: `${data.jobs.running} running, ${data.jobs.pending} waiting.`,
    };
  }
  if (data.jobs.failedRecent > 0) {
    return {
      tone: 'warning',
      headline: `${data.jobs.failedRecent} ${data.jobs.failedRecent === 1 ? 'job' : 'jobs'} failed in the last day`,
      detail: 'Nothing is waiting on you, but the failures are worth a look.',
      action: { label: 'See failures', to: '/activity' },
    };
  }
  return {
    tone: 'success',
    headline: 'Everything is running clean',
    detail: 'Nothing needs review, the queue is empty, and every mount is reachable.',
  };
}

export default function Overview() {
  const { data, error, loading, refetch } = useOverview();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);

  const beginFetch = useFetchGeneration();
  const loadJobs = useCallback(() => {
    const isStale = beginFetch();
    fetchJobs(RECENT_JOBS)
      .then((j) => {
        if (!isStale()) setJobs(j);
      })
      .catch(() => {
        // The tiles above already surface load failures; a silent recent-jobs list
        // is better than two error banners for one outage.
      })
      .finally(() => {
        if (!isStale()) setJobsLoaded(true);
      });
  }, [beginFetch]);
  useSseRefetch(loadJobs);
  useEffect(loadJobs, [loadJobs]);

  const verdict = data ? verdictOf(data) : null;
  const inFlight = (data?.jobs.running ?? 0) + (data?.jobs.pending ?? 0);
  const placed = (data?.placed.subtitle ?? 0) + (data?.placed.audio ?? 0);
  // Only worth saying once a week's worth of jobs have actually finished — "100%
  // clean" out of nothing finished is a lie of omission.
  const weekTotal = (data?.week.done ?? 0) + (data?.week.failed ?? 0);
  // Floored, never rounded up: 1999 of 2000 must not read as "100% clean" beside a
  // failure count that says otherwise.
  const cleanRate =
    weekTotal > 0 ? `${Math.floor(((data?.week.done ?? 0) / weekTotal) * 1000) / 10}% clean over 7 days` : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Warrden at a glance — what it is working on, what it finished, and anything it could not decide alone."
      />
      {error && <StatusNotice message={error} onRetry={refetch} />}

      {/* The verdict. One sentence, sized so it is readable across a room, in the
          serif that carries every title. The tone lives in the icon badge rather
          than an accent rail — the eye goes to the icon anyway, so a rail would
          only repeat it. */}
      <div className="flex flex-wrap items-center gap-4 empty:hidden">
        {/* Skeletons only while a request is genuinely in flight. If it failed there is
            no verdict to give and the notice above already says why — leaving the
            skeleton up would promise an answer that is never coming. */}
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-80" />
          </div>
        ) : !verdict ? null : (
          <>
            <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full border', TONE_SOFT[verdict.tone])}>
              {verdict.tone === 'success' ? (
                <CheckCircle2 className="size-5" />
              ) : verdict.tone === 'info' ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <TriangleAlert className="size-5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-serif text-xl leading-snug">{verdict.headline}</p>
              <p className="text-sm text-muted-foreground">{verdict.detail}</p>
            </div>
            {verdict.action && (
              <Button render={<Link to={verdict.action.to} />}>
                {verdict.action.label}
                <ArrowRight />
              </Button>
            )}
          </>
        )}
      </div>

      <StatBand>
        <StatTile
          label="Needs review"
          value={data?.attention.open ?? 0}
          hint={data ? (data.attention.open ? 'Waiting on a decision' : 'Queue is clear') : undefined}
          tone={data && data.attention.open > 0 ? 'warning' : 'neutral'}
          to="/attention"
          loading={loading}
        />
        <StatTile
          label="In flight"
          value={inFlight}
          hint={data ? `${data.jobs.running} running · ${data.jobs.pending} waiting` : undefined}
          tone={inFlight > 0 ? 'info' : 'neutral'}
          to="/activity"
          loading={loading}
        />
        <StatTile
          label="Failed, 24h"
          value={data?.jobs.failedRecent ?? 0}
          hint={cleanRate ?? (data ? `${data.jobs.doneRecent} finished cleanly` : undefined)}
          tone={data && data.jobs.failedRecent > 0 ? 'danger' : 'neutral'}
          to="/activity"
          loading={loading}
        />
        <StatTile
          label="Files delivered"
          value={placed}
          hint={data ? 'Subtitles and audio, last 7 days' : undefined}
          loading={loading}
        />
      </StatBand>

      {/* The queue reads as the page's subject, so it takes the wide column and the
          mounts sit beside it rather than under it. */}
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Latest activity</CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link to="/activity" />}>
                See all
                <ArrowRight />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {/* "Nothing yet" is a claim about the queue, so it waits until a request has
                actually answered — before that the truth is simply unknown. */}
            {!jobsLoaded ? (
              <div className="space-y-3 border-t py-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <p className="border-t py-6 text-sm text-muted-foreground">
                Nothing yet. Add a series or movie in Sonarr/Radarr and Warrden will pick it up.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Title</TableHead>
                    <TableHead className="w-36">Work</TableHead>
                    <TableHead className="w-32">State</TableHead>
                    <TableHead className="w-16 text-right">Age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    // The whole row is the hit area, but the link is a real link: a row
                    // with an onClick can't be tabbed to, opened in a new tab, or copied.
                    <TableRow key={job.id} className="relative cursor-pointer">
                      <TableCell className="max-w-0">
                        <Link to={`/jobs/${job.id}`} className="truncate font-medium after:absolute after:inset-0">
                          {jobTitle(job)}
                        </Link>
                        <div className="truncate text-xs text-muted-foreground">
                          {job.arr_instance} · {targetKindLabel(job.target_kind)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <PipelineBadge pipeline={job.pipeline} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={job.status} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                        {formatElapsed(job.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" />
              Storage
            </CardTitle>
            <CardAction>
              <MountHealth checks={data?.storage ?? []} />
            </CardAction>
          </CardHeader>
          <CardContent className="[&>*]:border-t [&>*:last-child]:border-b">
            {loading && <Skeleton className="h-24 w-full" />}
            {data?.storage.map((check) => (
              <div key={check.id} className="flex items-center gap-3 py-2.5">
                <StatusDot tone={storageStatusTone(check.status)} />
                <code className="min-w-0 flex-1 truncate text-xs">{check.path}</code>
                {/* Capacity when the mount can answer, its problem when it can't —
                    the right-hand column always says the most useful thing it has. */}
                <span
                  className={cn(
                    'shrink-0 font-mono text-xs',
                    check.usage ? 'text-muted-foreground' : cn('font-medium', TONE_TEXT[storageStatusTone(check.status)]),
                  )}
                >
                  {check.usage ? formatUsage(check.usage) : storageStatusLabel(check.status)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* What the day consisted of. The band above counts what is outstanding; this
            counts what went through, which is the only way to tell a quiet Warrden
            from a stopped one. */}
        <Card>
          <CardHeader>
            <CardTitle>Last 24 hours</CardTitle>
          </CardHeader>
          <CardContent className="[&>*]:border-t [&>*:last-child]:border-b">
            {loading && <Skeleton className="h-24 w-full" />}
            {data &&
              (
                [
                  ['Webhooks handled', data.recent.webhooks],
                  ['Releases refined', data.recent.refined],
                  ['Subtitles placed', data.recent.subtitles],
                  ['Escalated to you', data.recent.escalated],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono tabular-nums">{value.toLocaleString()}</span>
                </div>
              ))}
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  );
}
