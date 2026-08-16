import type { TraceEntry } from '@/api';

const MIN_SEGMENT_PCT = 4;
const GAP_THRESHOLD_MS = 2000;

interface Segment {
  key: string;
  entry: TraceEntry | null; // null = idle gap
  weight: number;
  label: string;
}

function buildSegments(entries: TraceEntry[], now: number): Segment[] {
  const top = entries.filter((e) => e.parent_seq === null);
  const segments: Segment[] = [];
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const end = e.ts_end ?? now;
    segments.push({ key: `s${e.seq}`, entry: e, weight: Math.max(end - e.ts_start, 1), label: e.summary });
    const next = top[i + 1];
    if (next && next.ts_start - end > GAP_THRESHOLD_MS) {
      segments.push({ key: `g${e.seq}`, entry: null, weight: next.ts_start - end, label: 'waiting' });
    }
  }
  return segments;
}

const STATUS_CLASS: Record<TraceEntry['status'], string> = {
  ok: 'bg-emerald-500/80',
  error: 'bg-red-500/80',
  running: 'bg-sky-500/80 animate-pulse',
};

export function TraceTimeline({
  entries,
  selectedSeq,
  onSelect,
}: {
  entries: TraceEntry[];
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  const segments = buildSegments(entries, Date.now());
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
              style={{ flexGrow: pct }}
              className="rounded-sm bg-muted-foreground/10"
              title={`${s.label} ${Math.round(s.weight / 1000)}s`}
            />
          );
        }
        const e = s.entry;
        return (
          <button
            key={s.key}
            style={{ flexGrow: pct }}
            onClick={() => onSelect(e.seq)}
            title={`${e.summary} (${Math.round(s.weight / 1000)}s)`}
            className={`min-w-0 truncate rounded-sm px-1 text-[10px] text-white ${STATUS_CLASS[e.status]} ${
              selectedSeq === e.seq ? 'ring-2 ring-ring' : ''
            }`}
          >
            {e.summary}
          </button>
        );
      })}
    </div>
  );
}
