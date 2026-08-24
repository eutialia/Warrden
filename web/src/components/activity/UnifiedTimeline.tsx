import { useRef, type ReactNode } from 'react';
import { ElapsedTime } from '@/components/activity/ElapsedTime';
import { FadeScroll } from '@/components/activity/FadeScroll';
import { StepFeed, type StepFeedItem } from '@/components/activity/StepFeed';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { TONE_SOLID, TONE_TEXT, type Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/**
 * A node that carries more than one line. Same rail, same clock, same place in the ordering
 * as a step — the difference is that its content is a `ReactNode` under the label instead of
 * a sentence behind a hover.
 *
 * This is the answer to the feed's real ceiling: a run's conclusions (the release it
 * grabbed and why) are structured, and squeezing them into one truncated line or a hover
 * card either loses them or hides them. A block says *what* something concluded, in the
 * flow, at the timestamp it happened — so nothing has to be lifted out into a detached card
 * above the timeline.
 *
 * It stays one row: it animates in as one, and it sorts by `ts` like everything else.
 *
 * Deliberately flat, in the same array as the steps, rather than a `{heading, steps}`
 * section tree:
 *
 *  - The event log *is* a flat, time-ordered stream. A conclusion has a timestamp like
 *    everything else; nesting means the adapter has to invent a hierarchy the DB does not
 *    guarantee (a site's conclusion can land after the next site's first step, and a
 *    `subtitle.site-failed` can arrive with no run row behind it).
 *  - Newest-on-top is one `reverse` on a flat list. On a section tree it is a flatten, a
 *    regroup, and empty-section pruning, done on every render.
 *  - Live-to-finished is then nothing special: a verdict appends like any other row and
 *    animates in above the steps it closes.
 */
export interface StepFeedBlock {
  kind: 'block';
  id: string;
  ts: number;
  tone?: Tone;
  /** The one line above the body — what a one-line verdict would have said. */
  label: string;
  body: ReactNode;
}

export type StepFeedRow = StepFeedItem | StepFeedBlock;

/** A plain step is the row with no `kind` — the shipped `StepFeedItem`, untouched.
 * Verdicts are plain steps too: a conclusion is one more thing that happened, so it reads
 * as a row rather than as a ruled line cutting the feed in half. */
export function isStep(row: StepFeedRow): row is StepFeedItem {
  return !('kind' in row);
}

/**
 * Which rows get to play their entrance.
 *
 * Only the ones that arrive *after* the feed is on screen. A row's key is its event id and
 * the animation is mount-triggered, so opening a run with five hundred rows in it would
 * otherwise fire five hundred simultaneous slide-ins — a wall of movement that says
 * "everything just happened" about a run that finished yesterday. Anything absent from the
 * set captured at mount is, by construction, mounting for the first time.
 */
function useEntranceGate(ids: Iterable<string | number>): (id: string | number) => boolean {
  const atMount = useRef<Set<string | number>>(undefined);
  atMount.current ??= new Set(ids);
  const seen = atMount.current;
  return (id) => !seen.has(id);
}

/**
 * One feed for every phase, live or finished. Steps go through the shipped `StepFeed` —
 * this owns only the blocks between them, so hover-for-detail, the pulsing live row and the
 * entrance animation stay in one place.
 */
export function UnifiedTimeline({
  rows,
  running,
  spinner = true,
  emptyLabel = 'Starting up…',
}: {
  rows: StepFeedRow[];
  running: boolean;
  /** See `StepFeed` — off while a job is merely queued. */
  spinner?: boolean;
  emptyLabel?: string;
}) {
  const isNew = useEntranceGate(rows.map((row) => row.id));

  if (rows.length === 0) {
    return running ? <StepFeed steps={[]} running spinner={spinner} emptyLabel={emptyLabel} isNew={isNew} /> : null;
  }

  // Newest first, so the segments are built oldest-first and the list is reversed once at
  // the end — the same direction the event log arrives in.
  const segments = toSegments(rows).reverse();

  // The live head is the newest *step*, not the newest row: a run that has just written a
  // season's pick block has that block on top while the next season is still searching, and
  // handing the pulse to index 0 would hide the spinner behind a finished conclusion.
  const liveAt = running ? segments.findIndex((segment) => segment.kind === 'steps') : -1;

  const body = (
    <div className="space-y-1">
      {/* Blocks all the way down and still working: the feed says so itself rather than
          looking finished. */}
      {running && liveAt === -1 && <StepFeed steps={[]} running spinner={spinner} emptyLabel={emptyLabel} isNew={isNew} />}
      {segments.map((segment, i) =>
        segment.kind === 'block' ? (
          <BlockRow key={segment.block.id} block={segment.block} entering={isNew(segment.block.id)} />
        ) : (
          <StepFeed key={segment.steps[0]!.id} steps={segment.steps} running={i === liveAt} isNew={isNew} />
        ),
      )}
    </div>
  );

  // One viewport for every feed, streaming or not: newest rows in view, the rest
  // scrolling under the fade. Short runs fit and show no fade at all.
  return <FadeScroll>{body}</FadeScroll>;
}

/** A stretch of steps, or one block on its own, so the two render paths stay disjoint and a
 * block never gets handed to `StepFeed`. */
export type Segment = { kind: 'steps'; steps: StepFeedItem[] } | { kind: 'block'; block: StepFeedBlock };

export function toSegments(rows: StepFeedRow[]): Segment[] {
  const segments: Segment[] = [];
  for (const row of rows) {
    if (!isStep(row)) {
      segments.push({ kind: 'block', block: row });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last?.kind === 'steps') last.steps.push(row);
    else segments.push({ kind: 'steps', steps: [row] });
  }
  return segments;
}

/**
 * A block in the feed's own grammar: the same 4-unit icon column and 2-unit gap a step
 * uses, so the dots line up down the left edge; the body indented to `pl-6` — where the
 * step labels start — so the column reads as continuous rather than as a card that
 * interrupted it.
 *
 * The dot is a size-2 tone fill against a step's size-1.5 grey: enough to read as "this one
 * concluded something" at a glance without becoming a different kind of object.
 */
function BlockRow({ block, entering }: { block: StepFeedBlock; entering: boolean }) {
  const tone = block.tone ?? 'neutral';
  return (
    <div className={cn(entering && 'animate-in duration-240 ease-panel fade-in-0 slide-in-from-top-1 motion-reduce:animate-none')}>
      <Marker className={cn('text-xs', TONE_TEXT[tone])}>
        <MarkerIcon className="flex items-center justify-center">
          <span className={cn('size-2 rounded-full', TONE_SOLID[tone])} />
        </MarkerIcon>
        <MarkerContent className="flex-1 truncate">{block.label}</MarkerContent>
        <ElapsedTime ts={block.ts} className="shrink-0 text-[0.7rem] text-muted-foreground/70" />
      </Marker>
      <div className="mt-1.5 mb-2 ml-6 rounded-md bg-muted/40 px-3 py-2.5">{block.body}</div>
    </div>
  );
}
