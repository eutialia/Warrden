import { Badge } from '@/components/ui/badge';
import type { AcquireStatus, JobStatus } from '@/api';

const VARIANT_BY_STATUS: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'secondary',
  done: 'default',
  failed: 'destructive',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{status}</Badge>;
}

const ACQUIRE_OUTCOME_LABEL: Record<AcquireStatus, string> = {
  grabbed: 'grabbed',
  'none-viable': 'none viable',
  'no-candidates': 'no candidates',
};

/**
 * A job's job-queue status (pending/running/done/failed) alone can't distinguish a
 * successful acquire from one that "succeeded" by finding nothing to grab — a `done`
 * acquire job with no viable release looks identical to one that grabbed something. This
 * renders next to `StatusBadge` for exactly that case: `grabbed` gets the same "good"
 * variant as a plain `done`, while `none-viable`/`no-candidates` get `destructive` since
 * both are the same "needs a human to look" outcomes the backend raises as `attention`
 * events for. Renders nothing when there's no acquire outcome to show (non-acquire
 * pipeline, or the job hasn't produced one yet).
 */
export function AcquireOutcomeBadge({ outcome }: { outcome: AcquireStatus | null | undefined }) {
  if (!outcome) return null;
  return <Badge variant={outcome === 'grabbed' ? 'default' : 'destructive'}>{ACQUIRE_OUTCOME_LABEL[outcome]}</Badge>;
}
