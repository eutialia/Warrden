import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, FileDown, Globe, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import { fetchJobs, type Job, type Overview as OverviewData } from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatTile } from '@/components/StatTile';
import { StatusBadge, PipelineBadge } from '@/components/StatusBadge';
import { StatusNotice } from '@/components/StatusNotice';
import { StatusDot, ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useOverview } from '@/hooks/useOverview';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { jobTitle } from '@/lib/jobs';
import { storageStatusLabel, storageStatusTone } from '@/lib/labels';
import { TONE_SOFT, TONE_TEXT, type Tone } from '@/lib/tone';
import { cn, formatRelativeTime } from '@/lib/utils';

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
  const badMounts = data.storage.filter((c) => c.status !== 'ok');
  if (badMounts.length > 0) {
    return {
      tone: 'danger',
      headline: `${badMounts.length} storage ${badMounts.length === 1 ? 'mount is' : 'mounts are'} unreachable`,
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
  const { data, error, loading, refetch, disconnected, reconnect } = useOverview();
  const [jobs, setJobs] = useState<Job[]>([]);

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
      });
  }, [beginFetch]);
  useSseRefetch(loadJobs);
  useEffect(loadJobs, [loadJobs]);

  const verdict = data ? verdictOf(data) : null;
  const inFlight = (data?.jobs.running ?? 0) + (data?.jobs.pending ?? 0);
  const placed = (data?.placed.subtitle ?? 0) + (data?.placed.audio ?? 0);
  const badMounts = data?.storage.filter((c) => c.status !== 'ok').length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Warrden at a glance — what it is working on, what it finished, and anything it could not decide alone."
      />

      {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}
      {error && <StatusNotice message={error} onRetry={refetch} />}

      {/* The verdict banner. One sentence, sized so it is readable across a room.
          The tone lives in the icon badge rather than an accent rail — the eye goes
          to the icon anyway, so a rail would only repeat it. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          {loading || !verdict ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-64" />
              <Skeleton className="h-4 w-80" />
            </div>
          ) : (
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
                <p className="text-lg font-semibold tracking-tight">{verdict.headline}</p>
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
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Needs review"
          value={data?.attention.open ?? 0}
          hint={data?.attention.open ? 'Waiting on a decision' : 'Queue is clear'}
          icon={TriangleAlert}
          tone={data && data.attention.open > 0 ? 'warning' : 'neutral'}
          to="/attention"
          loading={loading}
        />
        <StatTile
          label="In flight"
          value={inFlight}
          hint={data ? `${data.jobs.running} running · ${data.jobs.pending} waiting` : undefined}
          icon={Loader2}
          tone={inFlight > 0 ? 'info' : 'neutral'}
          to="/activity"
          loading={loading}
        />
        <StatTile
          label="Failed today"
          value={data?.jobs.failedRecent ?? 0}
          hint={data ? `${data.jobs.doneRecent} finished cleanly` : undefined}
          icon={TriangleAlert}
          tone={data && data.jobs.failedRecent > 0 ? 'danger' : 'neutral'}
          to="/activity"
          loading={loading}
        />
        <StatTile
          label="Files delivered"
          value={placed}
          hint="Subtitles and audio, last 7 days"
          icon={FileDown}
          tone="neutral"
          loading={loading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Storage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" />
              Storage mounts
            </CardTitle>
            {data && (
              <CardAction>
                <ToneBadge tone={badMounts > 0 ? 'danger' : 'success'}>
                  {badMounts > 0 ? `${badMounts} unreachable` : 'All reachable'}
                </ToneBadge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="space-y-1">
            {loading && <Skeleton className="h-24 w-full" />}
            {data?.storage.map((check) => (
              <div key={check.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
                <StatusDot tone={storageStatusTone(check.status)} />
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 text-sm font-medium">{check.label}</span>
                  <code className="truncate text-xs text-muted-foreground">{check.path}</code>
                </div>
                <span className={cn('shrink-0 text-xs font-medium', TONE_TEXT[storageStatusTone(check.status)])}>
                  {storageStatusLabel(check.status)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Subtitle sources */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              Subtitle sources
            </CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link to="/sites" />}>
                Manage
                <ArrowRight />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {loading && <Skeleton className="h-16 w-full" />}
            {data && data.sites.known === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No sites configured yet — Warrden can't search for subtitles until one is added.
              </p>
            )}
            {data && data.sites.known > 0 && (
              <div className="flex items-baseline gap-6">
                <div>
                  <p className="text-2xl font-semibold tabular-nums">{data.sites.known}</p>
                  <p className="text-xs text-muted-foreground">configured</p>
                </div>
                <div>
                  <p
                    className={cn(
                      'text-2xl font-semibold tabular-nums',
                      data.sites.failing > 0 && TONE_TEXT.warning,
                    )}
                  >
                    {data.sites.failing}
                  </p>
                  <p className="text-xs text-muted-foreground">with recent failures</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
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
        <CardContent className="space-y-1">
          {jobs.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing yet. Add a series or movie in Sonarr/Radarr and Warrden will pick it up.
            </p>
          )}
          {jobs.map((job) => (
            <Link
              key={job.id}
              to={`/jobs/${job.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{jobTitle(job)}</span>
              <PipelineBadge pipeline={job.pipeline} />
              <StatusBadge status={job.status} />
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                {formatRelativeTime(job.updated_at)}
              </span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
