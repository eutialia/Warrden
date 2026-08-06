import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, fetchJob, type JobDetailResponse } from '@/api';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    fetchJob(id)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'failed to load job'));
  }, [id]);

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

  const { job, acquireRecord } = data;
  const candidateCount = candidatesConsidered(acquireRecord?.candidates_json);

  return (
    <div className="space-y-4">
      <BackLink />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Job #{job.id} — {job.pipeline}
            <StatusBadge status={job.status} />
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
        </CardContent>
      </Card>

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

/** `candidates_json` is `{ kept: [...], dropped: [...] }` (written by `runAcquireJob` /
 * `recordOutcome` in `src/pipelines/acquire/run.ts`) — total considered is both arrays
 * combined, not just the ones that survived prefilter. */
function candidatesConsidered(candidatesJson: Record<string, unknown> | null | undefined): number | undefined {
  if (!candidatesJson) return undefined;
  const kept = Array.isArray(candidatesJson.kept) ? candidatesJson.kept.length : 0;
  const dropped = Array.isArray(candidatesJson.dropped) ? candidatesJson.dropped.length : 0;
  return kept + dropped;
}
