import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, FileCheck2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchJob,
  postAcquire,
  type JobDetailResponse,
  type PlacedFileKind,
  type SubtitleRunRow,
  type TranscriptEntry,
} from '@/api';
import { AcquireOutcomeBadge, PipelineBadge, StatusBadge } from '@/components/StatusBadge';
import { StatusNotice } from '@/components/StatusNotice';
import { TierBadge } from '@/components/TierBadge';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { jobDuration, jobTitle } from '@/lib/jobs';
import { acquireOutcomeLabel, subtitleRunLabel, subtitleRunTone, targetKindLabel } from '@/lib/labels';
import { TONE_SOLID } from '@/lib/tone';
import { cn, formatRelativeTime } from '@/lib/utils';

// Same idea as ManagedObjects.tsx's own `KIND_LABEL` — a raw `PlacedFileKind` reads fine
// in a log line but not as dashboard copy.
const PLACED_FILE_KIND_LABEL: Record<PlacedFileKind, string> = {
  audio: 'Audio',
  subtitle: 'Subtitle',
};

/** One labelled fact in the job's summary grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * A site-search run as a vertical timeline. This is the most interesting thing the
 * dashboard has to show — the agent narrating its own navigation — so it gets a
 * rail, per-step timestamps, and room to breathe rather than a dense inline list.
 */
function TranscriptTimeline({ entries }: { entries: TranscriptEntry[] }): ReactNode {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No steps recorded yet.</p>;
  }
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {entries.map((entry, i) => (
        <li key={i} className="relative">
          <span
            className={cn(
              'absolute top-1.5 -left-[1.6rem] size-2 rounded-full ring-4 ring-card',
              TONE_SOLID[i === entries.length - 1 ? 'brand' : 'neutral'],
            )}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{entry.action}</span>
            <TierBadge tier={entry.tier} />
            <span className="ml-auto text-xs text-muted-foreground">{formatRelativeTime(entry.ts)}</span>
          </div>
          {entry.detail && <p className="mt-1 text-xs break-words text-muted-foreground">{entry.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repicking, setRepicking] = useState(false);

  const load = useCallback(
    (opts?: { isStale: () => boolean }) => {
      if (!id) return;
      fetchJob(id)
        .then((result) => {
          if (opts?.isStale()) return; // a newer request (route change, refetch) already landed
          setData(result);
          setError(null); // a transient failure must not stick once a later load succeeds
        })
        .catch((err: unknown) => {
          if (opts?.isStale()) return;
          setError(apiErrorMessage(err, 'Failed to load job'));
        });
    },
    [id],
  );

  // Guards the id-triggered load below against a newer one (a route change to a different
  // `:id`) landing first — same shared mechanism as Attention/ManagedObjects, in place of a
  // hand-rolled `let stale` ref. Only the id-effect's own call opts into this guard (as
  // before); the SSE-triggered call further down deliberately doesn't (see its own comment).
  const beginFetch = useFetchGeneration();

  useEffect(() => {
    // Called unconditionally, even when the new `id` is falsy — every id change (including
    // to no id at all) must invalidate whatever fetch a previous id kicked off, the same
    // way the old `let stale` ref's cleanup ran unconditionally on every effect re-run.
    const isStale = beginFetch();
    if (id) {
      setData(null);
      setError(null);
      load({ isStale });
    }
    // On unmount there's no "next effect run" to bump the generation the way an id change
    // does above — bump it here too, so a fetch that resolves after unmount is still
    // caught by isStale(), matching the old `stale = true` cleanup exactly.
    return () => {
      beginFetch();
    };
  }, [id, load, beginFetch]);

  // Any event can mean this job (or its acquire record) changed — refetch wholesale rather
  // than trying to reconcile individual fields. `debounceMs: 0` — unlike the list pages,
  // SSE traffic about one job is never a "burst" worth coalescing. `load()` is called with
  // no staleness guard here: the per-`id` guard above is what actually matters, and a
  // late-resolving SSE-triggered load for the *same* `id` is harmless to apply.
  const { disconnected, reconnect } = useSseRefetch(() => load(), 0, Boolean(id));

  async function handleRepick(): Promise<void> {
    if (!data) return;
    setRepicking(true);
    try {
      await postAcquire({
        arrInstance: data.job.arr_instance,
        targetKind: data.job.target_kind,
        targetId: data.job.target_id,
      });
      toast.success('Re-pick queued');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to queue re-pick'));
    } finally {
      setRepicking(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <StatusNotice message={error} onRetry={() => load()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { job, acquireRecord, acquireOutcome, placedFiles, subtitleRuns } = data;
  const candidateCount = candidatesConsidered(acquireRecord?.candidates_json);

  return (
    <div className="space-y-4">
      <BackLink />
      {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-xl">
            <span>{jobTitle(job)}</span>
            <PipelineBadge pipeline={job.pipeline} />
            <StatusBadge status={job.status} />
            <AcquireOutcomeBadge outcome={acquireOutcome} />
          </CardTitle>
          {job.pipeline === 'acquire' && (
            <CardAction>
              <Button variant="outline" size="sm" disabled={repicking} onClick={() => void handleRepick()}>
                {repicking ? 'Queuing…' : 'Pick a different release'}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Instance">{job.arr_instance}</Fact>
            <Fact label="Target">{targetKindLabel(job.target_kind)}</Fact>
            <Fact label="Job">#{job.id}</Fact>
            <Fact label="Attempts">{job.attempts}</Fact>
            <Fact label="Started">
              <Tooltip>
                <TooltipTrigger render={<span>{formatRelativeTime(job.created_at)}</span>} />
                <TooltipContent>{new Date(job.created_at).toLocaleString()}</TooltipContent>
              </Tooltip>
            </Fact>
            <Fact label="Took">{jobDuration(job) ?? '—'}</Fact>
          </dl>
          {job.error && (
            <p className="mt-4 rounded-lg border border-destructive-border bg-destructive-muted p-3 text-sm text-destructive-foreground">
              {job.error}
            </p>
          )}
        </CardContent>
      </Card>

      {job.pipeline === 'acquire' ? (
        <Card>
          <CardHeader>
            <CardTitle>Release pick</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!acquireRecord && <p className="text-sm text-muted-foreground">No pick record for this job yet.</p>}
            {acquireRecord && (
              <>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Fact label="Outcome">
                    {acquireRecord.status ? acquireOutcomeLabel(acquireRecord.status) : '—'}
                  </Fact>
                  <Fact label="Candidates considered">{candidateCount ?? '—'}</Fact>
                  <Fact label="Release group">{acquireRecord.release_group ?? '—'}</Fact>
                </dl>
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">Why this release</p>
                  <p className="rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                    {acquireRecord.reasoning ?? 'No reasoning recorded.'}
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        // Ingest and subtitle both place library sidecars; acquire does not.
        <Card>
          <CardHeader>
            <CardTitle>Files placed</CardTitle>
            {placedFiles.length > 0 && (
              <CardAction>
                <Badge variant="outline" className="text-muted-foreground">
                  {placedFiles.length}
                </Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {placedFiles.length === 0 && (
              <p className="text-sm text-muted-foreground">No files placed for this job.</p>
            )}
            {placedFiles.map((f) => (
              <div key={f.id} className="space-y-1.5 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileCheck2 className="size-4 text-muted-foreground" />
                  <Badge variant="outline" className="text-muted-foreground">
                    {PLACED_FILE_KIND_LABEL[f.kind]}
                  </Badge>
                  {typeof f.data.matchedBy === 'string' && <ToneBadge tone="neutral">{f.data.matchedBy}</ToneBadge>}
                </div>
                <code className="block text-xs break-all">{f.placed_path}</code>
                <code className="block text-xs break-all text-muted-foreground">from {f.source_path}</code>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {subtitleRuns && subtitleRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Subtitle site runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {subtitleRuns.map((run) => (
              <SubtitleRunCard key={run.id} run={run} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SubtitleRunCard({ run }: { run: SubtitleRunRow }): ReactNode {
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-medium">{run.site}</span>
        <ToneBadge tone={subtitleRunTone(run.status)} dot pulse={subtitleRunTone(run.status) === 'info'}>
          {subtitleRunLabel(run.status)}
        </ToneBadge>
        <span className="ml-auto text-xs text-muted-foreground">
          {run.transcript.length} step{run.transcript.length === 1 ? '' : 's'} · started{' '}
          {formatRelativeTime(run.created_at)}
        </span>
      </div>
      <TranscriptTimeline entries={run.transcript} />
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="-ml-2" render={<Link to="/activity" />}>
      <ArrowLeft />
      Back to Activity
    </Button>
  );
}

/** `candidates_json` is `{ kept: [...], dropped: [...] }` for a movie (or a single
 * series-season row), written by `runAcquireJob` in `src/pipelines/acquire/run.ts` —
 * total considered is both arrays combined, not just the ones that survived prefilter. */
function candidatesConsidered(candidatesJson: Record<string, unknown> | null | undefined): number | undefined {
  if (!candidatesJson) return undefined;
  const kept = Array.isArray(candidatesJson.kept) ? candidatesJson.kept.length : 0;
  const dropped = Array.isArray(candidatesJson.dropped) ? candidatesJson.dropped.length : 0;
  return kept + dropped;
}
