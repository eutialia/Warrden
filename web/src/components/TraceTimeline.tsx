import { useMemo } from 'react';
import type { TraceEntry } from '@/api';
import { traceStatusTone } from '@/lib/labels';
import { TONE_SOLID } from '@/lib/tone';

const MIN_SEGMENT_PCT = 4;
const GAP_THRESHOLD_MS = 2000;

interface Segment {
  key: string;
  entry: TraceEntry | null; // null = idle gap
  interrupted: boolean;
  weight: number;
  label: string;
}

function buildSegments(entries: TraceEntry[], now: number, jobTerminal: boolean): Segment[] {
  const top = entries.filter((e) => e.parent_seq === null);
  const segments: Segment[] = [];
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const end = e.ts_end ?? now;
    segments.push({
      key: `s${e.seq}`,
      entry: e,
      interrupted: e.status === 'running' && jobTerminal,
      weight: Math.max(end - e.ts_start, 1),
      label: e.summary,
    });
    const next = top[i + 1];
    if (next && next.ts_start - end > GAP_THRESHOLD_MS) {
      segments.push({ key: `g${e.seq}`, entry: null, interrupted: false, weight: next.ts_start - end, label: 'waiting' });
    }
  }
  return segments;
}

/** What counts as "now" for weight math. A never-closed entry on a job that has already
 * finished is a step the job died inside of: measuring it against the wall clock would
 * grow its bar without bound and squeeze every real step to the minimum width, so a dead
 * job's clock stops at its own last timestamp instead. */
function effectiveNow(entries: TraceEntry[], jobTerminal: boolean): number {
  if (!jobTerminal) return Date.now();
  return entries.reduce((max, e) => Math.max(max, e.ts_end ?? e.ts_start), 0);
}

export function TraceTimeline({
  entries,
  jobTerminal,
  selectedSeq,
  onSelect,
}: {
  entries: TraceEntry[];
  jobTerminal: boolean;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  // `Date.now()` is frozen between recomputes on purpose: every trace.appended replaces
  // `entries` and re-runs this, and a ticker would only redraw bars nobody is timing.
  const segments = useMemo(() => buildSegments(entries, effectiveNow(entries, jobTerminal), jobTerminal), [entries, jobTerminal]);
  const total = segments.reduce((sum, s) => sum + s.weight, 0) || 1;
  // Min-width clamp: fast steps stay clickable; remaining space splits proportionally.
  return (
    <div className="flex h-10 w-full gap-0.5 rounded-md bg-muted p-1">
      {segments.map((s) => {
        const pct = Math.max((s.weight / total) * 100, s.entry ? MIN_SEGMENT_PCT : 1);
        if (!s.entry) {
          return (
            <div
              key={s.key}
              style={{ flexGrow: pct, flexBasis: 0 }}
              className="rounded-sm bg-muted-foreground/10"
              title={`${s.label} ${Math.round(s.weight / 1000)}s`}
            />
          );
        }
        const e = s.entry;
        // Only a genuinely live step pulses: an interrupted one is already over.
        const live = e.status === 'running' && !s.interrupted;
        return (
          <button
            key={s.key}
            style={{ flexGrow: pct, flexBasis: 0 }}
            onClick={() => onSelect(e.seq)}
            title={`${s.interrupted ? `${e.summary} (interrupted)` : e.summary} (${Math.round(s.weight / 1000)}s)`}
            className={`min-w-0 truncate rounded-sm px-1 text-[10px] text-white ${TONE_SOLID[traceStatusTone(e.status, s.interrupted)]} ${
              live ? 'animate-pulse' : ''
            } ${selectedSeq === e.seq ? 'ring-2 ring-ring' : ''}`}
          >
            {e.summary}
          </button>
        );
      })}
    </div>
  );
}
