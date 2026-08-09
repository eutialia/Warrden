import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * How full a volume is, as one string: "4.1/18 TB". Both numbers share the total's
 * unit so they can be compared at a glance, which is the only reason to show a used
 * figure next to a capacity at all.
 */
export function formatUsage({ totalBytes, usedBytes }: { totalBytes: number; usedBytes: number }): string {
  let exponent = 0;
  while (totalBytes >= 1000 ** (exponent + 1) && exponent < BYTE_UNITS.length - 1) exponent++;
  const scale = 1000 ** exponent;
  // A tenth of a terabyte is worth seeing; a tenth of eighteen of them is noise.
  const show = (n: number) => (n / scale < 10 ? (n / scale).toFixed(1) : String(Math.round(n / scale)));
  return `${show(usedBytes)}/${show(totalBytes)} ${BYTE_UNITS[exponent]}`;
}

/** How long ago something happened, with no "ago" — for places that supply their own
 * wording ("held 11m", "oldest 4m"). Same buckets as `formatRelativeTime`. */
export function formatElapsed(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Clock time for a row inside a day-grouped list, where the day is already the heading. */
export function formatTimeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Compact relative time for a past epoch-ms — "just now", "5m ago", "3h ago", "2d ago".
 * Falls back to a locale string past 7 days, where "12d ago" stops being more useful than
 * the actual date. Returns '—' for null (the site-profiles table's never-seen columns). */
export function formatRelativeTime(ts: number | null): string {
  if (ts === null) return '—';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

