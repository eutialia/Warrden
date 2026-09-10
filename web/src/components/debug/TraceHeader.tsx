import { BookOpen } from 'lucide-react';
import type { Job, JobDetailResponse, TraceEntry, TraceUsage } from '@/api';
import { RelativeTime } from '@/components/activity/RelativeTime';
import { subtitleCounts } from '@/components/activity/SubtitleSummary';
import { ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { jobDuration, jobTitle } from '@/lib/jobs';
import { pipelineLabel, runOutcome } from '@/lib/labels';

export function TraceHeader({
  job,
  fallbackTitle,
  detail,
  entries,
  usage,
  onStory,
}: {
  job: Job | null;
  fallbackTitle: string;
  detail: JobDetailResponse | null;
  entries: TraceEntry[];
  usage: TraceUsage | null;
  onStory: () => void;
}) {
  const title = job ? jobTitle(job) : fallbackTitle;
  const outcome = job ? runOutcome(job) : null;
  const counts = detail && detail.job.pipeline === 'subtitle' ? subtitleCounts(detail.placedFiles, detail.attention, detail.events) : null;
  const writes = entries.filter((e) => e.side_effect === 1).length;
  const arr = entries.filter((e) => e.kind === 'arr.request').length;

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5">
      <h1 className="min-w-0 truncate font-serif text-xl leading-tight">
        {title}
        {job && (
          <span className="whitespace-nowrap text-muted-foreground"> · {pipelineLabel(job.pipeline)} #{job.id}</span>
        )}
      </h1>
      {outcome && <ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>}
      {counts && counts.missing > 0 && <ToneBadge tone="warning">{counts.missing} missing</ToneBadge>}
      {counts && counts.resynced > 0 && <ToneBadge tone="info">{counts.resynced} resynced</ToneBadge>}
      {counts && counts.setAside > 0 && <ToneBadge tone="neutral">{counts.setAside} set aside</ToneBadge>}
      {job && (
        <span className="text-xs text-muted-foreground">
          {jobDuration(job) ?? '—'} · <RelativeTime ts={job.created_at} />
        </span>
      )}
      <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
        <Stat label="steps" value={entries.length} />
        {usage && <Stat label="llm" value={`${usage.calls} · ${fmtK(usage.inputTokens)} in`} />}
        <Stat label="writes" value={writes} />
        <Stat label="arr" value={arr} />
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onStory}>
          <BookOpen />
          Story
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <span>
      {label} <b className="font-medium text-foreground">{value}</b>
    </span>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
