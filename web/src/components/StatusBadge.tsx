import { Badge } from '@/components/ui/badge';
import type { JobStatus } from '@/api';

const VARIANT_BY_STATUS: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'secondary',
  done: 'default',
  failed: 'destructive',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{status}</Badge>;
}
