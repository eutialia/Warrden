import type { StorageCheck } from '@/api';
import { ToneBadge } from '@/components/ToneBadge';

/** How many checks report a problem: the number every health badge leads with. Typed over
 * the status field alone, since the storage and arr probes agree on that one sentinel and
 * on nothing else. A role with no path set is not a problem: the operator said they do not
 * have that library. */
export function unreachableCount(checks: { status: string }[]): number {
  return checks.filter((c) => c.status !== 'ok' && c.status !== 'not-configured').length;
}

/**
 * The one-line verdict on the storage roles, shown by both the home screen and
 * Settings.
 *
 * Renders nothing until a probe has actually answered: "All reachable" over an empty
 * list is a claim about something nobody measured, and it sat above rows saying the
 * opposite.
 */
export function MountHealth({ checks }: { checks: StorageCheck[] }) {
  if (checks.length === 0) return null;
  const bad = unreachableCount(checks);
  const configured = checks.filter((c) => c.status !== 'not-configured').length;
  if (bad > 0) return <ToneBadge tone="danger">{`${bad} unreachable`}</ToneBadge>;
  if (configured === 0) return <ToneBadge tone="neutral">No storage set</ToneBadge>;
  return <ToneBadge tone="success">All reachable</ToneBadge>;
}
