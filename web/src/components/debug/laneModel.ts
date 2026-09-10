import type { EventRow, TraceEntry } from '@/api';
import { stepTone } from '@/components/activity/eventStep';
import type { Tone } from '@/lib/tone';

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

/** The agent step the loop ran for a call's decision: the next sibling under the same
 * site, if it is a tool. Anything else in between (a refusal, an escalation) means the
 * decision was not executed as such. */
export function turnOf(entries: TraceEntry[], callSeq: number): TraceEntry | null {
  const call = entries.find((e) => e.seq === callSeq);
  if (!call || call.parent_seq === null) return null;
  const next = entries.find((e) => e.seq > callSeq && e.parent_seq === call.parent_seq);
  return next && isToolKind(next.kind) ? next : null;
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
export const IDLE_SEGMENT_WEIGHT_MS = 1500;

export interface TimeScale {
  start: number;
  end: number;
  toX(ts: number): number;
  idles: { from: number; to: number; x0: number; x1: number }[];
  ticks: { ts: number; x: number; label: string }[];
}

/** Piecewise-linear: real time everywhere except inside an idle gap, which is drawn at a
 * fixed weight so a ten-minute settle wait cannot flatten the forty seconds of work
 * around it. */
export function buildTimeScale(entries: TraceEntry[], now: number): TimeScale {
  const roots = entries.filter((e) => e.parent_seq === null).sort((a, b) => a.ts_start - b.ts_start);
  const start = roots[0]?.ts_start ?? now;
  const end = Math.max(now, ...roots.map((e) => e.ts_end ?? now));

  const gaps: { from: number; to: number }[] = [];
  let reach = start;
  for (const e of roots) {
    if (e.ts_start - reach > IDLE_THRESHOLD_MS) gaps.push({ from: reach, to: e.ts_start });
    reach = Math.max(reach, e.ts_end ?? now);
  }

  const idleTotal = gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const weighted = Math.max(end - start - idleTotal + gaps.length * IDLE_SEGMENT_WEIGHT_MS, 1);

  const toX = (ts: number): number => {
    const t = Math.min(Math.max(ts, start), end);
    let w = 0;
    let cursor = start;
    for (const g of gaps) {
      if (t <= g.from) break;
      w += g.from - cursor;
      if (t < g.to) return (w + ((t - g.from) / (g.to - g.from)) * IDLE_SEGMENT_WEIGHT_MS) / weighted;
      w += IDLE_SEGMENT_WEIGHT_MS;
      cursor = g.to;
    }
    w += t - cursor;
    return end === start ? 1 : w / weighted;
  };

  const idles = gaps.map((g) => ({ ...g, x0: toX(g.from), x1: toX(g.to) }));
  const ticks = tickTimes(start, end, gaps).map((ts) => ({ ts, x: toX(ts), label: formatAt(ts - start).slice(1) }));
  return { start, end, toX, idles, ticks };
}

function activeBetween(from: number, to: number, gaps: { from: number; to: number }[]): number {
  const idle = gaps.reduce((sum, g) => sum + Math.max(0, Math.min(to, g.to) - Math.max(from, g.from)), 0);
  return to - from - idle;
}

const TICK_STEPS = [500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];

/** The real timestamp `activeOffset` ms of work after `start`. A budget that runs out exactly
 * at the mouth of a gap resolves to the far edge, which is where the work resumes. */
function realAt(start: number, activeOffset: number, gaps: { from: number; to: number }[]): number {
  let t = start;
  let remaining = activeOffset;
  for (const g of gaps) {
    if (g.from <= t) continue;
    const span = g.from - t;
    if (remaining < span) return t + remaining;
    remaining -= span;
    t = g.to;
  }
  return t + remaining;
}

/** Ticks are spaced in active time, not real time: stepping in real time over a run whose
 * working stretches are each shorter than the step lands every tick inside an idle gap and
 * leaves the axis with one mark at zero. The step is the finest of the fixed set that still
 * keeps the axis at ten ticks or fewer. */
function tickTimes(start: number, end: number, gaps: { from: number; to: number }[]): number[] {
  const active = activeBetween(start, end, gaps);
  const step = TICK_STEPS.find((s) => active / s <= 10) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const out: number[] = [];
  for (let offset = 0; offset <= active; offset += step) out.push(realAt(start, offset, gaps));
  const last = out[out.length - 1]!;
  if (last < end && activeBetween(last, end, gaps) > step / 2) out.push(end);
  return out;
}

export function effectiveNow(entries: TraceEntry[], jobTerminal: boolean): number {
  if (!jobTerminal) return Date.now();
  return entries.reduce((max, e) => Math.max(max, e.ts_end ?? e.ts_start), 0);
}

export function formatAt(ms: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `+${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `+${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// `_now` is unused on purpose: a live duration ticks from `ElapsedTime`, never a frozen
// string. The parameter stays so callers keep passing the clock an interrupted check needs.
export function formatTook(entry: TraceEntry, _now: number, jobTerminal: boolean): string {
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
