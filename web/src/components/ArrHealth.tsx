import type { ArrCheck } from '@/api';
import { arrCheckReady } from '@/lib/labels';
import { ToneBadge } from '@/components/ToneBadge';

/**
 * The one-line verdict on the configured arr instances, beside the Connections title.
 *
 * Renders nothing until a probe has actually answered. An install with no instances, or one
 * whose health route isn't mounted, has nothing to claim either way. Unauthorized, unreachable,
 * and a webhook that isn't registered all count as not connected.
 */
export function ArrHealth({ checks }: { checks: ArrCheck[] }) {
  if (checks.length === 0) return null;
  const bad = checks.filter((check) => !arrCheckReady(check)).length;
  return <ToneBadge tone={bad > 0 ? 'danger' : 'success'}>{bad > 0 ? `${bad} not connected` : 'All connected'}</ToneBadge>;
}
