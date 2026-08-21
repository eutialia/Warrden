import type { StorageCheck } from '@/api';
import { ToneBadge } from '@/components/ToneBadge';

/**
 * How the storage roles are doing, split by what it costs the operator.
 *
 * `missing` is the only status the mount gate acts on: `ensureMounts` tests for existence,
 * so a missing path really does pause filesystem work. `looks-unmounted` and `unreadable`
 * are suspicions about a path that exists, and the pipelines keep running through them, so
 * they must not render in the same red as a stop. A role with no path set is neither: the
 * operator said they do not have that library.
 */
export function storageProblems(checks: { status: string }[]): { missing: number; suspect: number } {
  return {
    missing: checks.filter((c) => c.status === 'missing').length,
    suspect: checks.filter((c) => c.status === 'looks-unmounted' || c.status === 'unreadable').length,
  };
}

/**
 * The one-line verdict on the storage roles, shown by both the home screen and
 * Settings.
 *
 * Renders nothing until a probe has actually answered: "All reachable" over an empty
 * list is a claim about something nobody measured, and it sat above rows saying the
 * opposite.
 */
export function StorageHealth({ checks }: { checks: StorageCheck[] }) {
  if (checks.length === 0) return null;
  const { missing, suspect } = storageProblems(checks);
  const configured = checks.filter((c) => c.status !== 'not-configured').length;
  if (missing > 0) return <ToneBadge tone="danger">{`${missing} unreachable`}</ToneBadge>;
  if (suspect > 0) return <ToneBadge tone="warning">{`${suspect} to check`}</ToneBadge>;
  if (configured === 0) return <ToneBadge tone="neutral">No storage set</ToneBadge>;
  return <ToneBadge tone="success">All reachable</ToneBadge>;
}
