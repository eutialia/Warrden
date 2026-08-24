import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AttentionItem, EventRow, PlacedFile as PlacedFileRow } from '@/api';
import { AttentionLink, PlacedFile } from '@/components/activity/runParts';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { subtitleDriftLabel } from '@/lib/labels';
import { compareEpisodeCodes, formatEpisodeCode, parseEpisodeCode, type EpisodeCode } from '@/lib/episodes';
import { TONE_SOFT, TONE_TEXT, type Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/**
 * What a subtitle run *produced*, above its timeline. A season pack places hundreds of
 * files and sets aside hundreds more, so nothing here is a flat list: it opens with the
 * run's own scoreboard, then one row per episode in episode order, and everything with a
 * full path in it stays folded away until asked for.
 *
 * What the run *did* is not here — the agent's narration is the timeline's job, one row per
 * step with the per-site verdicts folded in.
 */
export function SubtitleSummary({
  placedFiles,
  attention,
  events,
}: {
  placedFiles: PlacedFileRow[];
  attention: AttentionItem[];
  events: EventRow[];
}) {
  const groups = groupByEpisode(placedFiles);
  const unresolved = attention.filter((a) => a.kind === 'subtitle.unresolved');
  // Set-aside files are counted, never listed: there can be hundreds of them and no one
  // acts on them one by one. Everything else keeps its own link into the queue.
  const other = attention.filter((a) => a.kind !== 'subtitle.unresolved' && a.kind !== 'subtitle.quarantined');
  const episodes = unresolvedEpisodes(unresolved);

  return (
    <div className="space-y-3">
      <SummaryStrip
        placed={placedFiles.length}
        resynced={placedFiles.filter((f) => f.data.drift === 'resynced').length}
        missing={episodes.length}
        setAside={countSetAside(attention, events)}
      />
      {unresolved.length > 0 && <UnresolvedCard items={unresolved} episodes={episodes} />}
      {other.map((a) => (
        <AttentionLink key={a.id} item={a} />
      ))}
      {groups.length > 0 && (
        <div className="space-y-1">
          <p className="text-[0.7rem] text-muted-foreground">Placed by episode</p>
          <div className="divide-y divide-border/60">
            {groups.map((group) => (
              <EpisodeRow key={group.key} group={group} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the run did, in four numbers. Read before anything below it, so it is the one
 * place a season pack has to make sense at a glance. */
function SummaryStrip({
  placed,
  resynced,
  missing,
  setAside,
}: {
  placed: number;
  resynced: number;
  missing: number;
  setAside: number;
}) {
  const stats = (
    [
      { value: placed, label: 'placed', tone: 'success' },
      { value: resynced, label: 'resynced', tone: 'info' },
      { value: missing, label: 'still missing', tone: 'warning' },
      { value: setAside, label: 'set aside', tone: 'neutral' },
    ] satisfies { value: number; label: string; tone: Tone }[]
  ).filter((s) => s.value > 0);
  if (stats.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {stats.map((stat, i) => (
        <span key={stat.label} className="flex items-center gap-1">
          {i > 0 && <span className="mr-1 text-muted-foreground/50">·</span>}
          <span className={cn('font-medium tabular-nums', TONE_TEXT[stat.tone])}>{stat.value}</span>
          <span className="text-muted-foreground">{stat.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Every episode the run could not cover, as one card. The backend is moving to a single
 * `subtitle.unresolved` per job carrying `data.episodes[]`; until then this folds the
 * one-item-per-episode shape into the same card. */
function UnresolvedCard({ items, episodes }: { items: AttentionItem[]; episodes: UnresolvedEpisode[] }) {
  const first = items[0];
  const headline =
    items.length === 1 && first
      ? first.message
      : `No subtitle found for ${items.length} episodes after searching configured sites`;
  const shown = episodes.slice(0, CHIP_LIMIT);

  return (
    <Link to="/attention" className={cn('block space-y-2 rounded-md border px-2.5 py-2 text-xs', TONE_SOFT.warning)}>
      <p>{headline}</p>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shown.map((ep) => (
            <Badge key={ep.label} variant="outline" className="border-warning-border bg-transparent font-normal">
              {ep.setAside === null ? ep.label : `${ep.label} · ${ep.setAside} set aside`}
            </Badge>
          ))}
          {episodes.length > shown.length && (
            <span className="self-center text-muted-foreground">+{episodes.length - shown.length} more</span>
          )}
        </div>
      )}
    </Link>
  );
}

/** One episode, one line: which languages landed, whether the timing needed work, and
 * where the file came from. The paths only appear once the row is opened. */
function EpisodeRow({ group }: { group: EpisodeGroup }) {
  const [open, setOpen] = useState(false);
  const langs = distinct(group.files.map((f) => stringField(f.data, 'lang')));
  const drift = driftSummary(group.files);
  const source = distinct(group.files.map((f) => stringField(f.data, 'site') ?? stringField(f.data, 'matchedBy')));

  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((v) => !v)}
      head={
        <>
          <span className="font-mono font-medium">{group.label}</span>
          {langs.map((lang) => (
            <ToneBadge key={lang} tone="neutral">
              {lang}
            </ToneBadge>
          ))}
          {drift && <ToneBadge tone={drift.tone}>{drift.label}</ToneBadge>}
          {source.length > 0 && <span className="ml-auto text-muted-foreground">{source.join(' · ')}</span>}
        </>
      }
    >
      {group.files.map((file) => (
        <PlacedFile key={file.id} file={file} />
      ))}
    </Disclosure>
  );
}

function Disclosure({
  open,
  onToggle,
  head,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs hover:bg-muted/60"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {head}
      </button>
      {open && <div className="mb-2 ml-2 space-y-3 border-l pl-3">{children}</div>}
    </div>
  );
}

const CHIP_LIMIT = 60;

interface EpisodeGroup {
  key: string;
  label: string;
  code: EpisodeCode | null;
  files: PlacedFileRow[];
}

/** Placed files bucketed by the `SxxEyy` in their library path, season then episode.
 * Anything without one (a movie, an oddly named file) keeps its own row at the end. */
function groupByEpisode(files: PlacedFileRow[]): EpisodeGroup[] {
  const groups = new Map<string, EpisodeGroup>();
  for (const file of files) {
    const code = parseEpisodeCode(file.placed_path);
    const key = code ? formatEpisodeCode(code) : `file:${file.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
      continue;
    }
    groups.set(key, {
      key,
      label: code ? formatEpisodeCode(code) : basename(file.placed_path),
      code,
      files: [file],
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.code && b.code) return compareEpisodeCodes(a.code, b.code);
    if (a.code) return -1;
    if (b.code) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** One badge for a whole episode. Resynced wins over unverified wins over in sync: the
 * badge is there to flag work that was done, not to congratulate the common case. */
function driftSummary(files: PlacedFileRow[]): { label: string; tone: Tone } | null {
  const drifts = new Set(files.map((f) => stringField(f.data, 'drift')).filter(isPresent));
  if (drifts.size === 0) return null;
  if (drifts.has('resynced')) {
    const offsets = distinct(
      files
        .filter((f) => f.data.drift === 'resynced')
        .map((f) => (typeof f.data.offsetMs === 'number' ? String(f.data.offsetMs) : null)),
    );
    const offset = offsets.length === 1 && offsets[0] !== undefined ? Number(offsets[0]) : null;
    return { label: subtitleDriftLabel('resynced', offset), tone: 'info' };
  }
  if (drifts.has('unverified')) return { label: subtitleDriftLabel('unverified', null), tone: 'warning' };
  const only = [...drifts][0];
  return only === undefined ? null : { label: subtitleDriftLabel(only, null), tone: 'neutral' };
}

interface UnresolvedEpisode {
  label: string;
  /** How many candidate files were set aside for this episode, when the backend says. */
  setAside: number | null;
}

function unresolvedEpisodes(items: AttentionItem[]): UnresolvedEpisode[] {
  const episodes: UnresolvedEpisode[] = [];
  for (const item of items) {
    const listed = item.data.episodes;
    if (Array.isArray(listed)) {
      for (const raw of listed) {
        const episode = readEpisode(raw);
        if (episode) episodes.push(episode);
      }
      continue;
    }
    const title = stringField(item.data, 'title') ?? item.message;
    episodes.push({ label: shortEpisodeLabel(title), setAside: null });
  }
  return episodes.sort(compareByEpisodeLabel);
}

function readEpisode(raw: unknown): UnresolvedEpisode | null {
  if (typeof raw === 'string') return { label: shortEpisodeLabel(raw), setAside: null };
  if (typeof raw !== 'object' || raw === null) return null;
  const label = stringField(raw, 'label') ?? stringField(raw, 'title') ?? composeLabel(raw);
  if (!label) return null;
  const setAside =
    numberField(raw, 'setAside') ?? numberField(raw, 'quarantined') ?? numberField(raw, 'count');
  return { label: shortEpisodeLabel(label), setAside };
}

function composeLabel(source: object): string | null {
  const season = numberField(source, 'seasonNumber') ?? numberField(source, 'season');
  const episode = numberField(source, 'episodeNumber') ?? numberField(source, 'episode');
  if (season === null || episode === null) return null;
  return `S${season}E${episode}`;
}

/** `S4E23 (Sword Art Online)` is the same title over and over inside one job's card, so
 * the chip keeps the episode and drops the series. */
function shortEpisodeLabel(title: string): string {
  const match = /^S\d+E\d+/i.exec(title.trim());
  return match ? match[0].toUpperCase() : title.trim();
}

function compareByEpisodeLabel(a: UnresolvedEpisode, b: UnresolvedEpisode): number {
  const aCode = parseEpisodeCode(a.label);
  const bCode = parseEpisodeCode(b.label);
  if (aCode && bCode) return compareEpisodeCodes(aCode, bCode);
  if (aCode) return -1;
  if (bCode) return 1;
  return a.label.localeCompare(b.label);
}

/**
 * How many candidate files this run set aside. Quarantines are being moved from attention
 * items to warn-level events, so both sources are counted and de-duplicated: during the
 * move a file shows up in each, and the events list is capped while the attention list
 * is not.
 */
function countSetAside(attention: AttentionItem[], events: EventRow[]): number {
  const seen = new Set<string>();
  let unkeyed = 0;
  for (const row of [...attention, ...events]) {
    if (row.kind !== 'subtitle.quarantined') continue;
    // `facts.sourcePath` is where the envelope keeps it; `sourceFile` is what an
    // un-migrated attention item (that table is not rewritten) still calls the same thing.
    const facts = (row.data as { facts?: { sourcePath?: string } }).facts;
    const key = stringField(row.data, 'dedupeKey') ?? facts?.sourcePath ?? stringField(row.data, 'sourceFile');
    if (key === null) {
      unkeyed += 1;
      continue;
    }
    seen.add(key);
  }
  return seen.size + unkeyed;
}

function stringField(source: object, key: string): string | null {
  const value = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(source: object, key: string): number | null {
  const value = Reflect.get(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter(isPresent))];
}

function isPresent(value: string | null): value is string {
  return value !== null;
}
