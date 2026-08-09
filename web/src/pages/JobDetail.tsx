import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { acquireOutcomeLabel, targetKindLabel } from '@/lib/labels';

// Same idea as ManagedObjects.tsx's own `KIND_LABEL` — a raw `PlacedFileKind` reads fine
// in a log line but not as dashboard copy.
const PLACED_FILE_KIND_LABEL: Record<PlacedFileKind, string> = {
  audio: 'Audio',
  subtitle: 'Subtitle',
};

/** Renders one subtitle agent run as a chronological step list — each entry's tier badge,
 * action, and detail on its own line, ordered oldest-first (the transcript's own array
 * order). `detail` can be long, so it breaks across lines rather than truncating. */
function TranscriptList({ entries }: { entries: TranscriptEntry[] }): ReactNode {
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No steps recorded.</p>;
  return (
    <ol className="space-y-1.5 text-xs">
      {entries.map((e, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <TierBadge tier={e.tier} className="shrink-0" />
          <span>
            <span className="font-medium">{e.action}</span>
            {e.detail && <span className="text-muted-foreground"> — {e.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A subtitle run's status badge — same destructive/secondary/default ladder as the
 * job-status badge, keyed off the run's own `done`/`failed` (and any in-flight status the
 * agent recorded before finishing). */
function RunStatusBadge({ status }: { status: string }): ReactNode {
  const variant: 'default' | 'secondary' | 'destructive' =
    status === 'done' ? 'default' : status === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{status}</Badge>;
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
          setError(apiErrorMessage(err, 'failed to load job'));
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
  // than trying to reconcile individual fields. `debounceMs: 0` — unlike Activity/Attention/
  // ManagedObjects's own lists, SSE traffic about one job is never a "burst" worth
  // coalescing. `load()` is called with no staleness guard here, same as before this was
  // pulled into the shared hook: the per-`id` guard above is what actually matters, and a
  // late-resolving SSE-triggered load for the *same* `id` is harmless to apply. `enabled:
  // Boolean(id)` — no point opening a connection whose `onEvent` (`load`) would just no-op.
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
      toast.error(apiErrorMessage(err, 'failed to queue re-pick'));
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
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const { job, acquireRecord, acquireOutcome, placedFiles, subtitleRuns } = data;
  const candidateCount = candidatesConsidered(acquireRecord?.candidates_json);
  const title =
    job.targetTitle?.trim() ||
    (typeof job.payload.title === 'string' ? job.payload.title : null) ||
    `${targetKindLabel(job.target_kind)} #${job.target_id}`;

  return (
    <div className="space-y-4">
      <BackLink />
      {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-xl">
            <span>{title}</span>
            <PipelineBadge pipeline={job.pipeline} />
            <StatusBadge status={job.status} />
            <AcquireOutcomeBadge outcome={acquireOutcome} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            {job.arr_instance} · {targetKindLabel(job.target_kind)} · Job #{job.id}
          </p>
          <p>Attempts: {job.attempts}</p>
          <p>Created: {new Date(job.created_at).toLocaleString()}</p>
          <p>Updated: {new Date(job.updated_at).toLocaleString()}</p>
          {job.error && <p className="text-destructive">Error: {job.error}</p>}
          {job.pipeline === 'acquire' && (
            <Button variant="outline" size="sm" className="mt-2" disabled={repicking} onClick={() => void handleRepick()}>
              {repicking ? 'Queuing…' : 'Pick a different release'}
            </Button>
          )}
        </CardContent>
      </Card>

      {job.pipeline === 'acquire' ? (
        <Card>
          <CardHeader>
            <CardTitle>Release pick</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!acquireRecord && <p className="text-muted-foreground">No pick record for this job yet.</p>}
            {acquireRecord && (
              <>
                <p>
                  Outcome:{' '}
                  {acquireRecord.status ? acquireOutcomeLabel(acquireRecord.status) : '—'}
                </p>
                <p>Candidates considered: {candidateCount ?? '—'}</p>
                <p>Release group: {acquireRecord.release_group ?? '—'}</p>
                <div>
                  <p className="mb-1 font-medium">Why this release</p>
                  <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                    {acquireRecord.reasoning ?? '—'}
                  </pre>
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
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {placedFiles.length === 0 && <p className="text-muted-foreground">No files placed for this job.</p>}
            {placedFiles.map((f) => (
              <div key={f.id} className="space-y-1 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{PLACED_FILE_KIND_LABEL[f.kind]}</Badge>
                  {typeof f.data.matchedBy === 'string' && <Badge variant="secondary">{f.data.matchedBy}</Badge>}
                </div>
                <p className="break-all">Placed: {f.placed_path}</p>
                <p className="break-all text-muted-foreground">Source: {f.source_path}</p>
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
          <CardContent className="space-y-3 text-sm">
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
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{run.site}</span>
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          Started {new Date(run.created_at).toLocaleString()}
          {run.updated_at !== run.created_at && ` · updated ${new Date(run.updated_at).toLocaleString()}`}
        </span>
      </div>
      <TranscriptList entries={run.transcript} />
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="outline" size="sm" render={<Link to="/" />}>
      ← Back to Jobs
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
