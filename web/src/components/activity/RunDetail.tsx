import { useCallback, useEffect, useState } from 'react';
import { Bug, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  apiErrorMessage,
  fetchJob,
  type AcquireRecordDetail,
  type EventRow,
  type Job,
  type JobDetailResponse,
} from '@/api';
import { RelativeTime } from '@/components/activity/RelativeTime';
import { AttentionLink, Fact, PlacedFile } from '@/components/activity/runParts';
import { SubtitleRunBody } from '@/components/activity/SubtitleRunBody';
import { StatusNotice } from '@/components/StatusNotice';
import { ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { acquireOutcomeLabel, releaseShapeLabel } from '@/lib/labels';
import { TONE_SOFT } from '@/lib/tone';
import { cn, formatReleaseSize } from '@/lib/utils';

/** Why a run that produced no files did nothing. The subtitle pipeline says this out loud
 * in its own completion event; ingest emits none, so it falls back to the copy the
 * job-detail page used rather than having something invented for it. */
function QuietRun({ job, events }: { job: Job; events: EventRow[] }) {
  // Real skip kinds are `acquire.skip-already-grabbed` / `acquire.skip-unaired`: a
  // `.skip-` segment, not a `.skip` suffix, so `endsWith('.skip')` matches nothing.
  const spoken = events.find((e) => e.kind.endsWith('.complete') || e.kind.includes('.skip-'));
  if (spoken) return <p className="text-xs text-muted-foreground">{spoken.message}</p>;
  if (job.pipeline === 'ingest') {
    return (
      <p className="text-xs text-muted-foreground">
        {job.status === 'done'
          ? 'No sidecars placed. The import settled without extra files.'
          : 'Waiting to settle, or nothing to place yet.'}
      </p>
    );
  }
  if (job.pipeline === 'acquire') {
    return <MissingPickNote />;
  }
  return <p className="text-xs text-muted-foreground">No files placed for this run.</p>;
}

function MissingPickNote() {
  return <p className="text-xs text-muted-foreground">No pick record for this job yet.</p>;
}

function ReleasePick({
  record,
  showOutcome,
}: {
  record: AcquireRecordDetail;
  showOutcome: boolean;
}) {
  const picked = record.picked;
  const [open, setOpen] = useState(false);
  const { kept, dropped } = parseCandidates(record.candidates_json);

  return (
    <div className="space-y-3">
      {showOutcome && record.status && (
        <dl className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
          <Fact label="Outcome">{acquireOutcomeLabel(record.status)}</Fact>
        </dl>
      )}
      {picked && (
        <div className="space-y-2.5 rounded-lg border border-success-border bg-success-muted p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.7rem] text-muted-foreground">{picked.forceGrab ? 'Force grabbed' : 'Grabbed'}</span>
            {picked.forceGrab && <ToneBadge tone="warning">Force grab</ToneBadge>}
          </div>
          <p className="font-mono text-xs break-all">{picked.title}</p>
          <dl className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {picked.indexer && <Fact label="Indexer">{picked.indexer}</Fact>}
            {picked.quality && <Fact label="Quality">{picked.quality}</Fact>}
            {picked.size !== null && <Fact label="Size">{formatReleaseSize(picked.size)}</Fact>}
            {picked.seeders !== null && <Fact label="Seeders">{picked.seeders}</Fact>}
            {picked.shape && <Fact label="Shape">{releaseShapeLabel(picked.shape)}</Fact>}
            {picked.seasonNumber !== null && <Fact label="Season">{picked.seasonNumber}</Fact>}
            {record.release_group && <Fact label="Group">{record.release_group}</Fact>}
            {record.source && <Fact label="Source">{record.source}</Fact>}
            {picked.languages.length > 0 && <Fact label="Languages">{picked.languages.join(', ')}</Fact>}
          </dl>
        </div>
      )}
      {!picked && record.status === 'grabbed' && record.release_group && (
        <p className="text-xs text-muted-foreground">
          Grabbed without a resolved title.
        </p>
      )}
      {!picked && (record.release_group || record.source) && (
        <dl className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
          {record.release_group && <Fact label="Group">{record.release_group}</Fact>}
          {record.source && <Fact label="Source">{record.source}</Fact>}
        </dl>
      )}
      <p className="border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {record.reasoning || 'No reasoning recorded.'}
      </p>
      {(kept.length > 0 || dropped.length > 0) && (
        <div className="text-xs">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {kept.length} kept · {dropped.length} dropped
          </button>
          {open && (
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
              {kept.map((c) => {
                const isPicked = record.picked_guid !== null && c.guid === record.picked_guid;
                return (
                  <li key={c.guid} className={cn('font-mono break-all', isPicked ? 'text-foreground' : '')}>
                    {formatKeptLine(c)}
                    {isPicked && <span className="ml-2 font-sans text-[0.7rem] text-muted-foreground">picked</span>}
                  </li>
                );
              })}
              {dropped.map((d, i) => (
                <li key={`${d.title}-${i}`} className="font-mono break-all text-muted-foreground/70">
                  <span className="line-through decoration-muted-foreground/50">{d.title}</span>
                  <span className="font-sans no-underline"> · {d.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

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

  if (error) {
    return (
      <div className="pb-3 pl-5">
        <StatusNotice message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) return <p className="pb-3 text-xs text-muted-foreground">Loading…</p>;

  const { job, placedFiles, attention, events } = data;
  const acquireRecords = sortAcquireRecords(data.acquireRecords);
  const subtitleRuns = data.subtitleRuns ?? [];
  const showError = job.status === 'failed' || (Boolean(job.error) && job.status === 'running');
  const source = payloadString(job.payload.source);
  const hint = payloadString(job.payload.hint);
  const quiet =
    !showError &&
    acquireRecords.length === 0 &&
    placedFiles.length === 0 &&
    subtitleRuns.length === 0 &&
    attention.length === 0 &&
    job.status !== 'failed';

  return (
    // Indented to line up under the run label above it, not the chevron. Without this the
    // detail sits left of its own parent and the nesting reads as a flat list.
    <div className="space-y-3 pb-5 pl-5">
      {showError && (
        <p className={cn('rounded-lg border p-2.5 text-xs', TONE_SOFT.danger)}>{job.error ?? 'Failed'}</p>
      )}
      {acquireRecords.map((rec) => (
        // A single record's Outcome is the same sentence as the node headline.
        // The fact exists for multi-season jobs, where each row can differ.
        <ReleasePick key={rec.id} record={rec} showOutcome={acquireRecords.length > 1} />
      ))}
      {job.pipeline === 'subtitle' ? (
        <SubtitleRunBody placedFiles={placedFiles} attention={attention} events={events} runs={subtitleRuns} />
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
      {quiet && <QuietRun job={job} events={events} />}
      {!quiet && job.pipeline === 'acquire' && acquireRecords.length === 0 && <MissingPickNote />}
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

/** Season ascending with nulls last, then created_at, so a multi-season grab reads in
 * season order rather than whatever order the records were written. */
function sortAcquireRecords(records: AcquireRecordDetail[]): AcquireRecordDetail[] {
  return [...records].sort((a, b) => {
    const aSeason = a.picked?.seasonNumber ?? null;
    const bSeason = b.picked?.seasonNumber ?? null;
    if (aSeason === null && bSeason !== null) return 1;
    if (aSeason !== null && bSeason === null) return -1;
    if (aSeason !== null && bSeason !== null && aSeason !== bSeason) return aSeason - bSeason;
    return a.created_at - b.created_at;
  });
}

interface KeptCandidateView {
  guid: string;
  title: string;
  indexer: string | null;
  size: number | null;
  seeders: number | null;
  quality: string | null;
}

interface DroppedCandidateView {
  title: string;
  reason: string;
}

function parseCandidates(candidatesJson: Record<string, unknown> | null): {
  kept: KeptCandidateView[];
  dropped: DroppedCandidateView[];
} {
  if (!candidatesJson) return { kept: [], dropped: [] };

  const kept: KeptCandidateView[] = [];
  const rawKept = candidatesJson.kept;
  if (Array.isArray(rawKept)) {
    for (const raw of rawKept) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.title !== 'string' || typeof entry.guid !== 'string') continue;
      kept.push({
        guid: entry.guid,
        title: entry.title,
        indexer: typeof entry.indexer === 'string' ? entry.indexer : null,
        size: typeof entry.size === 'number' ? entry.size : null,
        seeders: typeof entry.seeders === 'number' ? entry.seeders : null,
        quality: qualityNameOf(entry),
      });
    }
  }

  const dropped: DroppedCandidateView[] = [];
  const rawDropped = candidatesJson.dropped;
  if (Array.isArray(rawDropped)) {
    for (const raw of rawDropped) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const reason = typeof entry.reason === 'string' ? entry.reason : 'dropped';
      const candidate = entry.candidate;
      let title = 'Unknown release';
      if (typeof candidate === 'object' && candidate !== null) {
        const t = Reflect.get(candidate, 'title');
        if (typeof t === 'string') title = t;
      } else if (typeof entry.title === 'string') {
        title = entry.title;
      }
      dropped.push({ title, reason });
    }
  }

  return { kept, dropped };
}

function qualityNameOf(entry: Record<string, unknown>): string | null {
  const quality = entry.quality;
  if (typeof quality !== 'object' || quality === null) return null;
  const inner = Reflect.get(quality, 'quality');
  if (typeof inner !== 'object' || inner === null) return null;
  const name = Reflect.get(inner, 'name');
  return typeof name === 'string' ? name : null;
}

function formatKeptLine(c: KeptCandidateView): string {
  const parts = [c.title];
  if (c.quality) parts.push(c.quality);
  if (c.size !== null) parts.push(formatReleaseSize(c.size));
  if (c.seeders !== null) parts.push(`${c.seeders} seeders`);
  if (c.indexer) parts.push(c.indexer);
  return parts.join(' · ');
}
