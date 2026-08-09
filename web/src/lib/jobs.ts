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

const DAY_MS = 86_400_000;

/**
 * Splits a newest-first job list into calendar days. History reads as a diary —
 * "today, then yesterday" — which a single unbroken table of timestamps does not
 * give you, and it lets each day carry its own run and failure count.
 */
export function groupJobsByDay(jobs: Job[]): JobDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

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
          : key === today.getTime() - DAY_MS
            ? 'Yesterday'
            : new Date(key).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      jobs: dayJobs,
      failed: dayJobs.filter((j) => j.status === 'failed').length,
    }));
}

/** How long a job took (or has been going). `null` when the timestamps can't say
 * anything useful — a job that was created and never updated. */
export function jobDuration(job: Job): string | null {
  const ms = job.updated_at - job.created_at;
  if (ms < 1000) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
