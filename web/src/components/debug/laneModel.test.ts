import { describe, expect, it } from 'vitest';
import type { EventRow, TraceEntry } from '@/api';
import {
  axisTicks,
  buildTimeScale,
  childrenBySeq,
  effectiveNow,
  escalations,
  formatAt,
  formatTook,
  IDLE_THRESHOLD_MS,
  invert,
  isToolKind,
  laneOf,
  ranTool,
  runFacts,
  turnOf,
  verdictTicks,
} from '@/components/debug/laneModel';

function entry(over: Partial<TraceEntry> & { seq: number }): TraceEntry {
  return {
    id: over.seq,
    job_id: 1,
    parent_seq: null,
    kind: 'pipeline.step',
    summary: '',
    side_effect: 0,
    status: 'ok',
    ts_start: 0,
    ts_end: 0,
    hasPayload: false,
    ...over,
  };
}

describe('laneOf', () => {
  it.each([
    ['trigger.webhook', 0, 'trigger'],
    ['trigger.reconcile', 0, 'trigger'],
    ['arr.request', 0, 'arr'],
    ['subtitle.site', 0, 'agent'],
    ['agent.search', 0, 'agent'],
    ['agent.step', 0, 'agent'],
    ['llm.call', 0, 'llm'],
    ['llm.attempt', 0, null],
    ['media.extract', 0, 'media'],
    ['media.drift', 0, 'media'],
    ['media.resync', 0, 'media'],
    ['subtitle.candidate', 0, 'media'],
    ['pipeline.place', 1, 'writes'],
    ['subtitle.quarantine', 1, 'writes'],
    ['knowledge.update', 1, 'writes'],
    ['arr.request', 1, 'writes'],
    ['acquire.season', 0, null],
    ['acquire.pick', 0, null],
    ['acquire.skip', 0, null],
    ['pipeline.assess', 0, null],
    ['pipeline.rescue', 0, null],
    ['pipeline.sweep', 0, null],
    ['ingest.sidecar', 0, null],
    ['ingest.match', 0, null],
    ['subtitle.filter', 0, null],
    ['subtitle.reconcile', 0, null],
    ['subtitle.cache', 0, null],
    ['subtitle.map', 0, null],
    ['knowledge.unchanged', 0, null],
  ] as const)('%s side_effect=%d → %s', (kind, side, lane) => {
    expect(laneOf(entry({ seq: 0, kind, side_effect: side }))).toBe(lane);
  });
});

describe('isToolKind', () => {
  it.each(['agent.search', 'agent.open', 'agent.download', 'agent.request'])('%s is a tool', (k) => {
    expect(isToolKind(k)).toBe(true);
  });
  it.each(['agent.escalate', 'agent.give_up', 'agent.refused', 'agent.malformed', 'agent.step', 'llm.call'])('%s is not', (k) => {
    expect(isToolKind(k)).toBe(false);
  });
});

describe('escalations', () => {
  it('counts agent.escalate children only', () => {
    const kids = [entry({ seq: 1, kind: 'agent.search' }), entry({ seq: 2, kind: 'agent.escalate' }), entry({ seq: 3, kind: 'agent.escalate' })];
    expect(escalations(kids)).toBe(2);
    expect(escalations([])).toBe(0);
  });
});

describe('turnOf', () => {
  const site = entry({ seq: 4, kind: 'subtitle.site' });
  const call = entry({ seq: 7, kind: 'llm.call', parent_seq: 4 });
  const attempt = entry({ seq: 8, kind: 'llm.attempt', parent_seq: 7 });
  const ran = entry({ seq: 9, kind: 'agent.download', parent_seq: 4 });
  const escalate = entry({ seq: 10, kind: 'agent.escalate', parent_seq: 4 });
  const nextCall = entry({ seq: 11, kind: 'llm.call', parent_seq: 4 });

  it('is the executed sibling right after the call, skipping the call\'s own children', () => {
    expect(turnOf([site, call, attempt, ran, escalate, nextCall], 7)).toBe(ran);
  });
  it('is null when the next sibling is not a tool step', () => {
    expect(turnOf([site, call, attempt, escalate, ran], 7)).toBeNull();
  });
  it('is null when the chosen action was refused before it ran', () => {
    const refused = entry({ seq: 10, kind: 'agent.refused', parent_seq: 4 });
    const rows = [site, call, attempt, ran, refused];
    expect(turnOf(rows, 7)).toBeNull();
    expect(ranTool(ran, rows)).toBe(false);
    expect(ranTool(ran, [site, call, attempt, ran, escalate])).toBe(true);
  });
  it('is null for a call with no parent (not under a site)', () => {
    const top = entry({ seq: 2, kind: 'llm.call' });
    expect(turnOf([top, entry({ seq: 3, kind: 'agent.download' })], 2)).toBeNull();
  });
});

describe('verdictTicks', () => {
  const ev = (id: number, data: Record<string, unknown>, level = 'info'): EventRow =>
    ({ id, ts: id * 1000, kind: 'x', level, job_id: 1, message: '', data }) as EventRow;
  it('keeps verdict-carrying and attention rows, with their tone', () => {
    const rows = [
      ev(1, { scope: 'run', action: 'finished', verdict: { tone: 'success' } }),
      ev(2, { scope: 'run', action: 'finished', verdict: { tone: 'neutral' } }),
      ev(3, { scope: 'subtitle', action: 'unresolved' }, 'attention'),
      ev(4, { scope: 'trigger', action: 'webhook' }),
    ];
    expect(verdictTicks(rows)).toEqual([
      { id: 1, ts: 1000, tone: 'success' },
      { id: 3, ts: 3000, tone: 'warning' },
    ]);
  });
});

describe('buildTimeScale', () => {
  const roots = [
    entry({ seq: 0, ts_start: 0, ts_end: 1000 }),
    entry({ seq: 1, ts_start: 1500, ts_end: 2000 }),
    // 10s idle
    entry({ seq: 2, ts_start: 12_000, ts_end: 13_000 }),
    entry({ seq: 3, parent_seq: 2, ts_start: 12_100, ts_end: 12_200 }),
  ];
  const scale = buildTimeScale(roots, 13_000);

  it('spans first start to now', () => {
    expect(scale.start).toBe(0);
    expect(scale.end).toBe(13_000);
    expect(scale.toX(0)).toBe(0);
    expect(scale.toX(13_000)).toBe(1);
  });
  it('compresses one idle gap past the threshold and none under it', () => {
    expect(scale.idles).toHaveLength(1);
    expect(scale.idles[0]).toMatchObject({ from: 2000, to: 12_000 });
    const under = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 100 }), entry({ seq: 1, ts_start: 100 + IDLE_THRESHOLD_MS, ts_end: 3000 })], 3000);
    expect(under.idles).toHaveLength(0);
  });
  it('is monotonic across the idle and the idle takes less width than its real length', () => {
    const xs = [0, 1000, 2000, 7000, 12_000, 13_000].map(scale.toX);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
    const idleWidth = scale.toX(12_000) - scale.toX(2000);
    const activeWidth = scale.toX(2000) - scale.toX(0);
    expect(idleWidth).toBeLessThan(activeWidth);
  });
  it('ignores children when finding gaps', () => {
    expect(scale.idles.some((g) => g.from === 12_200)).toBe(false);
  });
  it('ticks in active time: 3s of work takes a 500ms step, and the tick whose budget runs out at the mouth of the gap resolves to its far edge', () => {
    expect(axisTicks(scale, 0, 1).map((t) => t.ts)).toEqual([0, 500, 1000, 1500, 12_000, 12_500, 13_000]);
  });
  it('ticks every 5s on an uninterrupted 25s run: 2s would land them closer than MIN_TICK_GAP', () => {
    const s = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 25_000 })], 25_000);
    expect(axisTicks(s, 0, 1).map((t) => t.ts)).toEqual([0, 5000, 10_000, 15_000, 20_000, 25_000]);
  });
  it('drops to a 200ms step on a 2s run', () => {
    const s = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 2000 })], 2000);
    expect(axisTicks(s, 0, 1).map((t) => t.ts)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
  });
  it('handles a single instantaneous entry without dividing by zero', () => {
    const s = buildTimeScale([entry({ seq: 0, ts_start: 5, ts_end: 5 })], 5);
    expect(s.toX(5)).toBe(1);
    expect(Number.isFinite(s.toX(5))).toBe(true);
  });
});

describe('invert', () => {
  const scale = buildTimeScale(
    [entry({ seq: 0, ts_start: 0, ts_end: 1000 }), entry({ seq: 1, ts_start: 12_000, ts_end: 13_000 })],
    13_000,
  );
  it.each([0, 500, 1000, 4000, 8000, 11_999, 12_000, 12_500, 13_000])('round-trips %dms across the idle gap', (ts) => {
    expect(invert(scale, scale.toX(ts))).toBeCloseTo(ts, 0);
  });
  it('stays finite over a span that is entirely idle', () => {
    const rows = [entry({ seq: 0, ts_start: 0, ts_end: 0 }), entry({ seq: 1, ts_start: 10_000, ts_end: 10_000 })];
    const idle = buildTimeScale(rows, effectiveNow(rows, true));
    expect(invert(idle, 0)).toBe(0);
    expect(invert(idle, 1)).toBe(10_000);
  });
});

describe('axisTicks', () => {
  const scale = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 25_000 })], 25_000);

  it('keeps the tick at the run start when the first working stretch is instantaneous', () => {
    const s = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 0 }), entry({ seq: 1, ts_start: 10_000, ts_end: 10_400 })], 10_400);
    const ticks = axisTicks(s, 0, 1);
    expect(ticks[0]).toMatchObject({ ts: 0, x: 0, label: '0.00s' });
  });

  it('over a zoomed window steps finer, stays inside the window, and maps x into view space', () => {
    const full = axisTicks(scale, 0, 1);
    const zoomed = axisTicks(scale, 0.2, 0.36);
    expect(zoomed.length).toBeGreaterThan(1);
    for (const t of zoomed) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(1);
      expect(t.ts).toBeGreaterThanOrEqual(4900);
      expect(t.ts).toBeLessThanOrEqual(9100);
    }
    const step = (ts: { ts: number }[]) => ts[1]!.ts - ts[0]!.ts;
    expect(step(zoomed)).toBeLessThan(step(full));
  });
  it('labels a deep zoom to distinct times: a 1s run at 20x still gets three ticks', () => {
    const s = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 1000 })], 1000);
    const labels = axisTicks(s, 0.5, 0.55).map((t) => t.label);
    expect(new Set(labels).size).toBeGreaterThanOrEqual(3);
  });
  it('remaps a zoomed window over an idle gap without leaving it', () => {
    const gapped = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 1000 }), entry({ seq: 1, ts_start: 600_000, ts_end: 601_000 })], 601_000);
    for (const t of axisTicks(gapped, 0.4, 0.9)) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(1);
    }
  });
});

describe('runFacts', () => {
  it('sums active time and idle time, and drops idle when there is none', () => {
    const gapped = buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 1000 }), entry({ seq: 1, ts_start: 601_000, ts_end: 601_900 })], 601_900);
    expect(runFacts(gapped)).toBe('1.9s active \u00b7 10m 0s idle');
    expect(runFacts(buildTimeScale([entry({ seq: 0, ts_start: 0, ts_end: 1900 })], 1900))).toBe('1.9s active');
  });
});

describe('effectiveNow', () => {
  it('stops a dead job\'s clock at its last timestamp', () => {
    const rows = [entry({ seq: 0, ts_start: 10, ts_end: 20 }), entry({ seq: 1, ts_start: 30, ts_end: null, status: 'running' })];
    expect(effectiveNow(rows, true)).toBe(30);
  });
  it('uses the wall clock for a live job', () => {
    const before = Date.now();
    expect(effectiveNow([entry({ seq: 0, ts_start: 0, ts_end: 1 })], false)).toBeGreaterThanOrEqual(before);
  });
});

describe('formatting', () => {
  it.each([
    [0, '+0.0s'],
    [4200, '+4.2s'],
    [59_949, '+59.9s'],
    [74_200, '+1m 14s'],
    [3_600_000, '+1h 0m'],
  ])('formatAt(%d) = %s', (ms, out) => {
    expect(formatAt(ms)).toBe(out);
  });
  it('formatTook reads duration, instantaneous, running and interrupted', () => {
    expect(formatTook(entry({ seq: 0, ts_start: 0, ts_end: 82 }), false)).toBe('82ms');
    expect(formatTook(entry({ seq: 0, ts_start: 0, ts_end: 3100 }), false)).toBe('3.1s');
    expect(formatTook(entry({ seq: 0, ts_start: 0, ts_end: 0 }), false)).toBe('·');
    expect(formatTook(entry({ seq: 0, ts_start: 0, ts_end: null, status: 'running' }), false)).toBe('running');
    expect(formatTook(entry({ seq: 0, ts_start: 0, ts_end: null, status: 'running' }), true)).toBe('interrupted');
  });
});

describe('childrenBySeq', () => {
  it('buckets by parent, preserving order', () => {
    const rows = [entry({ seq: 0 }), entry({ seq: 1, parent_seq: 0 }), entry({ seq: 2, parent_seq: 0 }), entry({ seq: 3 })];
    const map = childrenBySeq(rows);
    expect(map.get(0)?.map((e) => e.seq)).toEqual([1, 2]);
    expect(map.has(3)).toBe(false);
  });
});
