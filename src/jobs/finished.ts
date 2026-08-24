import { AcquireRecords, type AcquireStatus } from '../db/acquireRecords.js';
import { PlacedFiles } from '../db/placedFiles.js';
import type { AppContext } from '../context.js';
import { eventEnvelope, type EventFacts, type EventTone } from '../events/envelope.js';
import { targetEventData } from '../events/target.js';
import type { JobRow } from './queue.js';

/**
 * The one closing event every run appends, whatever the pipeline and however it ended.
 *
 * Before this, a finished run said nothing: the dashboard synthesised a verdict client-side
 * from the job row plus whatever tables it happened to have fetched, and a FAILED run said
 * it three times over — a synthesised verdict row, a `job.failed` event, and an attention
 * item, all repeating the same sentence. Now the log itself carries the conclusion, with a
 * timestamp like everything else in the run.
 *
 * `job.failed` is gone: it was this event, minus the counts, for one of the two endings.
 * `job.attention` survives untouched — that is a decision waiting on a human, not a
 * narration of the run, and the whole attention protocol (`level: 'attention'`, the target
 * triple, `dedupeKey`) hangs off it.
 */

/** What a run produced, counted from the tables it wrote rather than tracked through it —
 * the runner has no view into a pipeline's internals and should not grow one. */
export interface RunOutcome {
  /** Acquire's aggregate verdict across every season this run recorded. */
  readonly acquire: AcquireStatus | null;
  readonly grabbed: number;
  readonly placed: number;
}

export function runOutcome(ctx: AppContext, job: JobRow): RunOutcome {
  if (job.pipeline === 'acquire') {
    const records = new AcquireRecords(ctx.db);
    const own = records
      .listByTarget(job.arr_instance, job.target_kind, job.target_id, { since: job.created_at })
      .filter((r) => r.status === 'grabbed');
    return {
      acquire: records.outcomeForJob(job.arr_instance, job.target_kind, job.target_id, job.created_at),
      grabbed: own.length,
      placed: 0,
    };
  }
  return { acquire: null, grabbed: 0, placed: new PlacedFiles(ctx.db).listByJob(job.id).length };
}

/** Colour for a run that finished without throwing. Acquire is the one pipeline whose
 * clean finish can still be a dead end a human may want to act on. */
export function finishedTone(outcome: RunOutcome): EventTone {
  if (outcome.acquire !== null) {
    return outcome.acquire === 'grabbed' || outcome.acquire === 'already-satisfied' ? 'success' : 'warning';
  }
  return outcome.placed > 0 ? 'success' : 'neutral';
}

function finishedFacts(job: JobRow, outcome: RunOutcome): EventFacts {
  const counts: Record<string, number> =
    job.pipeline === 'acquire' ? { grabbed: outcome.grabbed } : { placed: outcome.placed };
  return { pipeline: job.pipeline, counts, ...(outcome.acquire === null ? {} : { reason: outcome.acquire }) };
}

/** Appends the closing event for a run that completed without throwing. */
export function reportRunFinished(ctx: AppContext, job: JobRow): void {
  const outcome = runOutcome(ctx, job);
  ctx.events.append({
    kind: 'run.finished',
    jobId: job.id,
    message: `Job #${job.id} (${job.pipeline}) finished${summarise(job.pipeline, outcome)}`,
    data: eventEnvelope(
      {
        scope: 'run',
        action: 'finished',
        facts: finishedFacts(job, outcome),
        verdict: { tone: finishedTone(outcome) },
      },
      targetEventData(job),
    ),
  });
}

/** Appends the closing event for a run that threw. `error` is the message the queue
 * recorded; the envelope keeps its first sentence as the fact and the full text as the
 * human line, which is the split every reader of a stack-trace-shaped error wants. */
export function reportRunFailed(
  ctx: AppContext,
  job: JobRow,
  error: string,
  outcome: { retried: boolean; permanent: boolean },
): void {
  ctx.events.append({
    kind: 'run.finished',
    level: 'warn',
    jobId: job.id,
    message: `Job #${job.id} (${job.pipeline}) failed: ${error}`,
    data: eventEnvelope(
      {
        scope: 'run',
        action: 'finished',
        facts: {
          pipeline: job.pipeline,
          error: firstSentence(error),
          retried: outcome.retried,
          permanent: outcome.permanent,
        },
        verdict: { tone: 'danger' },
      },
      targetEventData(job),
    ),
  });
}

function summarise(pipeline: string, outcome: RunOutcome): string {
  if (pipeline === 'acquire') return outcome.grabbed === 0 ? ' — nothing grabbed' : ` — grabbed ${outcome.grabbed}`;
  return outcome.placed === 0 ? ' — nothing placed' : ` — placed ${outcome.placed} file(s)`;
}

/** First sentence, capped. An arr error can be a page of stack trace; the label wants the
 * part a human reads, and the untouched text stays on the `message`. */
export function firstSentence(text: string, max = 220): string {
  const trimmed = text.trim();
  const stop = /[.!?](\s|$)/.exec(trimmed);
  const sentence = stop ? trimmed.slice(0, stop.index + 1) : trimmed;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
