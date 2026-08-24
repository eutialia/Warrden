import type { AcquireRecordDetail } from '@/api';
import { FadeScroll } from '@/components/activity/FadeScroll';
import { Fact } from '@/components/activity/runParts';
import { ToneBadge } from '@/components/ToneBadge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { releaseShapeLabel } from '@/lib/labels';
import { TONE_SOLID } from '@/lib/tone';
import { cn, formatReleaseSize } from '@/lib/utils';

/**
 * One season's acquire conclusion: the release that won, its facts, the reasoning, and the
 * candidate set it beat. Rendered as the body of a pick block inside the run timeline, at
 * the moment the pick was written — never as a detached card above it.
 *
 * No `showOutcome`: the block's own label states the outcome, so a fact repeating it would
 * be the same sentence twice.
 */
export function ReleasePick({ record }: { record: AcquireRecordDetail }) {
  const picked = record.picked;

  return (
    <div className="space-y-3">
      {picked && (
        // The success frame without `TONE_SOFT.success`'s text tone, on purpose: the tone
        // is the *card's*, not the release's, and tinting the title and every fact value
        // green turns a release into a green card you stop reading.
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
        <p className="text-xs text-muted-foreground">Grabbed without a resolved title.</p>
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
      {/* The candidate set is the *filter's* evidence, not the pick's, so it belongs under a
          filter row in the feed. `acquire.filter` carries only aggregate counts and reasons —
          no event carries the candidates themselves — so the list rides inside the pick block,
          where the record that holds it already is. */}
      <CandidateList record={record} />
    </div>
  );
}

/** Every candidate the sweep found, picked bright, dropped dimmed with the arr rejection on
 * hover. The picked highlight is a back-reference — at filter time nothing was picked yet —
 * kept because it is what makes the list scannable. */
function CandidateList({ record }: { record: AcquireRecordDetail }) {
  const { kept, dropped } = parseCandidates(record.candidates_json);
  if (kept.length === 0 && dropped.length === 0) return null;

  return (
    <div className="text-xs">
      <p className="text-[0.7rem] text-muted-foreground">
        {kept.length} kept · {dropped.length} dropped
      </p>
      {/* Shorter and self-contained: this viewport lives inside the timeline's own, and two
          `max-h-44` scrollers stacked one inside the other read as one confused surface —
          reaching the end of the candidates would scroll the timeline out from under them. */}
      <FadeScroll className="mt-1.5" maxHeight="max-h-28" contain>
        <ul className="space-y-1">
          {kept.map((c) => {
            const isPicked = record.picked_guid !== null && c.guid === record.picked_guid;
            return (
              <CandidateRow
                key={c.guid}
                label={c.title}
                detail={formatKeptLine(c)}
                state={isPicked ? 'picked' : 'kept'}
                trailing={isPicked ? 'picked' : null}
              />
            );
          })}
          {dropped.map((d, i) => (
            <CandidateRow key={`${d.title}-${i}`} label={d.title} detail={d.reason} state="dropped" trailing={null} />
          ))}
        </ul>
      </FadeScroll>
    </div>
  );
}

/** One release candidate, in the timeline's row grammar — dot, one truncated line, detail
 * on hover — but a ranked verdict set, not a stream: no clock, no live head, so it stays a
 * plain list rather than borrowing `StepFeed`. The picked row is the bright one; dropped
 * rows dim and move their arr rejection essay into the hover. */
function CandidateRow({
  label,
  detail,
  state,
  trailing,
}: {
  label: string;
  detail: string;
  state: 'picked' | 'kept' | 'dropped';
  trailing: string | null;
}) {
  return (
    <li>
      <Marker className={cn('text-xs', state === 'picked' && 'text-foreground', state === 'dropped' && 'opacity-60')}>
        <MarkerIcon className="flex items-center justify-center">
          <span
            className={cn('size-1.5 rounded-full', state === 'picked' ? TONE_SOLID.success : 'bg-muted-foreground/40')}
          />
        </MarkerIcon>
        <HoverCard>
          <HoverCardTrigger render={<MarkerContent />} className="flex-1 truncate font-mono">
            {label}
          </HoverCardTrigger>
          <HoverCardContent side="top" align="start" className="w-96">
            <p className="text-xs leading-relaxed break-words">{detail}</p>
          </HoverCardContent>
        </HoverCard>
        {trailing && <span className="shrink-0 text-[0.7rem] text-muted-foreground">{trailing}</span>}
      </Marker>
    </li>
  );
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
