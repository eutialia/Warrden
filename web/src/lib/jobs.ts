import type { AcquireStatus, Job, JobStatus } from '@/api';
import { targetKindLabel } from '@/lib/labels';
import type { Tone } from '@/lib/tone';

/**
 * Best available human name for a job's target. The API resolves real titles from
 * the arr, but a job can outlive its series (or be created before the lookup
 * succeeds), so this falls back through the webhook payload to a bare id rather
 * than rendering an empty cell. Shared by every page that lists or details a job.
 */
export function jobTitle(job: Job): string {
  if (job.targetTitle?.trim()) return job.targetTitle.trim();
  const payloadTitle = job.payload.title;
  if (typeof payloadTitle === 'string' && payloadTitle.trim()) return payloadTitle.trim();
  return `${targetKindLabel(job.target_kind)} #${job.target_id}`;
}

export type Phase = 'acquire' | 'ingest' | 'subtitle';
export const PHASES: readonly Phase[] = ['acquire', 'ingest', 'subtitle'];

/** The vocabulary every job filter speaks: `ALL` is the no-filter sentinel, and `PHASES`
 * above and `STATUSES` are the values a job can actually carry. */
export const ALL = 'all';
export const STATUSES: JobStatus[] = ['running', 'pending', 'done', 'failed'];

/** Outcomes that need nobody. A bare `!== 'grabbed'` test paints already-satisfied
 * amber, putting it in the same class as the false alarm it replaced. */
const SETTLED_OUTCOMES = new Set<AcquireStatus>(['grabbed', 'already-satisfied']);

/** Composite key for grouping jobs by arr target. NUL is the separator because
 * `arr_instance` is free text and could contain a printable delimiter.
 * `target_kind` is a closed two-value enum and `target_id` is numeric, so those
 * cannot contribute a collision. */
export function jobTargetKey(job: { arr_instance: string; target_kind: string; target_id: number }): string {
  return `${job.arr_instance}\0${job.target_kind}\0${job.target_id}`;
}

export interface TargetGroup {
  key: string;
  latest: Job;
  runs: Job[];
  byPhase: Record<Phase, Job[]>;
  lastTs: number;
}

export function foldJobsByTarget(jobs: Job[]): TargetGroup[] {
  const map = new Map<string, Job[]>();
  const order: string[] = [];
  for (const j of jobs) {
    const k = jobTargetKey(j);
    const list = map.get(k);
    if (list) list.push(j);
    else {
      map.set(k, [j]);
      order.push(k);
    }
  }
  return order.map((key) => {
    const runs = map.get(key) ?? [];
    const byPhase: Record<Phase, Job[]> = {
      acquire: runs.filter((r) => r.pipeline === 'acquire'),
      ingest: runs.filter((r) => r.pipeline === 'ingest'),
      subtitle: runs.filter((r) => r.pipeline === 'subtitle'),
    };
    return {
      key,
      runs,
      byPhase,
      latest: runs.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b)),
      lastTs: Math.max(...runs.map((r) => r.updated_at)),
    };
  });
}

/** Current state of a phase, not its history. Failures stay on the individual
 * run nodes inside the drawer; the dot answers "where is this now?".
 *
 * Acquire latches on any settled outcome because a grab is a possession, not a
 * moment: a later retry that finds nothing does not give the file back. Ingest
 * and subtitle have no equivalent latch, so they fall through to the latest run. */
export function phaseTone(runs: Job[]): Tone {
  if (runs.length === 0) return 'neutral';
  if (runs.some((r) => r.status === 'running' || r.status === 'pending')) return 'info';
  if (runs.some((r) => r.acquireOutcome != null && SETTLED_OUTCOMES.has(r.acquireOutcome))) return 'success';
  const latest = runs.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
  if (latest.status === 'failed') return 'danger';
  if (latest.acquireOutcome && !SETTLED_OUTCOMES.has(latest.acquireOutcome)) return 'warning';
  return 'success';
}

export function phaseSummary(phase: Phase, runs: Job[]): string {
  if (runs.length === 0) return 'not run';
  if (phase === 'acquire') {
    const tries = `${runs.length} ${runs.length === 1 ? 'try' : 'tries'}`;
    const settled = runs.some((r) => r.acquireOutcome != null && SETTLED_OUTCOMES.has(r.acquireOutcome));
    if (settled) return `settled after ${tries}`;
    return `${tries}, nothing grabbed`;
  }
  return `${runs.length} run${runs.length === 1 ? '' : 's'}`;
}

/** How long a job took (or has been going). `null` when the timestamps can't say
 * anything useful — a job that was created and never updated.
 *
 * A job still in flight is measured against now, not against `updated_at`: the queue
 * stamps that once when it claims the job and never again, so a run of any length would
 * otherwise report the time it spent waiting to start. */
export function jobDuration(job: Job): string | null {
  const live = job.status === 'running' || job.status === 'pending';
  const ms = (live ? Date.now() : job.updated_at) - job.created_at;
  if (ms < 1000) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
