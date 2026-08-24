import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiErrorMessage, fetchJob, type JobDetailResponse } from '@/api';
import { RelativeTime } from '@/components/activity/RelativeTime';
import { jobRows } from '@/components/activity/jobRows';
import { AttentionLink, Fact, PlacedFile } from '@/components/activity/runParts';
import { SubtitleSummary } from '@/components/activity/SubtitleSummary';
import { UnifiedTimeline } from '@/components/activity/UnifiedTimeline';
import { StatusNotice } from '@/components/StatusNotice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';

/**
 * One run, opened. Every pipeline and every status reads the same way: what the run
 * produced, then the timeline of what it did — the agent's steps, the per-site verdicts,
 * each season's pick, and the row the run ended on.
 *
 * There is no error banner and no "this run did nothing" note: a failure and a quiet ending
 * are both just the verdict row at the head of the feed, said once, in place.
 */
export function RunDetail({ jobId }: { jobId: number }) {
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const beginFetch = useFetchGeneration();

  const load = useCallback(() => {
    const isStale = beginFetch();
    fetchJob(jobId)
      .then((result) => {
        if (isStale()) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load job'));
      });
  }, [beginFetch, jobId]);

  useEffect(() => {
    setData(null);
    setError(null);
    load();
  }, [jobId, load]);

  // Several runs can be open at once, so filter to this job. A null frame is a
  // connection-level nudge (reconnect, heartbeat, malformed) that every caller refetches
  // on. debounceMs 0 because traffic about one job is never a burst worth coalescing.
  // A custom filter replaces defaultFilter rather than composing with it, so the
  // trace.appended exclusion has to be repeated here; otherwise the per-step firehose
  // refetches this drawer at debounceMs 0.
  useSseRefetch(
    load,
    0,
    Boolean(jobId),
    (e) => e === null || (e.kind !== 'trace.appended' && e.job_id === jobId),
  );

  // Every event about this job refetches the whole detail at debounce 0, so a long run
  // rebuilds this several times a second. The rows are a pure function of the response;
  // rebuilding them only when the response changes is the difference between the feed
  // costing one pass per event and one pass per render.
  const rows = useMemo(() => (data === null ? [] : jobRows(data)), [data]);

  if (error) {
    return (
      <div className="pb-3 pl-5">
        <StatusNotice message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) return <Spinner className="mb-3 ml-5 text-muted-foreground" />;

  const { job, placedFiles, attention, events } = data;
  const running = job.status === 'running';
  const pending = job.status === 'pending';
  const source = payloadString(job.payload.source);
  const hint = payloadString(job.payload.hint);

  return (
    // Indented to line up under the run label above it, not the chevron. Without this the
    // detail sits left of its own parent and the nesting reads as a flat list.
    <div className="space-y-3 pb-5 pl-5">
      {job.pipeline === 'subtitle' ? (
        <SubtitleSummary placedFiles={placedFiles} attention={attention} events={events} />
      ) : (
        <>
          {placedFiles.map((f) => (
            <PlacedFile key={f.id} file={f} />
          ))}
          {attention.map((a) => (
            <AttentionLink key={a.id} item={a} />
          ))}
        </>
      )}
      {/* A pending run streams too — it is queued, not asleep — but without the braille
          spinner: waiting is not working. */}
      <UnifiedTimeline
        rows={rows}
        running={running || pending}
        spinner={running}
        emptyLabel={pending ? 'Waiting for a slot…' : 'Starting up…'}
      />
      <dl className="grid grid-cols-3 gap-2.5">
        <Fact label="Job">#{job.id}</Fact>
        <Fact label="Attempts">{job.attempts}</Fact>
        {source && <Fact label="Source">{source}</Fact>}
        {(job.status === 'done' || job.status === 'failed') && (
          <Fact label="Finished">
            <RelativeTime ts={job.updated_at} />
          </Fact>
        )}
      </dl>
      {hint && (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Hint</p>
          <p className="border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap">{hint}</p>
        </div>
      )}
      <Button variant="ghost" size="sm" render={<Link to={`/debug/${job.id}`} />}>
        <Bug />
        Debug trace
      </Button>
    </div>
  );
}

function payloadString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
