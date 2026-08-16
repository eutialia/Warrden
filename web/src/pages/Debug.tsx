import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTraces, fetchTrace, fetchTraceEntry, type TraceSummary, type TraceEntry } from '@/api';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch, type SseEvent } from '@/hooks/useSseRefetch';
import { TraceTimeline } from '@/components/TraceTimeline';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { formatRelativeTime } from '@/lib/utils';

const PIPELINES = ['acquire', 'ingest', 'subtitle'] as const;

export default function DebugPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const selectedJob = jobId !== undefined ? Number(jobId) : null;

  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [payloads, setPayloads] = useState<Record<number, unknown>>({});
  const [pipelineFilter, setPipelineFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Separate generations for the list and the per-job trace: they're independent data
  // streams, so a list tick must not invalidate an in-flight trace fetch and vice versa.
  const listGen = useFetchGeneration();
  const traceGen = useFetchGeneration();
  // Holds the current job's isStale() check so every payload fetch for that job (however
  // many entries get toggled open) shares it without bumping the generation on each other —
  // only a job switch (or unmount) should invalidate a pending payload fetch.
  const traceStaleRef = useRef<() => boolean>(() => false);

  const loadList = useCallback(
    (opts?: { isStale: () => boolean }) => {
      fetchTraces()
        .then((r) => {
          if (opts?.isStale()) return;
          setTraces(r.traces);
        })
        .catch(() => {
          if (opts?.isStale()) return;
          setTraces([]);
        });
    },
    [],
  );

  const loadTrace = useCallback(
    (opts?: { isStale: () => boolean }) => {
      if (selectedJob === null) return;
      fetchTrace(selectedJob)
        .then((r) => {
          if (opts?.isStale()) return;
          setEntries(r.entries);
        })
        .catch(() => {
          if (opts?.isStale()) return;
          setEntries([]);
        });
    },
    [selectedJob],
  );

  useEffect(() => {
    const isStale = listGen();
    loadList({ isStale });
    return () => {
      listGen();
    };
  }, [loadList, listGen]);

  useEffect(() => {
    const isStale = traceGen();
    traceStaleRef.current = isStale;
    // Clear immediately, not just selection/payload state — otherwise the previous job's
    // rows (and a stale timeline) linger on screen while the new job's fetch is in flight.
    setSelectedSeq(null);
    setPayloads({});
    setEntries([]);
    if (selectedJob !== null) loadTrace({ isStale });
    return () => {
      traceGen();
    };
  }, [selectedJob, loadTrace, traceGen]);

  // trace.appended is the whole point of this page's SSE traffic, so the default filter
  // (which excludes it to spare other pages the noise) has to be overridden here.
  useSseRefetch(loadList, 1000, true, useCallback(() => true, []));
  // Same-job SSE traffic deliberately isn't staleness-guarded (harmless: it's the current
  // job racing itself), matching JobDetail's rationale — the per-job effect above is what
  // actually protects against a stale *job switch* clobbering the current one.
  useSseRefetch(
    () => loadTrace(),
    0,
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
          (search === '' || t.targetTitle.toLowerCase().includes(search.toLowerCase())),
      ),
    [traces, pipelineFilter, search],
  );

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
    const isStale = traceStaleRef.current;
    fetchTraceEntry(selectedJob, entry.seq).then((full) => {
      if (isStale()) return;
      setPayloads((prev) => ({ ...prev, [entry.seq]: full.payload }));
    });
  };

  const childrenOf = (seq: number) => entries.filter((e) => e.parent_seq === seq);
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

      {selectedJob !== null && entries.length > 0 && (
        <>
          <TraceTimeline entries={entries} selectedSeq={selectedSeq} onSelect={setSelectedSeq} />
          <div className="divide-y rounded-md border">
            {entries
              .filter((e) => e.parent_seq === null)
              .map((e) => (
                <div key={e.seq} className={highlighted(e) ? 'bg-accent/50' : ''}>
                  <EntryRow entry={e} payload={payloads[e.seq]} onToggle={() => togglePayload(e)} onFocus={() => setSelectedSeq(e.seq)} />
                  {childrenOf(e.seq).map((child) => (
                    <div key={child.seq} className="pl-6">
                      <EntryRow
                        entry={child}
                        payload={payloads[child.seq]}
                        onToggle={() => togglePayload(child)}
                        onFocus={() => setSelectedSeq(e.seq)}
                      />
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  payload,
  onToggle,
  onFocus,
}: {
  entry: TraceEntry;
  payload: unknown;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const duration = entry.ts_end !== null ? `${entry.ts_end - entry.ts_start}ms` : 'running';
  return (
    <div className="px-3 py-2 text-xs">
      <div
        className="flex cursor-pointer items-center gap-2"
        onClick={() => {
          onFocus();
          onToggle();
        }}
      >
        <Badge variant={entry.status === 'error' ? 'destructive' : 'outline'}>{entry.status}</Badge>
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
