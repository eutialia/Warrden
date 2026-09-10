import { useEffect, useMemo, useRef, useState } from 'react';
import type { TraceEntry } from '@/api';
import { childrenBySeq, effectiveNow, escalations, formatAt, formatTook, isToolKind } from '@/components/debug/laneModel';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { traceStatusLabel, traceStatusTone } from '@/lib/labels';
import { TONE_SOLID } from '@/lib/tone';
import { cn } from '@/lib/utils';

export function Waterfall({
  entries,
  jobTerminal,
  selectedSeq,
  onSelect,
  emptyLabel,
}: {
  entries: TraceEntry[];
  jobTerminal: boolean;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  emptyLabel: string;
}) {
  // Depth 0 is the run's spine and stays open unless collapsed by hand; deeper levels
  // start closed, so `expanded` reads as "closed" up top and "opened" below.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const kids = useMemo(() => childrenBySeq(entries), [entries]);
  const roots = useMemo(() => entries.filter((e) => e.parent_seq === null), [entries]);
  const now = useMemo(() => effectiveNow(entries, jobTerminal), [entries, jobTerminal]);
  const start = roots[0]?.ts_start ?? 0;
  const rowRefs = useRef(new Map<number, HTMLDivElement | null>());
  const jobKey = entries.length === 0 ? null : entries[0]!.job_id;

  useEffect(() => {
    setExpanded(new Set());
    rowRefs.current.clear();
  }, [jobKey]);

  useEffect(() => {
    if (selectedSeq !== null) rowRefs.current.get(selectedSeq)?.scrollIntoView({ block: 'nearest' });
  }, [selectedSeq]);

  const toggle = (seq: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  if (entries.length === 0) return <p className="px-4 py-6 text-xs text-muted-foreground">{emptyLabel}</p>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto text-xs">
      <div className="sticky top-0 grid grid-cols-[22px_minmax(0,1fr)_112px] gap-2 border-b bg-background px-3 py-1 font-mono text-[10.5px] text-muted-foreground">
        <span />
        <span>step</span>
        <span className="text-right">at · took</span>
      </div>
      {roots.map((e) => (
        <Node
          key={e.seq}
          entry={e}
          depth={0}
          kids={kids}
          expanded={expanded}
          now={now}
          start={start}
          jobTerminal={jobTerminal}
          selectedSeq={selectedSeq}
          rowRefs={rowRefs}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface NodeProps {
  entry: TraceEntry;
  depth: number;
  kids: Map<number, TraceEntry[]>;
  expanded: Set<number>;
  now: number;
  start: number;
  jobTerminal: boolean;
  selectedSeq: number | null;
  rowRefs: React.RefObject<Map<number, HTMLDivElement | null>>;
  onToggle: (seq: number) => void;
  onSelect: (seq: number) => void;
}

function Node(props: NodeProps) {
  const { entry, depth, kids, expanded, now, start, jobTerminal, selectedSeq, rowRefs, onToggle, onSelect } = props;
  const children = kids.get(entry.seq) ?? [];
  const open = depth === 0 ? !expanded.has(entry.seq) : expanded.has(entry.seq);
  const interrupted = entry.status === 'running' && jobTerminal;
  const tone = traceStatusTone(entry.status, interrupted);
  const selected = entry.seq === selectedSeq;
  const escalated = entry.kind === 'subtitle.site' ? escalations(children) : 0;

  return (
    <>
      <div
        ref={(el) => {
          rowRefs.current.set(entry.seq, el);
        }}
        onClick={() => onSelect(entry.seq)}
        className={cn(
          'grid min-h-[27px] cursor-pointer grid-cols-[22px_minmax(0,1fr)_112px] items-center gap-2 border-b px-3 hover:bg-accent',
          selected && 'bg-accent shadow-[inset_2px_0_0_var(--ring)]',
        )}
      >
        <span className="flex items-center justify-center">
          <span
            title={traceStatusLabel(entry.status, interrupted)}
            className={cn('size-1.5 rounded-full', TONE_SOLID[tone], entry.status === 'running' && !interrupted && 'animate-pulse')}
          />
        </span>
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap" style={{ paddingLeft: depth * 18 }}>
          <button
            type="button"
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggle(entry.seq);
            }}
            className={cn('w-3 shrink-0 text-[10px] text-muted-foreground', children.length === 0 && 'invisible')}
          >
            {open ? '▾' : '▸'}
          </button>
          <span className="w-[84px] shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={entry.kind}>
            {entry.kind}
          </span>
          <span className={cn('truncate', depth > 0 && 'text-muted-foreground', entry.status === 'error' && 'text-destructive-foreground')}>{entry.summary}</span>
          {entry.side_effect === 1 && (
            <Badge variant="outline" className="border-warning-border px-1 py-0 font-mono text-[10px] text-warning-foreground" title="Changed state outside Warrden">
              write
            </Badge>
          )}
          {isToolKind(entry.kind) && (
            <Badge variant="outline" className="border-info-border px-1 py-0 font-mono text-[10px] text-info-foreground" title="An action the model chose and the loop ran">
              tool
            </Badge>
          )}
          {escalated > 0 && <ToneBadge tone="warning">escalated{escalated > 1 ? ` ×${escalated}` : ''}</ToneBadge>}
        </div>
        <span className="flex justify-end gap-2 font-mono text-[10.5px] text-muted-foreground">
          <span className="opacity-60">{formatAt(entry.ts_start - start)}</span>
          <span>{formatTook(entry, now, jobTerminal)}</span>
        </span>
      </div>
      {open && children.map((c) => <Node key={c.seq} {...props} entry={c} depth={depth + 1} />)}
    </>
  );
}
