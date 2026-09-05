import type { AcquireRecordDetail, EventRow, JobDetailResponse } from '@/api';
import { ReleasePick } from '@/components/activity/ReleasePick';
import { eventStep, importStep, isImport } from '@/components/activity/eventStep';
import type { StepFeedRow } from '@/components/activity/UnifiedTimeline';
import { envelopeOf, foldByCoalesceKey } from '@/lib/eventEnvelope';
import { acquireOutcomeLabel } from '@/lib/labels';

/**
 * A job detail as one feed, for every pipeline and every status.
 *
 * The event log is now the whole story: each pipeline narrates its own steps, closes each
 * site visit with an `agent.stop`, and ends the run with a `run.finished` carrying its
 * verdict and counts. So this no longer synthesises anything — the per-visit rows and the
 * run verdict are ordinary events with a `verdict` tone, sorted by `ts` like everything
 * else.
 *
 * What is still not in the log is the pick's *evidence* — the candidate list, the model's
 * reasoning, the release card — which lives in `acquire_records`. That is why acquire keeps
 * a block per record here, and why the `acquire.pick` events themselves are dropped: the
 * block says the same thing with the body attached — for every record the run has finished
 * with, never for the one it is still deciding.
 */
export function jobRows(detail: JobDetailResponse): StepFeedRow[] {
  const { job, events } = detail;

  const steps = events.filter(isStepEvent);

  // Precedence: a row that carries its own import stands alone, and only the rest are
  // folded. The fold never sees the import rows, so a job whose history spans the webhook
  // widening — some rows with facts, some without — renders the fact-less ones as one
  // `Webhook · ×N` line and the fact-carrying ones as themselves, side by side, both in
  // their own place in time. Every other coalesced burst (the settle-wait reschedules) is
  // untouched: it has no import facts, so it folds exactly as it did.
  const ranked: Ranked[] = foldByCoalesceKey(steps.filter((e) => !isImport(e))).map(({ event, folded }) => ({
    row: eventStep(event, folded),
    rank: STEP,
  }));
  for (const event of steps.filter(isImport)) {
    ranked.push({ row: importStep(event), rank: STEP });
  }

  if (job.pipeline === 'acquire') {
    // A record with no status yet is the season being worked on right now. Its row would be
    // a conclusion sitting on top of a run that has not concluded — and, because the live
    // pulse belongs to the newest *step*, a conclusion with nothing to say about it. The
    // block appears the moment the status lands, which for a finished season is at once.
    const closed = detail.acquireRecords.filter((r) => r.status !== null || job.status !== 'running');
    for (const record of closed) {
      ranked.push({ row: pickBlock(record), rank: VERDICT });
    }
  }

  // Conclusions lose ties: a verdict or a block stamped at the same millisecond as the step
  // that earned it belongs after it.
  return ranked.sort((a, b) => a.row.ts - b.row.ts || a.rank - b.rank).map((r) => r.row);
}

/** `acquire.pick` is not a step, it is what the pick block below renders in full. Every
 * other event is. */
function isStepEvent(event: EventRow): boolean {
  const envelope = envelopeOf(event);
  return !(envelope?.scope === 'acquire' && envelope.action === 'pick');
}

interface Ranked {
  row: StepFeedRow;
  rank: number;
}

const STEP = 0;
const VERDICT = 1;

/** One season's conclusion, in the flow, at the moment the pick was written. The label is
 * what a one-line verdict would have said; the body is everything a one-liner throws away. */
function pickBlock(record: AcquireRecordDetail): StepFeedRow {
  const season = seasonScope(record);
  const grabbed = record.status === 'grabbed';
  const label = grabbed
    ? [season, 'Grabbed', record.picked?.quality, record.release_group].filter(isPresent).join(' · ')
    : `${season} · ${record.status ? acquireOutcomeLabel(record.status) : 'Nothing grabbed'}`;
  return {
    kind: 'block',
    id: `pick:${record.id}`,
    ts: record.created_at,
    tone: grabbed ? 'success' : 'warning',
    label,
    body: <ReleasePick record={record} />,
  };
}

function seasonScope(record: AcquireRecordDetail): string {
  const season = record.picked?.seasonNumber ?? readKey(record.candidates_json, 'seasonNumber');
  return typeof season === 'number' ? `S${season}` : 'Title';
}

function readKey(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function isPresent(value: string | null | undefined): value is string {
  return Boolean(value);
}
