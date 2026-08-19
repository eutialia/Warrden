import type { Job } from '@/api';
import { targetKindLabel } from '@/lib/labels';

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

/** One day's worth of runs, newest day first. */
export interface JobDay {
  /** Midnight of the day, so the caller can key and format it. */
  key: number;
  label: string;
  jobs: Job[];
  failed: number;
}

/**
 * Splits a newest-first job list into calendar days. History reads as a diary —
 * "today, then yesterday" — which a single unbroken table of timestamps does not
 * give you, and it lets each day carry its own run and failure count.
 */
export function groupJobsByDay(jobs: Job[]): JobDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Stepping the date, not subtracting 24 hours: on the two days a year a local day is
  // 23 or 25 hours long, arithmetic on milliseconds lands on no day at all.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const days = new Map<number, Job[]>();
  for (const job of jobs) {
    const midnight = new Date(job.updated_at);
    midnight.setHours(0, 0, 0, 0);
    const key = midnight.getTime();
    const list = days.get(key);
    if (list) list.push(job);
    else days.set(key, [job]);
  }

  return [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([key, dayJobs]) => ({
      key,
      label:
        key === today.getTime()
          ? 'Today'
          : key === yesterday.getTime()
            ? 'Yesterday'
            : new Date(key).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      jobs: dayJobs,
      failed: dayJobs.filter((j) => j.status === 'failed').length,
    }));
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

/** Arr identity for a job's target. Two series with the same display name stay
 * distinct; retries of the same Sonarr/Radarr id fold together. */
export function jobTargetKey(job: { arr_instance: string; target_kind: string; target_id: number }): string {
  return `${job.arr_instance}\0${job.target_kind}\0${job.target_id}`;
}

export interface JobTargetGroup {
  key: string;
  latest: Job;
  runs: Job[];
  failed: boolean;
}

/**
 * Folds a newest-first job list into one group per arr target, preserving first-seen
 * order so the title whose latest run is newest stays on top.
 */
export function foldJobsByTarget(jobs: Job[]): JobTargetGroup[] {
  const groups = new Map<string, Job[]>();
  const order: string[] = [];
  for (const job of jobs) {
    const key = jobTargetKey(job);
    const list = groups.get(key);
    if (list) {
      list.push(job);
    } else {
      groups.set(key, [job]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const runs = groups.get(key) ?? [];
    const latest = runs.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
    return { key, latest, runs, failed: runs.some((j) => j.status === 'failed') };
  });
}

const PIPELINE_ORDER = ['acquire', 'ingest', 'subtitle'];

export interface PipelineFold<T extends { pipeline: string }> {
  pipeline: string;
  latest: T;
  earlier: T[];
}

/** Newest job per pipeline, with the rest tucked behind. Input should already be newest-first. */
export function foldByPipeline<T extends { pipeline: string }>(jobs: T[]): PipelineFold<T>[] {
  const buckets = new Map<string, T[]>();
  for (const job of jobs) {
    const list = buckets.get(job.pipeline);
    if (list) list.push(job);
    else buckets.set(job.pipeline, [job]);
  }
  return [...buckets.keys()]
    .sort((a, b) => {
      const ia = PIPELINE_ORDER.indexOf(a);
      const ib = PIPELINE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .flatMap((pipeline) => {
      const runs = buckets.get(pipeline);
      const latest = runs?.[0];
      if (!latest || !runs) return [];
      return [{ pipeline, latest, earlier: runs.slice(1) }];
    });
}
