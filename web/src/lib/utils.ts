import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Outer chrome for chip bars (language combobox and freeform tag lists). */
export const chipBarClass =
  'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30'

export const chipClass =
  'inline-flex h-auto max-w-full items-center gap-1 rounded-4xl bg-secondary py-1 pr-1 pl-2 font-sans text-xs font-normal text-secondary-foreground'

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
 * wording ("held 11m", "oldest 4m"). Same minute/hour/day thresholds as
 * `formatRelativeTime`, but with no "just now" and no date past a week: a duration
 * always reads as a duration. */
export function formatElapsed(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Compact relative time for a past epoch-ms: "just now", "5m ago", "3h ago", "2d ago".
 * Falls back to a locale string past 30 days, where "45d ago" stops being more useful than
 * the actual date. Returns an em dash for null (the site-profiles table's never-seen columns). */
export function formatRelativeTime(ts: number | null): string {
  if (ts === null) return '—';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Release size as GiB with one decimal, matching `src/pipelines/acquire/pick.ts`. */
export function formatReleaseSize(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
