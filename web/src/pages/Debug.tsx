import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  apiErrorMessage,
  fetchJob,
  fetchJobs,
  fetchTrace,
  fetchTraceEntry,
  fetchTraces,
  type Job,
  type JobDetailResponse,
  type TraceEntry,
  type TraceSummary,
  type TraceUsage,
} from '@/api';
import { Inspector, type InspectorTab } from '@/components/debug/Inspector';
import { effectiveNow, turnOf } from '@/components/debug/laneModel';
import { LaneStrip } from '@/components/debug/LaneStrip';
import { TargetList } from '@/components/debug/TargetList';
import { TraceHeader } from '@/components/debug/TraceHeader';
import { Waterfall } from '@/components/debug/Waterfall';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch, type SseEvent } from '@/hooks/useSseRefetch';
import { ALL, jobTitle } from '@/lib/jobs';

// Matches MAX_LIMIT in src/server/app.ts: one wide window, filtered client-side like Activity.
const JOB_WINDOW = 1000;

export default function DebugPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const selectedJob = jobId !== undefined ? Number(jobId) : null;
  const seqParam = search.get('seq');
  const selectedSeq = seqParam === null ? null : Number(seqParam);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [usage, setUsage] = useState<TraceUsage | null>(null);
  const [jobTerminal, setJobTerminal] = useState(false);
  const [detail, setDetail] = useState<JobDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<Record<number, unknown>>({});
  const [payloadErrors, setPayloadErrors] = useState<Record<number, string>>({});
  const [tab, setTab] = useState<InspectorTab>('step');
  const [storyOpen, setStoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pipeline, setPipeline] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  // Separate generations for the list and the per-job data: a list tick must not
  // invalidate an in-flight trace fetch and vice versa. Payload fetches share one token
  // bumped only on a job switch, so the trace refetching on every trace.appended does
  // not throw away payloads for the job still on screen.
  const listGen = useFetchGeneration();
  const traceGen = useFetchGeneration();
  const detailGen = useFetchGeneration();
  const payloadGen = useFetchGeneration();
  const payloadStaleRef = useRef<() => boolean>(() => false);

  const loadList = useCallback(() => {
    const isStale = listGen();
    Promise.all([fetchJobs(JOB_WINDOW), fetchTraces()])
      .then(([j, t]) => {
        if (isStale()) return;
        setJobs(j);
        setTraces(t.traces);
      })
      .catch(() => {
        if (isStale()) return;
        setJobs([]);
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
        setUsage(r.usage);
        setJobTerminal(r.jobTerminal);
      })
      .catch(() => {
        if (isStale()) return;
        // 404 is "no trace": the job may still exist and the Story tab still works.
        setEntries([]);
        setUsage(null);
        setJobTerminal(true);
      });
  }, [selectedJob, traceGen]);

  const loadDetail = useCallback(() => {
    if (selectedJob === null) return;
    const isStale = detailGen();
    fetchJob(selectedJob)
      .then((r) => {
        if (isStale()) return;
        setDetail(r);
        setDetailError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setDetail(null);
        setDetailError(apiErrorMessage(err, 'Job row is gone'));
      });
  }, [selectedJob, detailGen]);

  useEffect(() => {
    loadList();
    return () => {
      listGen();
    };
  }, [loadList, listGen]);

  useEffect(() => {
    payloadStaleRef.current = payloadGen();
    setEntries([]);
    setUsage(null);
    setJobTerminal(false);
    setDetail(null);
    setDetailError(null);
    setPayloads({});
    setPayloadErrors({});
    setStoryOpen(false);
    setTab('step');
    loadTrace();
    loadDetail();
    return () => {
      traceGen();
      detailGen();
      payloadGen();
    };
  }, [selectedJob, loadTrace, loadDetail, traceGen, detailGen, payloadGen]);

  useSseRefetch(loadList, 1000, true, useCallback(() => true, []));
  useSseRefetch(
    loadTrace,
    250,
    selectedJob !== null,
    useCallback((e: SseEvent | null) => e === null || (e.kind === 'trace.appended' && e.job_id === selectedJob), [selectedJob]),
  );
  useSseRefetch(
    loadDetail,
    0,
    selectedJob !== null,
    useCallback((e: SseEvent | null) => e === null || (e.kind !== 'trace.appended' && e.job_id === selectedJob), [selectedJob]),
  );

  const visibleJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (pipeline !== ALL && job.pipeline !== pipeline) return false;
      if (status !== ALL && job.status !== status) return false;
      if (!needle) return true;
      return `${jobTitle(job)} ${job.arr_instance}`.toLowerCase().includes(needle);
    });
  }, [jobs, query, pipeline, status]);

  const job = useMemo(() => jobs.find((j) => j.id === selectedJob) ?? detail?.job ?? null, [jobs, selectedJob, detail]);
  const summary = useMemo(() => traces.find((t) => t.jobId === selectedJob) ?? null, [traces, selectedJob]);
  const selected = useMemo(() => entries.find((e) => e.seq === selectedSeq) ?? null, [entries, selectedSeq]);
  const turn = useMemo(() => (selected?.kind === 'llm.call' ? turnOf(entries, selected.seq) : null), [entries, selected]);
  const now = useMemo(() => effectiveNow(entries, jobTerminal), [entries, jobTerminal]);

  const ensurePayload = useCallback(
    (entry: TraceEntry) => {
      if (!entry.hasPayload || selectedJob === null) return;
      // Captured now, not read at resolution time: seqs restart per job, so a late reply
      // from a job you've navigated away from must not land in the new job's map.
      const isStale = payloadStaleRef.current;
      fetchTraceEntry(selectedJob, entry.seq)
        .then((full) => {
          if (isStale()) return;
          setPayloads((prev) => ({ ...prev, [entry.seq]: full.payload }));
        })
        .catch((err: unknown) => {
          if (isStale()) return;
          setPayloadErrors((prev) => ({ ...prev, [entry.seq]: apiErrorMessage(err, 'Could not load payload') }));
        });
    },
    [selectedJob],
  );

  // The inspector needs the selected entry, its llm.attempt children, and the tool step
  // the call led to. Fetch whichever are not in the map yet.
  useEffect(() => {
    if (!selected) return;
    const wanted = [selected, ...entries.filter((e) => e.parent_seq === selected.seq && e.kind === 'llm.attempt'), ...(turn ? [turn] : [])];
    for (const e of wanted) if (e.hasPayload && !(e.seq in payloads) && !(e.seq in payloadErrors)) ensurePayload(e);
    // payloads and payloadErrors are read, not depended on: re-running on every payload arrival
    // would refetch nothing new, and a failed seq is only retried on demand, never by a live
    // job's entries churning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, turn, entries, ensurePayload]);

  const retryPayload = useCallback(
    (seq: number) => {
      const entry = entries.find((e) => e.seq === seq);
      if (!entry) return;
      setPayloadErrors((prev) => {
        const next = { ...prev };
        delete next[seq];
        return next;
      });
      ensurePayload(entry);
    },
    [entries, ensurePayload],
  );

  const select = (seq: number) => {
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selectedSeq === seq) next.delete('seq');
        else next.set('seq', String(seq));
        return next;
      },
      { replace: true },
    );
    setStoryOpen(false);
    setTab('step');
  };

  const closeInspector = useCallback(() => {
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('seq');
        return next;
      },
      { replace: true },
    );
    setStoryOpen(false);
  }, [setSearch]);

  const inspectorOpen = selected !== null || storyOpen;

  return (
    <div className="-mx-4 -my-6 grid h-[calc(100vh-3.5rem)] grid-cols-[236px_minmax(0,1fr)] sm:-mx-6 lg:-mx-8">
      <TargetList
        jobs={visibleJobs}
        selectedJobId={selectedJob}
        query={query}
        onQuery={setQuery}
        pipeline={pipeline}
        onPipeline={setPipeline}
        status={status}
        onStatus={setStatus}
        onSelect={(id) => navigate(`/debug/${id}`)}
      />
      {selectedJob === null ? (
        <p className="p-6 text-sm text-muted-foreground">Pick a run on the left.</p>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-col">
          <TraceHeader
            job={job}
            fallbackTitle={summary?.targetTitle ?? `job #${selectedJob}`}
            detail={detail}
            entries={entries}
            usage={usage}
            onStory={() => {
              setStoryOpen(true);
              setTab('story');
            }}
          />
          <LaneStrip key={selectedJob} entries={entries} events={detail?.events ?? []} jobTerminal={jobTerminal} selectedSeq={selectedSeq} onSelect={select} />
          <div className={inspectorOpen ? 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]' : 'flex min-h-0 flex-1 flex-col'}>
            <Waterfall
              entries={entries}
              jobTerminal={jobTerminal}
              selectedSeq={selectedSeq}
              onSelect={select}
              emptyLabel="No trace for this run. Debug mode was off when it ran."
            />
            {inspectorOpen && (
              <Inspector
                entries={entries}
                selected={selected}
                payload={selected ? payloads[selected.seq] : undefined}
                payloadError={selected ? payloadErrors[selected.seq] : undefined}
                payloadErrors={payloadErrors}
                onRetryPayload={retryPayload}
                childPayloads={payloads}
                turn={turn}
                turnPayload={turn ? payloads[turn.seq] : undefined}
                detail={detail}
                detailError={detailError}
                onRetryDetail={loadDetail}
                tab={tab}
                onTab={setTab}
                onClose={closeInspector}
                now={now}
                jobTerminal={jobTerminal}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
