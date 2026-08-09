import { Badge } from '@/components/ui/badge';
import type { AcquireStatus, JobStatus } from '@/api';
import { acquireOutcomeLabel, jobStatusLabel, pipelineLabel, pipelineToneClass } from '@/lib/labels';
import { cn } from '@/lib/utils';

const STATUS_CLASS: Record<JobStatus, string> = {
  pending: 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-700',
  running: 'bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-800',
  done: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-800',
  failed: 'bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-900',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', STATUS_CLASS[status])}>
      {jobStatusLabel(status)}
    </Badge>
  );
}

/**
 * A job's queue status alone can't distinguish a successful acquire from one that
 * "succeeded" by finding nothing. Renders next to StatusBadge for that case.
 */
export function AcquireOutcomeBadge({ outcome }: { outcome: AcquireStatus | null | undefined }) {
  if (!outcome) return null;
  const ok = outcome === 'grabbed';
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-medium',
        ok
          ? 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100'
          : 'bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100',
      )}
    >
      {acquireOutcomeLabel(outcome)}
    </Badge>
  );
}

export function PipelineBadge({ pipeline }: { pipeline: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', pipelineToneClass(pipeline))}>
      {pipelineLabel(pipeline)}
    </Badge>
  );
}
