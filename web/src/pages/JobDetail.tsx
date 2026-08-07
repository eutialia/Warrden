import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, fetchJob, postAcquire, type JobDetailResponse, type PlacedFileKind } from '@/api';
import { AcquireOutcomeBadge, StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSseRefetch } from '@/hooks/useSseRefetch';

// Same idea as ManagedObjects.tsx's own `KIND_LABEL` — a raw `PlacedFileKind` reads fine
// in a log line but not as dashboard copy.
const PLACED_FILE_KIND_LABEL: Record<PlacedFileKind, string> = {
  audio: 'Audio',
  subtitle: 'Subtitle',
};

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
          setError(err instanceof ApiError ? err.message : 'failed to load job');
        });
    },
    [id],
  );

  useEffect(() => {
    if (!id) return;
    let stale = false;
    setData(null);
    setError(null);
    load({ isStale: () => stale });
    return () => {
      stale = true; // ignore this effect's fetch if it resolves after `id` changed again
    };
  }, [id, load]);

  // Any event can mean this job (or its acquire record) changed — refetch wholesale rather
  // than trying to reconcile individual fields. `debounceMs: 0` — unlike Activity/Attention/
  // ManagedObjects's own lists, SSE traffic about one job is never a "burst" worth
  // coalescing. `load()` is called with no staleness guard here, same as before this was
  // pulled into the shared hook: the per-`id` guard above is what actually matters, and a
  // late-resolving SSE-triggered load for the *same* `id` is harmless to apply. `enabled:
  // Boolean(id)` — no point opening a connection whose `onEvent` (`load`) would just no-op.
  useSseRefetch(() => load(), 0, Boolean(id));

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
      toast.error(err instanceof ApiError ? err.message : 'failed to queue re-pick');
    } finally {
      setRepicking(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-destructive">{error}</p>
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

  const { job, acquireRecord, acquireOutcome, placedFiles } = data;
  const candidateCount = candidatesConsidered(acquireRecord?.candidates_json);

  return (
    <div className="space-y-4">
      <BackLink />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Job #{job.id} — {job.pipeline}
            <StatusBadge status={job.status} />
            <AcquireOutcomeBadge outcome={acquireOutcome} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>Arr instance: {job.arr_instance}</p>
          <p>
            Target: {job.target_kind} #{job.target_id}
          </p>
          <p>Attempts: {job.attempts}</p>
          <p>Created: {new Date(job.created_at).toLocaleString()}</p>
          <p>Updated: {new Date(job.updated_at).toLocaleString()}</p>
          {job.error && <p className="text-destructive">Error: {job.error}</p>}
          {job.pipeline === 'acquire' && (
            <Button variant="outline" size="sm" className="mt-2" disabled={repicking} onClick={() => void handleRepick()}>
              {repicking ? 'Queuing…' : 'Re-pick'}
            </Button>
          )}
        </CardContent>
      </Card>

      {job.pipeline === 'ingest' ? (
        <Card>
          <CardHeader>
            <CardTitle>Placed files</CardTitle>
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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Acquire record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!acquireRecord && <p className="text-muted-foreground">No acquire record for this target yet.</p>}
            {acquireRecord && (
              <>
                <p>Status: {acquireRecord.status ?? '—'}</p>
                <p>Candidates considered: {candidateCount ?? '—'}</p>
                <p>Picked GUID: {acquireRecord.picked_guid ?? '—'}</p>
                <p>Release group: {acquireRecord.release_group ?? '—'}</p>
                <div>
                  <p className="mb-1 font-medium">Reasoning</p>
                  <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                    {acquireRecord.reasoning ?? '—'}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="outline" size="sm" render={<Link to="/" />}>
      ← Back to Activity
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
