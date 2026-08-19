import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, Bug, FileCheck2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchJob,
  postAcquire,
  type AcquireRecordDetail,
  type AttentionItem,
  type Job,
  type JobDetailResponse,
  type JobStatus,
  type PickedRelease,
  type PlacedFile,
  type PlacedFileKind,
  type RelatedJob,
  type SubtitleRunRow,
  type TranscriptEntry,
} from '@/api';
import { SectionStack } from '@/components/SectionStack';
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
import {
  acquireOutcomeLabel,
  pipelineLabel,
  releaseShapeLabel,
  siteLabel,
  subtitleRunLabel,
  subtitleRunTone,
  targetKindLabel,
} from '@/lib/labels';
import { TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn, formatRelativeTime, formatReleaseSize } from '@/lib/utils';

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
      {entries.map((entry, i) => {
        // A step the agent refused because it aimed somewhere it must not go. Amber, per
        // the tone system's "this wants a human" — otherwise it reads like any other step.
        const attention = entry.level === 'attention';
        return (
          <li key={i} className="relative">
            <span
              className={cn(
                'absolute top-1.5 -left-[1.6rem] size-2 rounded-full ring-4 ring-card',
                TONE_SOLID[attention ? 'warning' : i === entries.length - 1 ? 'brand' : 'neutral'],
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('text-sm font-medium', attention && TONE_TEXT.warning)}>{entry.action}</span>
              <TierBadge tier={entry.tier} />
              <span className="ml-auto text-xs text-muted-foreground">{formatRelativeTime(entry.ts)}</span>
            </div>
            {entry.detail && (
              <p className={cn('mt-1 text-xs break-words', attention ? TONE_TEXT.warning : 'text-muted-foreground')}>
                {entry.detail}
              </p>
            )}
          </li>
        );
      })}
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
      toast.error(apiErrorMessage(err, 'Failed to queue re-pick'));
    } finally {
      setRepicking(false);
    }
  }

  const sortedAcquireRecords = useMemo(
    () => (data ? sortAcquireRecords(data.acquireRecords) : []),
    [data],
  );

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

  const { job, acquireOutcome, relatedJobs, attention, placedFiles, subtitleRuns } = data;
  const source = payloadString(job.payload.source);
  const hint = payloadString(job.payload.hint);
  const showError = Boolean(job.error) && (job.status === 'failed' || job.status === 'running');
  const showFinished = job.status === 'done' || job.status === 'failed';

  return (
    // The back link sits above the stack, not inside it: as a section it would put a
    // full-width rule and 32px of space between itself and the job it belongs to.
    <div className="space-y-4">
      <BackLink />

      <SectionStack>
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
              <Fact label="Finished">
                {showFinished ? (
                  <Tooltip>
                    <TooltipTrigger render={<span>{formatRelativeTime(job.updated_at)}</span>} />
                    <TooltipContent>{new Date(job.updated_at).toLocaleString()}</TooltipContent>
                  </Tooltip>
                ) : (
                  '—'
                )}
              </Fact>
              {source && <Fact label="Source">{source}</Fact>}
            </dl>
            {hint && (
              <div className="mt-4">
                <p className="mb-2 text-xs text-muted-foreground">Hint</p>
                <p className="border-l pl-3 text-sm leading-relaxed whitespace-pre-wrap">{hint}</p>
              </div>
            )}
            {showError && job.error && (
              <p className="mt-4 rounded-lg border border-destructive-border bg-destructive-muted p-3 text-sm text-destructive-foreground">
                {job.error}
              </p>
            )}
            <div className="mt-4">
              <Button variant="ghost" size="sm" className="-ml-2" render={<Link to={`/debug/${job.id}`} />}>
                <Bug />
                Debug trace
              </Button>
            </div>
          </CardContent>
        </Card>

        {job.pipeline === 'acquire' ? (
          sortedAcquireRecords.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Release pick</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">No pick record for this job yet.</p>
              </CardContent>
            </Card>
          ) : (
            sortedAcquireRecords.map((record) => <ReleasePickCard key={record.id} record={record} />)
          )
        ) : (
          <PlacedFilesCard job={job} placedFiles={placedFiles} />
        )}

        {job.pipeline === 'subtitle' && <SubtitleRunsCard runs={subtitleRuns ?? []} />}

        {relatedJobs.length > 0 && <RelatedJobsCard jobs={relatedJobs} />}

        {attention.length > 0 && <AttentionCard items={attention} />}
      </SectionStack>
    </div>
  );
}

function RelatedJobsCard({ jobs }: { jobs: RelatedJob[] }): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Related jobs</CardTitle>
      </CardHeader>
      <CardContent className="max-h-64 space-y-2 overflow-y-auto">
        {jobs.map((sibling) => (
          <Link
            key={sibling.id}
            to={`/jobs/${sibling.id}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
          >
            <span className="font-medium">{pipelineLabel(sibling.pipeline)}</span>
            <StatusBadge status={sibling.status} />
            {sibling.acquireOutcome && <AcquireOutcomeBadge outcome={sibling.acquireOutcome} />}
            <span className="ml-auto text-xs text-muted-foreground">#{sibling.id}</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function AttentionCard({ items }: { items: AttentionItem[] }): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open attention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.id}
            to="/attention"
            className="block rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
          >
            {item.message}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function ReleasePickCard({ record }: { record: AcquireRecordDetail }): ReactNode {
  const picked = record.picked;
  const { kept, dropped } = parseCandidates(record.candidates_json);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>Release pick</span>
          {picked?.forceGrab && <ToneBadge tone="warning">Force grab</ToneBadge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Fact label="Outcome">{record.status ? acquireOutcomeLabel(record.status) : '—'}</Fact>
          {record.release_group && <Fact label="Release group">{record.release_group}</Fact>}
          {record.source && <Fact label="Source">{record.source}</Fact>}
        </dl>

        {picked ? (
          <PickedHero picked={picked} />
        ) : (
          record.status === 'grabbed' &&
          record.release_group && (
            <p className="text-sm text-muted-foreground">
              Grabbed without a resolved title. Release group {record.release_group}.
            </p>
          )
        )}

        <div>
          <p className="mb-2 text-xs text-muted-foreground">Why this release</p>
          <p className="border-l pl-3 text-sm leading-relaxed whitespace-pre-wrap">
            {record.reasoning ?? 'No reasoning recorded.'}
          </p>
        </div>

        {(kept.length > 0 || dropped.length > 0) && (
          <div className="space-y-4 border-t pt-4">
            {kept.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Kept · {kept.length}
                </p>
                <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
                  {kept.map((c) => {
                    const isPicked = record.picked_guid !== null && c.guid === record.picked_guid;
                    return (
                      <li
                        key={c.guid}
                        className={cn(
                          'font-mono text-xs break-all',
                          isPicked ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {formatKeptLine(c)}
                        {isPicked && <span className="ml-2 font-sans text-[0.7rem] text-muted-foreground">picked</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {dropped.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Dropped · {dropped.length}
                </p>
                <ul className="max-h-96 space-y-1 overflow-y-auto pr-1">
                  {dropped.map((d, i) => (
                    <li key={`${d.title}-${i}`} className="font-mono text-xs break-all text-muted-foreground">
                      {d.title}
                      <span className="font-sans"> · {d.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PickedHero({ picked }: { picked: PickedRelease }): ReactNode {
  return (
    <div className="space-y-3 rounded-lg border border-success-border bg-success-muted p-3">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">{picked.forceGrab ? 'Force grabbed' : 'Grabbed'}</p>
        <p className="font-mono text-sm break-all">{picked.title}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {picked.indexer && <Fact label="Indexer">{picked.indexer}</Fact>}
        {picked.quality && <Fact label="Quality">{picked.quality}</Fact>}
        {picked.size !== null && <Fact label="Size">{formatReleaseSize(picked.size)}</Fact>}
        {picked.seeders !== null && <Fact label="Seeders">{picked.seeders}</Fact>}
        {picked.shape && <Fact label="Shape">{releaseShapeLabel(picked.shape)}</Fact>}
        {picked.seasonNumber !== null && <Fact label="Season">{picked.seasonNumber}</Fact>}
        {picked.languages.length > 0 && <Fact label="Languages">{picked.languages.join(', ')}</Fact>}
      </dl>
    </div>
  );
}

function PlacedFilesCard({ job, placedFiles }: { job: Job; placedFiles: PlacedFile[] }): ReactNode {
  return (
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
        {placedFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{placedFilesEmptyCopy(job.status)}</p>
        ) : (
          placedFiles.map((f) => <PlacedFileRow key={f.id} file={f} />)
        )}
      </CardContent>
    </Card>
  );
}

function PlacedFileRow({ file }: { file: PlacedFile }): ReactNode {
  const lang = typeof file.data.lang === 'string' ? file.data.lang : null;
  const matchedBy = typeof file.data.matchedBy === 'string' ? file.data.matchedBy : null;
  const site = typeof file.data.site === 'string' ? file.data.site : null;
  const archive = typeof file.data.archive === 'string' ? file.data.archive : null;
  const sourceFile = typeof file.data.sourceFile === 'string' ? file.data.sourceFile : null;
  const drift = typeof file.data.drift === 'string' ? file.data.drift : null;
  const offsetMs = typeof file.data.offsetMs === 'number' ? file.data.offsetMs : null;
  const driftLabel = drift ? formatDriftLabel(drift, offsetMs) : null;

  return (
    <div className="space-y-1.5 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 className="size-4 text-muted-foreground" />
        <Badge variant="outline" className="text-muted-foreground">
          {PLACED_FILE_KIND_LABEL[file.kind]}
        </Badge>
        {matchedBy && <ToneBadge tone="neutral">{matchedBy}</ToneBadge>}
        {lang && <ToneBadge tone="neutral">{lang}</ToneBadge>}
        {site && <ToneBadge tone="neutral">{site}</ToneBadge>}
        {driftLabel && <ToneBadge tone="neutral">{driftLabel}</ToneBadge>}
        <span className="ml-auto text-xs text-muted-foreground">{formatRelativeTime(file.created_at)}</span>
      </div>
      <code className="block text-xs break-all">{file.placed_path}</code>
      <code className="block text-xs break-all text-muted-foreground">from {file.source_path}</code>
      {file.video_path && (
        <code className="block text-xs break-all text-muted-foreground">beside {file.video_path}</code>
      )}
      {(archive || sourceFile) && (
        <p className="text-xs text-muted-foreground">
          {sourceFile && <span>Source file {sourceFile}</span>}
          {sourceFile && archive && <span> · </span>}
          {archive && <span className="font-mono break-all">{archive}</span>}
        </p>
      )}
    </div>
  );
}

function SubtitleRunsCard({ runs }: { runs: SubtitleRunRow[] }): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subtitle site runs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No site searches recorded.</p>
        ) : (
          runs.map((run) => <SubtitleRunCard key={run.id} run={run} />)
        )}
      </CardContent>
    </Card>
  );
}

function SubtitleRunCard({ run }: { run: SubtitleRunRow }): ReactNode {
  return (
    <div className="border-t pt-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-medium">{siteLabel(run.site)}</span>
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

function payloadString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Season ascending with nulls last, then created_at. */
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

function placedFilesEmptyCopy(status: JobStatus): string {
  if (status === 'pending' || status === 'running') {
    return 'Waiting to settle, or nothing to place yet.';
  }
  if (status === 'done') {
    return 'No sidecars placed. The import settled without extra files.';
  }
  return 'No files placed for this job.';
}

function formatDriftLabel(drift: string, offsetMs: number | null): string {
  if (drift === 'resynced') {
    if (offsetMs === null) return 'Resynced';
    const sign = offsetMs >= 0 ? '+' : '';
    return `Resynced ${sign}${offsetMs}ms`;
  }
  if (drift === 'in-sync') return 'In sync';
  if (drift === 'unverified') return 'Unverified timing';
  return drift;
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
