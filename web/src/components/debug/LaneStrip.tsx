import { useMemo, useRef, useState } from 'react';
import type { EventRow, TraceEntry } from '@/api';
import { buildTimeScale, effectiveNow, formatAt, LANES, laneOf, verdictTicks, type Lane } from '@/components/debug/laneModel';
import { traceStatusTone } from '@/lib/labels';
import { TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

const LABEL_W = 56;

export function LaneStrip({
  entries,
  events,
  jobTerminal,
  selectedSeq,
  onSelect,
}: {
  entries: TraceEntry[];
  events: EventRow[];
  jobTerminal: boolean;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  // Frozen per fetch, like the old TraceTimeline: every trace.appended replaces entries
  // and a ticker would only redraw bars nobody is timing.
  const now = useMemo(() => effectiveNow(entries, jobTerminal), [entries, jobTerminal]);
  const scale = useMemo(() => buildTimeScale(entries, now), [entries, now]);
  const byLane = useMemo(() => {
    const map = new Map<Lane, TraceEntry[]>(LANES.map((l) => [l, []]));
    for (const e of entries) {
      const lane = laneOf(e);
      if (lane) map.get(lane)!.push(e);
    }
    return map;
  }, [entries]);
  const verdicts = useMemo(() => verdictTicks(events), [events]);

  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const pct = (ts: number) => `${scale.toX(ts) * 100}%`;

  return (
    <div
      className="relative border-b bg-muted/30 px-3 pt-2 pb-1.5 select-none"
      onMouseMove={(ev) => {
        const el = trackRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setHoverX(Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1));
      }}
      onMouseLeave={() => setHoverX(null)}
    >
      <div className="relative mb-1 h-3 font-mono text-[10px] text-muted-foreground" style={{ marginLeft: LABEL_W + 8 }}>
        {scale.ticks.map((t) => (
          <span key={t.ts} className={cn('absolute whitespace-nowrap', t.x > 0.97 ? '-translate-x-full' : '-translate-x-1/2')} style={{ left: `${t.x * 100}%` }}>
            {t.label}
          </span>
        ))}
        {scale.idles.map((g) => (
          <span key={g.from} className="absolute -translate-x-1/2 opacity-70" style={{ left: `${((g.x0 + g.x1) / 2) * 100}%` }}>
            idle {formatAt(g.to - g.from).slice(1)}
          </span>
        ))}
      </div>
      <div className="relative">
        {LANES.map((lane) => (
          <div key={lane} className="grid h-[18px] items-center gap-2" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
            <span className="pr-1 text-right text-[10.5px] text-muted-foreground">{lane}</span>
            <div ref={lane === 'trigger' ? trackRef : undefined} className="relative h-3 border-t border-dashed border-border">
              {scale.idles.map((g) => (
                <span key={g.from} className="absolute top-0 bottom-0 bg-muted-foreground/10" style={{ left: `${g.x0 * 100}%`, width: `${(g.x1 - g.x0) * 100}%` }} />
              ))}
              {lane === 'verdicts'
                ? verdicts.map((v) => (
                    <span key={v.id} className={cn('absolute top-0.5 h-2 w-0.5 rounded-sm', TONE_SOLID[v.tone])} style={{ left: pct(v.ts) }} />
                  ))
                : byLane.get(lane)!.map((e) => <Bar key={e.seq} entry={e} now={now} jobTerminal={jobTerminal} selected={e.seq === selectedSeq} pct={pct} onSelect={onSelect} />)}
            </div>
          </div>
        ))}
        {hoverX !== null && (
          <div className={cn('pointer-events-none absolute top-0 bottom-0 w-px', TONE_SOLID.brand)} style={{ left: `calc(${LABEL_W + 8}px + (100% - ${LABEL_W + 8}px) * ${hoverX})` }}>
            <span className={cn('absolute top-0 left-1 font-mono text-[10px]', TONE_TEXT.brand)}>{formatAt(invert(scale, hoverX) - scale.start)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({
  entry,
  now,
  jobTerminal,
  selected,
  pct,
  onSelect,
}: {
  entry: TraceEntry;
  now: number;
  jobTerminal: boolean;
  selected: boolean;
  pct: (ts: number) => string;
  onSelect: (seq: number) => void;
}) {
  const interrupted = entry.status === 'running' && jobTerminal;
  const end = entry.ts_end ?? now;
  const span = end - entry.ts_start > 0;
  const tone = traceStatusTone(entry.status, interrupted);
  const site = entry.kind === 'subtitle.site' || entry.kind === 'subtitle.candidate';
  return (
    <button
      type="button"
      title={entry.summary}
      onClick={() => onSelect(entry.seq)}
      className={cn(
        'absolute top-0.5 h-2 rounded-sm',
        site ? 'bg-muted-foreground/25' : TONE_SOLID[tone],
        entry.status === 'running' && !interrupted && 'animate-pulse',
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
      )}
      style={{ left: pct(entry.ts_start), width: span ? `max(2px, calc(${pct(end)} - ${pct(entry.ts_start)}))` : '2px' }}
    />
  );
}

/** x → ts, by bisection on the (monotonic) scale. Only the hover label needs it. */
function invert(scale: { start: number; end: number; toX(ts: number): number }, x: number): number {
  let lo = scale.start;
  let hi = scale.end;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (scale.toX(mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
