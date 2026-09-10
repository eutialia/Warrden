import type { EventRow, TraceEntry } from '@/api';
import { stepTone } from '@/components/activity/eventStep';
import type { Tone } from '@/lib/tone';
import { clamp } from '@/lib/utils';

export type Lane = 'trigger' | 'arr' | 'agent' | 'llm' | 'media' | 'writes' | 'verdicts';
export const LANES: readonly Lane[] = ['trigger', 'arr', 'agent', 'llm', 'media', 'writes', 'verdicts'];

// A write goes to its own lane whatever its kind: "what changed outside Warrden" is the
// question that lane answers, and an arr grab is one of those before it is an arr call.
export function laneOf(entry: TraceEntry): Lane | null {
  if (entry.side_effect === 1) return 'writes';
  const { kind } = entry;
  if (kind.startsWith('trigger.')) return 'trigger';
  if (kind === 'arr.request') return 'arr';
  if (kind === 'subtitle.site' || kind.startsWith('agent.')) return 'agent';
  if (kind === 'llm.call') return 'llm';
  if (kind === 'subtitle.candidate' || kind.startsWith('media.')) return 'media';
  return null;
}

const TOOL_KINDS = new Set(['agent.search', 'agent.open', 'agent.download', 'agent.request']);

export function isToolKind(kind: string): boolean {
  return TOOL_KINDS.has(kind);
}

export function escalations(children: TraceEntry[]): number {
  return children.filter((c) => c.kind === 'agent.escalate').length;
}

function siblingAfter(entries: TraceEntry[], entry: TraceEntry): TraceEntry | undefined {
  return entries.find((e) => e.seq > entry.seq && e.parent_seq === entry.parent_seq);
}

/** A tool step the loop actually executed. The chosen action reaches the transcript
 * before the destination guard runs, so an `agent.refused` right behind it means the
 * action was blocked, not run. `entries` needs only to contain the entry's siblings. */
export function ranTool(entry: TraceEntry, entries: TraceEntry[]): boolean {
  return isToolKind(entry.kind) && siblingAfter(entries, entry)?.kind !== 'agent.refused';
}

/** The agent step the loop ran for a call's decision: the next sibling under the same
 * site, if it is a tool that ran. Anything else in between (a refusal, an escalation)
 * means the decision was not executed as such. */
export function turnOf(entries: TraceEntry[], callSeq: number): TraceEntry | null {
  const call = entries.find((e) => e.seq === callSeq);
  if (!call || call.parent_seq === null) return null;
  const next = siblingAfter(entries, call);
  return next && ranTool(next, entries) ? next : null;
}

export function verdictTicks(events: EventRow[]): { id: number; ts: number; tone: Tone }[] {
  const out: { id: number; ts: number; tone: Tone }[] = [];
  for (const e of events) {
    const tone = stepTone(e);
    if (tone !== undefined) out.push({ id: e.id, ts: e.ts, tone });
  }
  return out;
}

export const IDLE_THRESHOLD_MS = 2000;
// All idle gaps together draw one ninth of the strip, however many there are.
export const IDLE_SEGMENT_SHARE = 8;

export interface Gap {
  from: number;
  to: number;
}

export interface Tick {
  ts: number;
  x: number;
  label: string;
}

export interface TimeScale {
  start: number;
  end: number;
  toX(ts: number): number;
  idles: (Gap & { x0: number; x1: number })[];
}

/** Piecewise-linear: real time everywhere except inside an idle gap, which is drawn at a
 * fixed weight so a ten-minute settle wait cannot flatten the forty seconds of work
 * around it. */
export function buildTimeScale(entries: TraceEntry[], now: number): TimeScale {
  const roots = entries.filter((e) => e.parent_seq === null).sort((a, b) => a.ts_start - b.ts_start);
  const start = roots[0]?.ts_start ?? now;
  const end = Math.max(now, ...roots.map((e) => e.ts_end ?? now));

  const gaps: Gap[] = [];
  let reach = start;
  for (const e of roots) {
    if (e.ts_start - reach > IDLE_THRESHOLD_MS) gaps.push({ from: reach, to: e.ts_start });
    reach = Math.max(reach, e.ts_end ?? now);
  }

  const active = end - start - gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const idleWeight = Math.max(active / (IDLE_SEGMENT_SHARE * Math.max(gaps.length, 1)), 1);
  const weighted = Math.max(active + gaps.length * idleWeight, 1);

  const toX = (ts: number): number => {
    const t = clamp(ts, start, end);
    let w = 0;
    let cursor = start;
    for (const g of gaps) {
      if (t <= g.from) break;
      w += g.from - cursor;
      if (t < g.to) return (w + ((t - g.from) / (g.to - g.from)) * idleWeight) / weighted;
      w += idleWeight;
      cursor = g.to;
    }
    w += t - cursor;
    return end === start ? 1 : w / weighted;
  };

  return { start, end, toX, idles: gaps.map((g) => ({ ...g, x0: toX(g.from), x1: toX(g.to) })) };
}

type Scale = Pick<TimeScale, 'start' | 'end' | 'idles'>;

/** Drawn width of one millisecond of active time. Uniform, because the scale is linear
 * outside the gaps and every gap is drawn at the same fixed weight. */
function slopeOf(scale: Scale): number {
  const idleDrawn = scale.idles.reduce((sum, g) => sum + (g.x1 - g.x0), 0);
  // An all-idle span draws no active time at all; a zero slope would divide `invert` into NaN.
  return (1 - idleDrawn) / Math.max(activeBetween(scale.start, scale.end, scale.idles), 1) || 1;
}

/** x -> ts, the exact inverse of `toX`: linear outside the gaps, and inside one, the
 * fraction of its drawn segment is the fraction of its real length. */
export function invert(scale: Scale, x: number): number {
  const slope = slopeOf(scale);
  let cursor = scale.start;
  let w = 0;
  for (const g of scale.idles) {
    if (x < g.x1) {
      if (x <= g.x0) break;
      return g.from + ((x - g.x0) / (g.x1 - g.x0)) * (g.to - g.from);
    }
    cursor = g.to;
    w = g.x1;
  }
  return clamp(cursor + (x - w) / slope, scale.start, scale.end);
}

/** Ticks for the visible window `[x0, x1]` of scale space, with `x` remapped into that
 * window and the label still counted from the run's start. */
export function axisTicks(scale: TimeScale, x0: number, x1: number): Tick[] {
  const from = x0 <= 0 ? scale.start : invert(scale, x0);
  const to = x1 >= 1 ? scale.end : invert(scale, x1);
  const span = x1 - x0;
  const step = tickStep(slopeOf(scale) / span);
  const decimals = step < 100 ? 2 : step < 1000 ? 1 : 0;
  return tickTimes(from, to, scale.idles, step).map((ts) => ({
    ts,
    x: clamp((scale.toX(ts) - x0) / span, 0, 1),
    label: formatAt(ts - scale.start, decimals).slice(1),
  }));
}

function activeBetween(from: number, to: number, gaps: Gap[]): number {
  const idle = gaps.reduce((sum, g) => sum + Math.max(0, Math.min(to, g.to) - Math.max(from, g.from)), 0);
  return to - from - idle;
}

export function runFacts(scale: TimeScale): string {
  const active = activeBetween(scale.start, scale.end, scale.idles);
  const idle = scale.end - scale.start - active;
  const parts = [`${formatAt(active).slice(1)} active`];
  if (idle > 0) parts.push(`${formatAt(idle).slice(1)} idle`);
  return parts.join(' · ');
}

// Ticks closer together than this fraction of the drawn window overprint each other: an
// idle gap compresses the working stretches around it into a sliver, and ten ticks inside
// that sliver read as one smear. A tenth also caps the axis at ten ticks.
const MIN_TICK_GAP = 0.1;

const TICK_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];

/** The finest step whose ticks still land `MIN_TICK_GAP` apart, given the drawn fraction
 * one millisecond of active time takes in the window. */
function tickStep(drawn: number): number {
  return TICK_STEPS.find((s) => s * drawn >= MIN_TICK_GAP) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** The stretches of real work in `[from, to]`: the complement of the idle gaps. A `from`
 * inside a gap starts at that gap's far edge, which is where the work resumes. */
function activeSegments(from: number, to: number, gaps: Gap[]): Gap[] {
  const segments: Gap[] = [];
  let cursor = from;
  for (const g of gaps) {
    const start = Math.max(from, g.from);
    const end = Math.min(to, g.to);
    if (end <= start) continue;
    if (start > cursor) segments.push({ from: cursor, to: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < to) segments.push({ from: cursor, to });
  return segments;
}

/** Ticks are spaced in active time, not real time: stepping in real time over a run whose
 * working stretches are each shorter than the step lands every tick inside an idle gap and
 * leaves the axis with one mark at zero. */
function tickTimes(from: number, to: number, gaps: Gap[], step: number): number[] {
  const segments = activeSegments(from, to, gaps);
  const active = segments.reduce((sum, s) => sum + (s.to - s.from), 0);
  const inGap = gaps.some((g) => g.from < from && from < g.to);
  const realAt = (offset: number): number => {
    if (offset === 0 && !inGap) return from;
    let remaining = offset;
    let last = from;
    for (const s of segments) {
      if (remaining < s.to - s.from) return s.from + remaining;
      remaining -= s.to - s.from;
      last = s.to;
    }
    return last + remaining;
  };
  const out: number[] = [];
  for (let offset = 0; offset <= active; offset += step) out.push(realAt(offset));
  const last = out[out.length - 1]!;
  if (last < to && activeBetween(last, to, gaps) > step / 2) out.push(to);
  return out;
}

export function effectiveNow(entries: TraceEntry[], jobTerminal: boolean): number {
  if (!jobTerminal) return Date.now();
  return entries.reduce((max, e) => Math.max(max, e.ts_end ?? e.ts_start), 0);
}

export function formatAt(ms: number, decimals?: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(decimals ?? 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `+${minutes}m ${((ms % 60_000) / 1000).toFixed(decimals ?? 0)}s`;
  return `+${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTook(entry: TraceEntry, jobTerminal: boolean): string {
  if (entry.ts_end === null) return entry.status === 'running' && jobTerminal ? 'interrupted' : 'running';
  const ms = entry.ts_end - entry.ts_start;
  if (ms <= 0) return '·';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function childrenBySeq(entries: TraceEntry[]): Map<number, TraceEntry[]> {
  const map = new Map<number, TraceEntry[]>();
  for (const e of entries) {
    if (e.parent_seq === null) continue;
    const bucket = map.get(e.parent_seq);
    if (bucket) bucket.push(e);
    else map.set(e.parent_seq, [e]);
  }
  return map;
}
