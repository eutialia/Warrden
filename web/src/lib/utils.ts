import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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

