import type Database from 'better-sqlite3';
import { TraceEntries } from '../db/traceEntries.js';
import type { EventLog } from '../events/log.js';

export type PayloadThunk = () => unknown;

export interface TraceStepInput {
  jobId: number;
  kind: string;
  summary: string;
  parentSeq?: number;
  sideEffect?: boolean;
  payload?: PayloadThunk;
}

export interface StepHandle {
  readonly seq: number | null;
  end(status: 'ok' | 'error', payload?: PayloadThunk): void;
}

export interface Tracer {
  begin(o: TraceStepInput): StepHandle;
  event(o: TraceStepInput): number | null;
}

export const NOOP_HANDLE: StepHandle = { seq: null, end: () => undefined };

export const NOOP_TRACER: Tracer = {
  begin: () => NOOP_HANDLE,
  event: () => null,
};

/** Structural mirror of `JobQueue.enqueue`'s result, kept local so the tracer owes the
 * job queue no import. */
export interface TriggerResult {
  id: number;
  outcome: 'enqueued' | 'coalesced' | 'marked-dirty';
}

/**
 * Writes the "why does this job exist" entry on the job the trigger will actually be
 * served by, which is not always the id the enqueue handed back:
 *
 * - `enqueued`: a fresh row, the trigger's own job.
 * - `coalesced`: the pending twin that will run this trigger too, so the entry belongs on
 *   its trace, marked as coalesced.
 * - `marked-dirty`: the id is a RUNNING twin whose trace is mid-flight and whose run
 *   predates this trigger. The job that will serve it is the requeue `complete()`/`fail()`
 *   inserts later, which has no id yet, so nothing is written rather than mis-attributing
 *   the trigger to a run it had no part in.
 */
export function traceTrigger(
  trace: Tracer | undefined,
  result: TriggerResult,
  e: { kind: string; summary: string; payload?: PayloadThunk },
): void {
  if (trace === undefined || result.outcome === 'marked-dirty') return;
  trace.event({
    jobId: result.id,
    kind: e.kind,
    summary: result.outcome === 'coalesced' ? `${e.summary} (coalesced)` : e.summary,
    payload: e.payload,
  });
}

// Reads the enabled switch live on every call rather than caching it at construction,
// so flipping `debug.enabled` in config takes effect immediately without recreating
// the tracer. Storage failures are swallowed (logged, not thrown): tracing is
// diagnostic scaffolding and must never take down the pipeline it's observing.
export class SqlTracer implements Tracer {
  private readonly store: TraceEntries;

  constructor(
    db: Database.Database,
    private readonly events: EventLog,
    private readonly isEnabled: () => boolean,
  ) {
    this.store = new TraceEntries(db);
  }

  begin(o: TraceStepInput): StepHandle {
    if (!this.isEnabled()) return NOOP_HANDLE;
    const seq = this.write(o, 'running');
    if (seq === null) return NOOP_HANDLE;
    return {
      seq,
      end: (status, payload) => {
        try {
          this.store.finish(o.jobId, seq, status, payload === undefined ? undefined : payload());
          this.announce(o.jobId, seq);
        } catch (err) {
          console.error('Tracer finish failed', err);
        }
      },
    };
  }

  event(o: TraceStepInput): number | null {
    if (!this.isEnabled()) return null;
    return this.write(o, 'ok', Date.now());
  }

  private write(o: TraceStepInput, status: 'running' | 'ok', tsEnd?: number): number | null {
    try {
      const seq = this.store.append({
        jobId: o.jobId,
        kind: o.kind,
        summary: o.summary,
        parentSeq: o.parentSeq,
        sideEffect: o.sideEffect,
        status,
        tsEnd,
        payload: o.payload === undefined ? undefined : o.payload(),
      });
      this.announce(o.jobId, seq);
      return seq;
    } catch (err) {
      console.error('Tracer append failed', err);
      return null;
    }
  }

  private announce(jobId: number, seq: number): void {
    this.events.broadcast({ kind: 'trace.appended', jobId, message: '', data: { seq } });
  }
}
