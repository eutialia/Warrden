import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import { fetchJobs, type Job, type Overview as OverviewData } from '@/api';
import { ActivityList } from '@/components/activity/ActivityList';
import { TargetDrawer } from '@/components/activity/TargetDrawer';
import { PageHeader } from '@/components/PageHeader';
import { StatBand, StatTile } from '@/components/StatTile';
import { StatusNotice } from '@/components/StatusNotice';
import { StorageHealth, storageProblems } from '@/components/StorageHealth';
import { StatusDot } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useOverview } from '@/hooks/useOverview';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { foldJobsByTarget } from '@/lib/jobs';
import { storageStatusLabel, storageStatusTone } from '@/lib/labels';
import { TONE_SOFT, TONE_TEXT, type Tone } from '@/lib/tone';
import { cn, formatUsage } from '@/lib/utils';

const RECENT_JOBS = 40;

interface Verdict {
  tone: Tone;
  headline: string;
  detail: string;
  /** The one thing to do about it. Always the fix for the headline, never a
   * generic call to action that sends you somewhere unrelated. */
  action?: { label: string; to: string };
}

/**
 * The one sentence the home screen exists to produce. Ordered by how much a human
 * needs to act: a missing storage path stops all filesystem work, a review backlog is
 * waiting on a decision, a suspect path is producing quiet nothing, failures are
 * informational after the fact.
 */
function verdictOf(data: OverviewData): Verdict {
  const storage = storageProblems(data.storage);
  if (storage.missing > 0) {
    return {
      tone: 'danger',
      headline: `${storage.missing} storage ${storage.missing === 1 ? 'path is' : 'paths are'} unreachable`,
      detail: 'Warrden pauses filesystem work until the paths come back. Check the paths under Settings, Storage.',
      action: { label: 'Check storage', to: '/config#storage' },
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
  if (storage.suspect > 0) {
    return {
      tone: 'warning',
      headline: `${storage.suspect} storage ${storage.suspect === 1 ? 'path needs' : 'paths need'} a look`,
      detail:
        'Warrden is still working, but a path is either an empty directory where a share should be, or one it cannot read.',
      action: { label: 'Check storage', to: '/config#storage' },
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
    detail: 'Nothing needs review, the queue is empty, and every storage path is reachable.',
  };
}

export default function Overview() {
  const { data, error, loading, refetch } = useOverview();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openGroup = useMemo(() => {
    if (openKey === null) return null;
    return foldJobsByTarget(jobs).find((g) => g.key === openKey) ?? null;
  }, [jobs, openKey]);

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
  // Only worth saying once a week's worth of jobs have actually finished. "100%
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
        description="Warrden at a glance: what it is working on, what it finished, and anything it could not decide alone."
      />
      {error && <StatusNotice message={error} onRetry={refetch} />}

      {/* The verdict. One sentence, sized so it is readable across a room, in the
          serif that carries every title. The tone lives in the icon badge rather
          than an accent rail. The eye goes to the icon anyway, so a rail would
          only repeat it. */}
      <div className="flex flex-wrap items-center gap-4 empty:hidden">
        {/* Skeletons only while a request is genuinely in flight. If it failed there is
            no verdict to give and the notice above already says why. Leaving the
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
          storage panel sits beside it rather than under it. */}
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
                actually answered. Before that, the truth is unknown. */}
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
              <ActivityList jobs={jobs} dense limit={5} onOpen={(g) => setOpenKey(g.key)} />
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
              <StorageHealth checks={data?.storage ?? []} />
            </CardAction>
          </CardHeader>
          <CardContent className="[&>*]:border-t [&>*:last-child]:border-b">
            {loading && <Skeleton className="h-24 w-full" />}
            {data?.storage.map((check) => (
              <div key={check.id} className="flex items-center gap-3 py-2.5">
                <StatusDot tone={storageStatusTone(check.status)} />
                {/* A disabled role has no path, and a row identified only by its path is
                    then an anonymous blank line. The label always names the library. */}
                <span className="shrink-0 text-xs text-muted-foreground">{check.label}</span>
                <code className="min-w-0 flex-1 truncate text-xs">{check.path}</code>
                {/* Capacity when storage can answer, its problem when it can't. The
                    right-hand column always says the most useful thing it has. */}
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

      <TargetDrawer group={openGroup} onClose={() => setOpenKey(null)} />
    </div>
  );
}
