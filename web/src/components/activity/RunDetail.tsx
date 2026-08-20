import { useEffect, useState, type ReactNode } from 'react';
import { Bug, ChevronRight, FileCheck2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  fetchJob,
  type AcquireRecordDetail,
  type EventRow,
  type Job,
  type JobDetailResponse,
  type PlacedFile as PlacedFileRow,
  type PlacedFileKind,
  type SubtitleRunRow,
  type TranscriptEntry,
} from '@/api';
import { TierBadge } from '@/components/TierBadge';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { releaseShapeLabel, siteLabel, subtitleRunLabel, subtitleRunTone } from '@/lib/labels';
import { TONE_SOFT, TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn, formatRelativeTime, formatReleaseSize } from '@/lib/utils';

const PLACED_FILE_KIND_LABEL: Record<PlacedFileKind, string> = {
  audio: 'Audio',
  subtitle: 'Subtitle',
};

/** One labelled fact. Same shape the job-detail page used, kept so the enrichment
 * this branch added survives the move into the drawer. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[0.7rem] text-muted-foreground">{label}</dt>
      <dd className="text-xs font-medium">{children}</dd>
    </div>
  );
}

/**
 * A site-search run as a vertical timeline. This is the most interesting thing the
 * dashboard has to show, the agent narrating its own navigation, so it gets a
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
        // the tone system's "this wants a human". Otherwise it reads like any other step.
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

/** Why a run that produced no files did nothing. The subtitle pipeline says this out loud
 * in its own completion event; ingest emits none, so it falls back to the copy the
 * job-detail page used rather than having something invented for it. */
function QuietRun({ job, events }: { job: Job; events: EventRow[] }) {
  const spoken = events.find((e) => e.kind.endsWith('.complete') || e.kind.endsWith('.skip'));
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
  return <p className="text-xs text-muted-foreground">No files placed for this run.</p>;
}

function ReleasePick({ record }: { record: AcquireRecordDetail }) {
  const picked = record.picked;
  const [open, setOpen] = useState(false);
  const { kept, dropped } = parseCandidates(record.candidates_json);

  return (
    <div className="space-y-3">
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
            {picked.languages.length > 0 && <Fact label="Languages">{picked.languages.join(', ')}</Fact>}
          </dl>
        </div>
      )}
      {!picked && record.status === 'grabbed' && record.release_group && (
        <p className="text-xs text-muted-foreground">
          Grabbed without a resolved title. Release group {record.release_group}.
        </p>
      )}
      {record.reasoning && (
        <p className="border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {record.reasoning}
        </p>
      )}
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
                    {c.title}
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

function PlacedFile({ file }: { file: PlacedFileRow }) {
  const lang = typeof file.data.lang === 'string' ? file.data.lang : null;
  const matchedBy = typeof file.data.matchedBy === 'string' ? file.data.matchedBy : null;
  const site = typeof file.data.site === 'string' ? file.data.site : null;
  const archive = typeof file.data.archive === 'string' ? file.data.archive : null;
  const sourceFile = typeof file.data.sourceFile === 'string' ? file.data.sourceFile : null;
  const drift = typeof file.data.drift === 'string' ? file.data.drift : null;
  const offsetMs = typeof file.data.offsetMs === 'number' ? file.data.offsetMs : null;
  const driftLabel = drift ? formatDriftLabel(drift, offsetMs) : null;

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 className="size-3.5 text-muted-foreground" />
        <Badge variant="outline" className="text-muted-foreground">
          {PLACED_FILE_KIND_LABEL[file.kind]}
        </Badge>
        {matchedBy && <ToneBadge tone="neutral">{matchedBy}</ToneBadge>}
        {lang && <ToneBadge tone="neutral">{lang}</ToneBadge>}
        {site && <ToneBadge tone="neutral">{site}</ToneBadge>}
        {driftLabel && <ToneBadge tone="neutral">{driftLabel}</ToneBadge>}
      </div>
      <code className="block break-all">{file.placed_path}</code>
      <code className="block break-all text-muted-foreground">from {file.source_path}</code>
      {file.video_path && (
        <code className="block break-all text-muted-foreground">beside {file.video_path}</code>
      )}
      {(archive || sourceFile) && (
        <p className="text-muted-foreground">
          {sourceFile && <span>Source file {sourceFile}</span>}
          {sourceFile && archive && <span> · </span>}
          {archive && <span className="font-mono break-all">{archive}</span>}
        </p>
      )}
    </div>
  );
}

function SubtitleRun({ run }: { run: SubtitleRunRow }) {
  const tone = subtitleRunTone(run.status);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{siteLabel(run.site)}</span>
        <ToneBadge tone={tone} dot pulse={tone === 'info'}>
          {subtitleRunLabel(run.status)}
        </ToneBadge>
        <span className="text-muted-foreground">
          {run.transcript.length} step{run.transcript.length === 1 ? '' : 's'}
        </span>
      </div>
      <TranscriptTimeline entries={run.transcript} />
    </div>
  );
}

export function RunDetail({ jobId }: { jobId: number }) {
  const [data, setData] = useState<JobDetailResponse | null>(null);
  useEffect(() => {
    let stale = false;
    void fetchJob(jobId)
      .then((d) => {
        if (!stale) setData(d);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [jobId]);
  if (!data) return <p className="pb-3 text-xs text-muted-foreground">Loading…</p>;

  const { job, placedFiles, attention, events } = data;
  const acquireRecords = sortAcquireRecords(data.acquireRecords);
  const subtitleRuns = data.subtitleRuns ?? [];
  const showError = Boolean(job.error) && (job.status === 'failed' || job.status === 'running');
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
      {showError && job.error && (
        <p className={cn('rounded-lg border p-2.5 text-xs', TONE_SOFT.danger)}>{job.error}</p>
      )}
      {acquireRecords.map((rec) => (
        <ReleasePick key={rec.id} record={rec} />
      ))}
      {placedFiles.map((f) => (
        <PlacedFile key={f.id} file={f} />
      ))}
      {subtitleRuns.map((r) => (
        <SubtitleRun key={r.id} run={r} />
      ))}
      {attention.map((a) => (
        <Link
          key={a.id}
          to="/attention"
          className={cn('block rounded-md border px-2 py-1 text-xs', TONE_SOFT.warning)}
        >
          {a.message}
        </Link>
      ))}
      {quiet && <QuietRun job={job} events={events} />}
      <dl className="grid grid-cols-3 gap-2.5">
        <Fact label="Job">#{job.id}</Fact>
        <Fact label="Attempts">{job.attempts}</Fact>
        {source && <Fact label="Source">{source}</Fact>}
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

function parseCandidates(candidatesJson: Record<string, unknown> | null): {
  kept: { guid: string; title: string }[];
  dropped: { title: string; reason: string }[];
} {
  if (!candidatesJson) return { kept: [], dropped: [] };

  const kept: { guid: string; title: string }[] = [];
  const rawKept = candidatesJson.kept;
  if (Array.isArray(rawKept)) {
    for (const raw of rawKept) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.title !== 'string' || typeof entry.guid !== 'string') continue;
      kept.push({ guid: entry.guid, title: entry.title });
    }
  }

  const dropped: { title: string; reason: string }[] = [];
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
