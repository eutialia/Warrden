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

const NOOP_HANDLE: StepHandle = { seq: null, end: () => undefined };

export const NOOP_TRACER: Tracer = {
  begin: () => NOOP_HANDLE,
  event: () => null,
};

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
