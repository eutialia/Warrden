import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventRow, TraceEntry } from '@/api';
import {
  axisTicks,
  buildTimeScale,
  effectiveNow,
  formatAt,
  formatTook,
  invert,
  LANES,
  laneOf,
  runFacts,
  verdictTicks,
  type Lane,
} from '@/components/debug/laneModel';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { traceStatusTone } from '@/lib/labels';
import { TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { clamp, cn } from '@/lib/utils';

const LABEL_W = 72;
const TRACK_LEFT = LABEL_W + 8;
const LANE_H = 18;
const MIN_WINDOW = 1 / 500;
const DRAG_SLOP = 4;
const IDLE_LABEL_MIN_PX = 40;
const TIP = 'gap-1 px-2 py-1 font-mono text-[10px]';

interface View {
  x0: number;
  x1: number;
}

const FULL: View = { x0: 0, x1: 1 };

function clampWindow(x0: number, width: number): View {
  const w = clamp(width, MIN_WINDOW, 1);
  const start = clamp(x0, 0, 1 - w);
  return { x0: start, x1: start + w };
}

/** Bars, instantaneous ticks and verdict ticks all share this: clamped into the track, and
 * never past the right edge, where a 2px tick would fall out of `overflow-hidden`. */
function place(x0: number, x1 = x0): { left: string; width: string } {
  const a = clamp(x0, 0, 1);
  return { left: `min(${a * 100}%, calc(100% - 2px))`, width: `max(2px, ${(clamp(x1, 0, 1) - a) * 100}%)` };
}

/** Left offset inside the lanes container, whose track starts after the lane labels. */
function trackX(x: number): string {
  return `calc(${TRACK_LEFT}px + (100% - ${TRACK_LEFT}px) * ${x})`;
}

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
  // Frozen per fetch: every trace.appended replaces entries, and a ticker would only
  // redraw bars nobody is timing.
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

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const rect = useRef({ left: 0, width: 0 });
  const drag = useRef<{ pointerId: number; clientX: number; x0: number; moved: boolean } | null>(null);
  const [trackW, setTrackW] = useState(0);
  const [view, setView] = useState<View>(FULL);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      rect.current = { left: r.left, width: r.width };
      setTrackW(r.width);
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const span = view.x1 - view.x0;
  const zoomed = span < 1;
  const vx = (ts: number) => (scale.toX(ts) - view.x0) / span;
  const ticks = useMemo(() => axisTicks(scale, view.x0, view.x1), [scale, view.x0, view.x1]);
  const bands = useMemo(
    () =>
      scale.idles
        .map((g) => ({ ...g, a: (g.x0 - view.x0) / span, b: (g.x1 - view.x0) / span }))
        .filter((g) => g.b >= 0 && g.a <= 1),
    [scale, view.x0, span],
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = rect.current;
      if (!r.width) return;
      // Line and page deltas are in rows and screens; the pixel maths below needs pixels.
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? LANE_H * LANES.length : 1;
      const [dx, dy] = [ev.deltaX * unit, ev.deltaY * unit];
      const px = clamp((ev.clientX - r.left) / r.width, 0, 1);
      setView((v) => {
        const w = v.x1 - v.x0;
        if (Math.abs(dx) > Math.abs(dy)) return clampWindow(v.x0 + (dx / r.width) * w, w);
        const next = w / Math.exp(-dy * 0.0025);
        return clampWindow(v.x0 + px * w - px * clamp(next, MIN_WINDOW, 1), next);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const crosshair = (clientX: number) => {
    const line = lineRef.current;
    const label = labelRef.current;
    if (!line || !label || !rect.current.width) return;
    const px = clamp((clientX - rect.current.left) / rect.current.width, 0, 1);
    line.style.display = '';
    line.style.left = trackX(px);
    label.classList.toggle('right-1', px > 0.85);
    label.classList.toggle('left-1', px <= 0.85);
    label.textContent = formatAt(invert(scale, view.x0 + px * span) - scale.start);
  };

  const select = useCallback((seq: number) => {
    if (!drag.current?.moved) onSelect(seq);
  }, [onSelect]);

  return (
    <TooltipProvider delay={0} closeDelay={0}>
      <div
        ref={rootRef}
        className={cn('relative border-b bg-muted/30 px-3 pt-1.5 pb-1.5 select-none', zoomed && 'cursor-grab active:cursor-grabbing')}
        onPointerDown={(ev) => {
          const el = trackRef.current;
          if (el) {
            const r = el.getBoundingClientRect();
            rect.current = { left: r.left, width: r.width };
          }
          drag.current = { pointerId: ev.pointerId, clientX: ev.clientX, x0: view.x0, moved: false };
        }}
        onPointerMove={(ev) => {
          crosshair(ev.clientX);
          const d = drag.current;
          if (!d || d.pointerId !== ev.pointerId || ev.buttons !== 1 || !rect.current.width) return;
          const dx = ev.clientX - d.clientX;
          if (!d.moved) {
            // At 1x there is nothing to pan, so a jittery click still selects its bar.
            if (!zoomed || Math.abs(dx) <= DRAG_SLOP) return;
            d.moved = true;
            rootRef.current?.setPointerCapture(ev.pointerId);
          }
          setView((v) => clampWindow(d.x0 - (dx / rect.current.width) * (v.x1 - v.x0), v.x1 - v.x0));
        }}
        onPointerUp={(ev) => {
          if (drag.current?.moved) rootRef.current?.releasePointerCapture(ev.pointerId);
        }}
        // Bubble phase, after the bars' own handlers have read `moved`: the click that ends a
        // pan must still be swallowed, but the next one — a keyboard Enter with no pointerdown
        // in front of it — must not be.
        onClick={() => {
          if (drag.current) drag.current.moved = false;
        }}
        onPointerLeave={() => {
          if (lineRef.current) lineRef.current.style.display = 'none';
        }}
        onDoubleClick={() => setView(FULL)}
      >
        <div className="flex h-5 items-center gap-2 text-[11px]">
          <span className="font-medium text-foreground">Timeline</span>
          <span className="truncate text-muted-foreground">{runFacts(scale)}</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">{(1 / span).toFixed(1)}×</span>
            {zoomed && (
              <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px]" onClick={() => setView(FULL)}>
                reset
              </Button>
            )}
            <span className="text-muted-foreground/70">scroll to zoom · drag to pan</span>
          </span>
        </div>
        <div className="relative mb-1 h-3 overflow-hidden font-mono text-[10px] text-muted-foreground" style={{ marginLeft: TRACK_LEFT }}>
          {ticks.map((t) => (
            <span key={t.ts} className={cn('absolute whitespace-nowrap', t.x > 0.97 ? '-translate-x-full' : t.x < 0.03 ? '' : '-translate-x-1/2')} style={{ left: `${t.x * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="relative">
          {bands.map((g) => (
            <Tooltip key={g.from}>
              <TooltipTrigger
                render={
                  <span
                    className="pointer-events-auto absolute top-0 bottom-0 bg-muted-foreground/10"
                    style={{ left: trackX(clamp(g.a, 0, 1)), width: `calc((100% - ${TRACK_LEFT}px) * ${clamp(g.b, 0, 1) - clamp(g.a, 0, 1)})` }}
                  />
                }
              />
              <TooltipContent className={TIP}>idle {formatAt(g.to - g.from).slice(1)}</TooltipContent>
            </Tooltip>
          ))}
          {bands.map((g) => {
            const [a, b] = [Math.max(g.a, 0), Math.min(g.b, 1)];
            if ((b - a) * trackW < IDLE_LABEL_MIN_PX) return null;
            return (
              <span
                key={g.from}
                className="pointer-events-none absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
                style={{ left: trackX((a + b) / 2) }}
              >
                idle {formatAt(g.to - g.from).slice(1)}
              </span>
            );
          })}
          {LANES.map((lane) => {
            const items = lane === 'verdicts' ? verdicts : byLane.get(lane)!;
            return (
              <div key={lane} className="grid items-center gap-2" style={{ height: LANE_H, gridTemplateColumns: `${LABEL_W}px 1fr` }}>
                <span className="flex items-baseline justify-end gap-1 pr-1 text-[10.5px] text-muted-foreground">
                  {lane}
                  <span className="w-4 text-right font-mono text-[9.5px] text-muted-foreground/70">{items.length || ''}</span>
                </span>
                {/* Transparent to the pointer so the idle bands underneath can be hovered; the
                    bars inside take their own hits back. */}
                <div ref={lane === 'trigger' ? trackRef : undefined} className="pointer-events-none relative h-3 overflow-hidden border-t border-dashed border-border">
                  {lane === 'verdicts'
                    ? verdicts.map((v) => {
                        const x = vx(v.ts);
                        if (x < 0 || x > 1) return null;
                        return (
                          <Tooltip key={v.id}>
                            <TooltipTrigger
                              render={
                                <span
                                  className={cn('pointer-events-auto absolute top-0.5 h-2 rounded-sm opacity-80 transition-opacity duration-[120ms] hover:z-10 hover:opacity-100', TONE_SOLID[v.tone])}
                                  style={place(x)}
                                />
                              }
                            />
                            <TooltipContent className={TIP}>verdict · {v.tone}</TooltipContent>
                          </Tooltip>
                        );
                      })
                    : byLane
                        .get(lane)!
                        .map((e) => <Bar key={e.seq} entry={e} now={now} jobTerminal={jobTerminal} selected={e.seq === selectedSeq} vx={vx} onSelect={select} />)}
                </div>
              </div>
            );
          })}
          <div ref={lineRef} className={cn('pointer-events-none absolute top-0 bottom-0 w-px', TONE_SOLID.brand)} style={{ display: 'none' }}>
            <span ref={labelRef} className={cn('absolute top-0 left-1 font-mono text-[10px] whitespace-nowrap', TONE_TEXT.brand)} />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Bar({
  entry,
  now,
  jobTerminal,
  selected,
  vx,
  onSelect,
}: {
  entry: TraceEntry;
  now: number;
  jobTerminal: boolean;
  selected: boolean;
  vx: (ts: number) => number;
  onSelect: (seq: number) => void;
}) {
  const interrupted = entry.status === 'running' && jobTerminal;
  const end = entry.ts_end ?? now;
  const x0 = vx(entry.ts_start);
  const x1 = vx(end);
  if (x1 < 0 || x0 > 1) return null;
  const tone = traceStatusTone(entry.status, interrupted);
  const site = entry.kind === 'subtitle.site' || entry.kind === 'subtitle.candidate';
  const took = formatTook(entry, jobTerminal);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onSelect(entry.seq)}
            className={cn(
              'pointer-events-auto absolute top-0.5 h-2 cursor-pointer rounded-sm opacity-80 transition-[opacity,box-shadow] duration-[120ms] hover:z-10 hover:opacity-100 hover:ring-1 hover:ring-ring',
              site ? 'bg-muted-foreground/25' : TONE_SOLID[tone],
              // Parallel calls land on one 8px row; the hairline end is what makes twenty-three
              // simultaneous requests read as twenty-three and not as one long bar.
              end > entry.ts_start && 'border-r border-background/60',
              entry.status === 'running' && !interrupted && 'animate-pulse',
              selected && 'opacity-100 ring-2 ring-ring ring-offset-1 ring-offset-background',
            )}
            style={place(x0, x1)}
          />
        }
      />
      <TooltipContent className={cn(TIP, 'max-w-none')}>
        <span>{entry.kind}</span>
        {entry.summary && (
          <>
            <span>·</span>
            <span className="max-w-[60ch] truncate">{entry.summary}</span>
          </>
        )}
        {took !== '·' && (
          <>
            <span>·</span>
            <span>{took}</span>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
