import type { StorageCheck } from '@/api';
import { ToneBadge } from '@/components/ToneBadge';

/** How many checks are reporting anything other than `ok`: the number every health badge
 * leads with. Typed over the status field alone, since the mount and arr probes agree on
 * that one sentinel and on nothing else. */
export function unreachableCount(checks: { status: string }[]): number {
  return checks.filter((c) => c.status !== 'ok').length;
}

/**
 * The one-line verdict on the mounts, shown by both the home screen and Settings.
 *
 * Renders nothing until a probe has actually answered: "All reachable" over an empty
 * list is a claim about something nobody measured, and it sat above rows saying the
 * opposite.
 */
export function MountHealth({ checks }: { checks: StorageCheck[] }) {
  if (checks.length === 0) return null;
  const bad = unreachableCount(checks);
  return <ToneBadge tone={bad > 0 ? 'danger' : 'success'}>{bad > 0 ? `${bad} unreachable` : 'All reachable'}</ToneBadge>;
}
