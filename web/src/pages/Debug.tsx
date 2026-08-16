import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { fetchTraces, fetchTrace, fetchTraceEntry, type TraceSummary, type TraceEntry } from '@/api';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch, type SseEvent } from '@/hooks/useSseRefetch';
import { TraceTimeline } from '@/components/TraceTimeline';
import { PageHeader } from '@/components/PageHeader';
import { ToneBadge } from '@/components/ToneBadge';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { traceStatusLabel, traceStatusTone } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

const PIPELINES = ['acquire', 'ingest', 'subtitle'] as const;
const STATUSES = ['pending', 'running', 'done', 'failed'] as const;

export default function DebugPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const selectedJob = jobId !== undefined ? Number(jobId) : null;

  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [payloads, setPayloads] = useState<Record<number, unknown>>({});
  const [pipelineFilter, setPipelineFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [jobTerminal, setJobTerminal] = useState(false);
  // Only entries explicitly opened are expanded: depth-0 rows start open (they're the
  // spine of the run), everything below starts collapsed so an LLM ladder or a 40-call
  // arr burst doesn't bury the shape of the job.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Per top-level seq, so a timeline click can scroll its block into view. Timeline
  // segments are top-level only, so nothing deeper needs a ref.
  const blockRefs = useRef(new Map<number, HTMLDivElement | null>());

  // Separate generations for the list and the per-job trace: they're independent data
  // streams, so a list tick must not invalidate an in-flight trace fetch and vice versa.
  const listGen = useFetchGeneration();
  const traceGen = useFetchGeneration();
  // A third generation, bumped only on a job switch (or unmount), so every payload fetch
  // for the current job shares one staleness check. It deliberately does NOT ride on
  // traceGen: the trace itself is refetched on every trace.appended, which would otherwise
  // invalidate payload fetches for the job still on screen.
  const payloadGen = useFetchGeneration();
  const payloadStaleRef = useRef<() => boolean>(() => false);

  // Both loaders take their own staleness token rather than accepting one, so a caller
  // can't forget to pass it (the SSE subscriptions below call them bare).
  const loadList = useCallback(() => {
    const isStale = listGen();
    fetchTraces()
      .then((r) => {
        if (isStale()) return;
        setTraces(r.traces);
      })
      .catch(() => {
        if (isStale()) return;
        setTraces([]);
      });
  }, [listGen]);

  const loadTrace = useCallback(() => {
    if (selectedJob === null) return;
    const isStale = traceGen();
    fetchTrace(selectedJob)
      .then((r) => {
        if (isStale()) return;
        setEntries(r.entries);
        setJobTerminal(r.jobTerminal);
      })
      .catch(() => {
        if (isStale()) return;
        setEntries([]);
        setJobTerminal(false);
      });
  }, [selectedJob, traceGen]);

  useEffect(() => {
    loadList();
    return () => {
      listGen();
    };
  }, [loadList, listGen]);

  useEffect(() => {
    payloadStaleRef.current = payloadGen();
    // Clear immediately, not just selection/payload state: otherwise the previous job's
    // rows (and a stale timeline) linger on screen while the new job's fetch is in flight.
    setSelectedSeq(null);
    setPayloads({});
    setEntries([]);
    setExpanded(new Set());
    setJobTerminal(false);
    blockRefs.current.clear();
    loadTrace();
    return () => {
      traceGen();
      payloadGen();
    };
  }, [selectedJob, loadTrace, traceGen, payloadGen]);

  // trace.appended is the whole point of this page's SSE traffic, so the default filter
  // (which excludes it to spare other pages the noise) has to be overridden here.
  useSseRefetch(loadList, 1000, true, useCallback(() => true, []));
  // Debounced rather than immediate: SqlTracer broadcasts twice per step (begin and end),
  // so a busy job would otherwise fire hundreds of uncoalesced full-trace GETs.
  useSseRefetch(
    loadTrace,
    250,
    selectedJob !== null,
    useCallback(
      (e: SseEvent | null) => e === null || (e.kind === 'trace.appended' && e.job_id === selectedJob),
      [selectedJob],
    ),
  );

  const shown = useMemo(
    () =>
      traces.filter(
        (t) =>
          (pipelineFilter === null || t.pipeline === pipelineFilter) &&
          (statusFilter === null || t.jobStatus === statusFilter) &&
          (search === '' || t.targetTitle.toLowerCase().includes(search.toLowerCase())),
      ),
    [traces, pipelineFilter, statusFilter, search],
  );

  // parent_seq -> children, built once per trace instead of a filter pass per row: an
  // arr-heavy job has hundreds of entries and the tree walks every one of them.
  const childrenBySeq = useMemo(() => {
    const map = new Map<number, TraceEntry[]>();
    for (const e of entries) {
      if (e.parent_seq === null) continue;
      const bucket = map.get(e.parent_seq);
      if (bucket) bucket.push(e);
      else map.set(e.parent_seq, [e]);
    }
    return map;
  }, [entries]);

  const roots = useMemo(() => entries.filter((e) => e.parent_seq === null), [entries]);

  // The other phases' traces for this exact target: the acquire that fed the ingest that
  // kicked off the subtitle run. Derived from the already-fetched list, so a target whose
  // sibling trace fell off the 100-row window simply doesn't show up.
  const sameTarget = useMemo(() => {
    const current = traces.find((t) => t.jobId === selectedJob);
    // A headless trace (job row gone) has no target triple, and matching null against
    // null would make every other headless trace look like the same target.
    if (!current || current.arrInstance === null) return [];
    return traces.filter(
      (t) =>
        t.jobId !== current.jobId &&
        t.arrInstance === current.arrInstance &&
        t.targetKind === current.targetKind &&
        t.targetId === current.targetId,
    );
  }, [traces, selectedJob]);

  const toggleExpanded = (seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const focusSeq = (seq: number) => {
    setSelectedSeq(seq);
    blockRefs.current.get(seq)?.scrollIntoView({ block: 'nearest' });
  };

  const togglePayload = (entry: TraceEntry) => {
    if (!entry.hasPayload || selectedJob === null) return;
    if (entry.seq in payloads) {
      setPayloads((prev) => {
        const next = { ...prev };
        delete next[entry.seq];
        return next;
      });
      return;
    }
    // Captured now, not read at resolution time: seqs restart per job, so without this a
    // late-resolving fetch from a job you've since navigated away from would write into
    // the new job's payloads map under a colliding seq, with no visual sign it's wrong.
    const isStale = payloadStaleRef.current;
    fetchTraceEntry(selectedJob, entry.seq)
      .then((full) => {
        if (isStale()) return;
        setPayloads((prev) => ({ ...prev, [entry.seq]: full.payload }));
      })
      .catch(() => {
        if (isStale()) return;
        toast.error('Could not load payload');
      });
  };

  const highlighted = (e: TraceEntry) => selectedSeq !== null && (e.seq === selectedSeq || e.parent_seq === selectedSeq);

  return (
    <div className="space-y-4">
      <PageHeader title="Debug" description="Per-job trace of every step a pipeline ran, in order, with payloads on demand." />

      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search title" value={search} onChange={(ev) => setSearch(ev.target.value)} className="max-w-xs" />
        {PIPELINES.map((p) => (
          <Badge
            key={p}
            variant={pipelineFilter === p ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => setPipelineFilter(pipelineFilter === p ? null : p)}
          >
            {p}
          </Badge>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {STATUSES.map((s) => (
          <Badge
            key={s}
            variant={statusFilter === s ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
          >
            {s}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {shown.map((t) => (
          <button
            key={t.jobId}
            onClick={() => navigate(`/debug/${t.jobId}`)}
            className={`rounded-md border px-3 py-1.5 text-left text-xs ${t.jobId === selectedJob ? 'border-ring bg-accent' : ''}`}
          >
            <span className="font-medium">{t.targetTitle}</span>
            <span className="ml-2 text-muted-foreground">
              {t.pipeline} · {t.entryCount} steps · {formatRelativeTime(t.lastTs)}
            </span>
          </button>
        ))}
        {shown.length === 0 && <p className="text-sm text-muted-foreground">No traces yet.</p>}
      </div>

      {selectedJob !== null && sameTarget.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Same target:</span>
          {sameTarget.map((t) => (
            <button key={t.jobId} onClick={() => navigate(`/debug/${t.jobId}`)} className="rounded border px-2 py-0.5 hover:bg-accent">
              {t.pipeline} #{t.jobId} · {t.jobStatus}
            </button>
          ))}
        </div>
      )}

      {selectedJob !== null && entries.length > 0 && (
        <>
          <TraceTimeline entries={entries} jobTerminal={jobTerminal} selectedSeq={selectedSeq} onSelect={focusSeq} />
          <div className="divide-y rounded-md border">
            {roots.map((e) => (
              <div
                key={e.seq}
                ref={(el) => {
                  blockRefs.current.set(e.seq, el);
                }}
              >
                <EntryNode
                  entry={e}
                  depth={0}
                  childrenBySeq={childrenBySeq}
                  expanded={expanded}
                  payloads={payloads}
                  jobTerminal={jobTerminal}
                  highlighted={highlighted}
                  onToggleExpanded={toggleExpanded}
                  onTogglePayload={togglePayload}
                  onFocus={setSelectedSeq}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface NodeProps {
  entry: TraceEntry;
  depth: number;
  childrenBySeq: Map<number, TraceEntry[]>;
  expanded: Set<number>;
  payloads: Record<number, unknown>;
  jobTerminal: boolean;
  highlighted: (e: TraceEntry) => boolean;
  onToggleExpanded: (seq: number) => void;
  onTogglePayload: (e: TraceEntry) => void;
  onFocus: (seq: number) => void;
}

/** One entry plus its subtree. Recursive rather than the old fixed parent+one-child pass:
 * `llm.attempt` sits three levels deep under a subtitle job (site -> llm.call -> attempt),
 * and any depth cap simply loses rows. */
function EntryNode(props: NodeProps) {
  const { entry, depth, childrenBySeq, expanded, payloads, jobTerminal, highlighted, onToggleExpanded, onTogglePayload, onFocus } = props;
  const kids = childrenBySeq.get(entry.seq) ?? [];
  // Depth 0 is the run's spine and stays open unless collapsed by hand; deeper levels start
  // closed, so `expanded` reads as "opened" up top and "still closed" below.
  const isOpen = depth === 0 ? !expanded.has(entry.seq) : expanded.has(entry.seq);

  return (
    <div className={highlighted(entry) ? 'bg-accent/50' : ''}>
      <div style={{ paddingLeft: depth * 20 }}>
        <EntryRow
          entry={entry}
          payload={payloads[entry.seq]}
          jobTerminal={jobTerminal}
          expandable={kids.length > 0}
          isOpen={isOpen}
          onExpand={() => onToggleExpanded(entry.seq)}
          onToggle={() => onTogglePayload(entry)}
          onFocus={() => onFocus(entry.seq)}
        />
      </div>
      {isOpen && kids.map((child) => <EntryNode key={child.seq} {...props} entry={child} depth={depth + 1} />)}
    </div>
  );
}

function EntryRow({
  entry,
  payload,
  jobTerminal,
  expandable,
  isOpen,
  onExpand,
  onToggle,
  onFocus,
}: {
  entry: TraceEntry;
  payload: unknown;
  jobTerminal: boolean;
  expandable: boolean;
  isOpen: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onFocus: () => void;
}) {
  // A running entry on a job that has already finished is a step the job died inside of:
  // it will never close, so it must not read (or pulse) as live work.
  const interrupted = entry.status === 'running' && jobTerminal;
  const duration = entry.ts_end !== null ? `${entry.ts_end - entry.ts_start}ms` : interrupted ? 'interrupted' : 'running';
  return (
    <div className="px-3 py-2 text-xs">
      <div
        className="flex cursor-pointer items-center gap-2"
        onClick={() => {
          onFocus();
          onToggle();
        }}
      >
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onExpand();
          }}
          className={`w-3 shrink-0 text-muted-foreground ${expandable ? '' : 'invisible'}`}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '▾' : '▸'}
        </button>
        <ToneBadge tone={traceStatusTone(entry.status, interrupted)} dot pulse={entry.status === 'running' && !interrupted}>
          {traceStatusLabel(entry.status, interrupted)}
        </ToneBadge>
        {entry.side_effect === 1 && (
          // The one flag worth surfacing on every row: this step changed something outside
          // Warrden (an arr grab, an import, a placed file), so it can't simply be re-run.
          <Badge variant="outline" className="border-warning-border px-1 py-0 text-[10px] text-warning-foreground" title="Changed state outside Warrden">
            write
          </Badge>
        )}
        <span className="font-mono text-muted-foreground">{entry.kind}</span>
        <span className="truncate">{entry.summary}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{duration}</span>
      </div>
      {payload !== undefined && (
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
          {typeof payload === 'object' && payload !== null && 'truncated' in payload
            ? String((payload as Record<string, unknown>).head)
            : JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
