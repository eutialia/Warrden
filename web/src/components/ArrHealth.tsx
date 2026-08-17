import type { ArrCheck } from '@/api';
import { unreachableCount } from '@/components/MountHealth';
import { ToneBadge } from '@/components/ToneBadge';

/**
 * The one-line verdict on the configured arr instances, beside the Connections title.
 *
 * Renders nothing until a probe has actually answered. An install with no instances, or one
 * whose health route isn't mounted, has nothing to claim either way. `unauthorized` counts
 * as not connected: a key the arr rejects is as useless as an unreachable host.
 */
export function ArrHealth({ checks }: { checks: ArrCheck[] }) {
  if (checks.length === 0) return null;
  const bad = unreachableCount(checks);
  return <ToneBadge tone={bad > 0 ? 'danger' : 'success'}>{bad > 0 ? `${bad} unreachable` : 'All connected'}</ToneBadge>;
}
