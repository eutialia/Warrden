import { Badge } from '@/components/ui/badge';
import { ToneBadge } from '@/components/ToneBadge';
import type { AcquireStatus, JobStatus } from '@/api';
import {
  acquireOutcomeLabel,
  acquireOutcomeTone,
  jobStatusLabel,
  jobStatusTone,
  pipelineIcon,
  pipelineLabel,
} from '@/lib/labels';
import { cn } from '@/lib/utils';

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <ToneBadge tone={jobStatusTone(status)} dot pulse={status === 'running'}>
      {jobStatusLabel(status)}
    </ToneBadge>
  );
}

/**
 * A job's queue status alone can't distinguish a successful acquire from one that
 * "succeeded" by finding nothing. Design-system badge for that outcome.
 */
export function AcquireOutcomeBadge({ outcome }: { outcome: AcquireStatus | null | undefined }) {
  if (!outcome) return null;
  return <ToneBadge tone={acquireOutcomeTone(outcome)}>{acquireOutcomeLabel(outcome)}</ToneBadge>;
}

/** Which pipeline a job belongs to. Deliberately uncoloured — the icon carries the
 * category so colour stays meaningful as status. */
export function PipelineBadge({ pipeline, className }: { pipeline: string; className?: string }) {
  const Icon = pipelineIcon(pipeline);
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium text-muted-foreground', className)}>
      {Icon && <Icon />}
      {pipelineLabel(pipeline)}
    </Badge>
  );
}
