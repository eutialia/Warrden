import type { ReactNode } from 'react';
import { FileCheck2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AttentionItem, PlacedFile as PlacedFileRow, PlacedFileKind, TranscriptEntry } from '@/api';
import { TierBadge } from '@/components/TierBadge';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { subtitleDriftLabel } from '@/lib/labels';
import { TONE_SOFT, TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn, formatRelativeTime } from '@/lib/utils';

/** The leaf pieces a run body is built from, shared by `RunDetail` and `SubtitleRunBody`
 * so neither has to import the other. */

const PLACED_FILE_KIND_LABEL: Record<PlacedFileKind, string> = {
  audio: 'Audio',
  subtitle: 'Subtitle',
};

/** One labelled fact. Same shape the job-detail page used, kept so the enrichment
 * this branch added survives the move into the drawer. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[0.7rem] text-muted-foreground">{label}</dt>
      <dd className="text-xs font-medium">{children}</dd>
    </div>
  );
}

export function PlacedFile({ file }: { file: PlacedFileRow }) {
  const lang = typeof file.data.lang === 'string' ? file.data.lang : null;
  const matchedBy = typeof file.data.matchedBy === 'string' ? file.data.matchedBy : null;
  const site = typeof file.data.site === 'string' ? file.data.site : null;
  const archive = typeof file.data.archive === 'string' ? file.data.archive : null;
  const sourceFile = typeof file.data.sourceFile === 'string' ? file.data.sourceFile : null;
  const drift = typeof file.data.drift === 'string' ? file.data.drift : null;
  const offsetMs = typeof file.data.offsetMs === 'number' ? file.data.offsetMs : null;
  const driftLabel = drift ? subtitleDriftLabel(drift, offsetMs) : null;

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

/** One attention item as a link into the queue that can act on it. */
export function AttentionLink({ item }: { item: AttentionItem }) {
  return (
    <Link to="/attention" className={cn('block rounded-md border px-2 py-1 text-xs', TONE_SOFT.warning)}>
      {item.message}
    </Link>
  );
}

/**
 * A site-search run as a vertical timeline. This is the most interesting thing the
 * dashboard has to show, the agent narrating its own navigation, so it gets a
 * rail, per-step timestamps, and room to breathe rather than a dense inline list.
 */
export function TranscriptTimeline({ entries }: { entries: TranscriptEntry[] }): ReactNode {
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
                'absolute top-1.5 -left-[1.6rem] size-2 rounded-full ring-4 ring-popover',
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
