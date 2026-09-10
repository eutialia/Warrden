import { useMemo } from 'react';
import { Search } from 'lucide-react';
import type { Job } from '@/api';
import { RelativeTime } from '@/components/activity/RelativeTime';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ALL, foldJobsByTarget, jobTitle, PHASES, phaseSummary, phaseTone, STATUSES, type TargetGroup } from '@/lib/jobs';
import { jobStatusLabel, pipelineLabel, runOutcome } from '@/lib/labels';
import { TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

export function TargetList({
  jobs,
  selectedJobId,
  query,
  onQuery,
  pipeline,
  onPipeline,
  status,
  onStatus,
  onSelect,
}: {
  jobs: Job[];
  selectedJobId: number | null;
  query: string;
  onQuery: (v: string) => void;
  pipeline: string;
  onPipeline: (v: string) => void;
  status: string;
  onStatus: (v: string) => void;
  onSelect: (jobId: number) => void;
}) {
  const groups = useMemo(() => foldJobsByTarget(jobs), [jobs]);
  return (
    <div className="flex h-full min-h-0 flex-col border-r">
      <div className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-xs" placeholder="Search title or instance…" value={query} onChange={(e) => onQuery(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Select value={pipeline} onValueChange={(v) => onPipeline(v ?? ALL)}>
            <SelectTrigger className="h-7 flex-1 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All work</SelectItem>
              {PHASES.map((p) => <SelectItem key={p} value={p}>{pipelineLabel(p)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => onStatus(v ?? ALL)}>
            <SelectTrigger className="h-7 flex-1 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{jobStatusLabel(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => (
          <TargetRow key={g.key} group={g} selectedJobId={selectedJobId} onSelect={onSelect} />
        ))}
        {groups.length === 0 && <li className="px-3 py-6 text-xs text-muted-foreground">No titles match.</li>}
      </ol>
    </div>
  );
}

function TargetRow({ group, selectedJobId, onSelect }: { group: TargetGroup; selectedJobId: number | null; onSelect: (id: number) => void }) {
  const open = group.runs.some((r) => r.id === selectedJobId);
  const latestOutcome = runOutcome(group.latest);
  return (
    <li className={cn('border-b px-3 py-2 text-xs', open && 'bg-accent')}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => onSelect(group.latest.id)}>
        <span className="min-w-0 flex-1 truncate font-medium">{jobTitle(group.latest)}</span>
        <span className={cn('size-1.5 shrink-0 rounded-full', TONE_SOLID[latestOutcome.tone])} title={latestOutcome.label} />
      </button>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{group.latest.arr_instance}</span>
        <span>·</span>
        {PHASES.map((p) => {
          const runs = group.byPhase[p];
          return (
            <span
              key={p}
              title={`${pipelineLabel(p)} - ${phaseSummary(p, runs)}`}
              className={cn('size-1.5 rounded-full', runs.length === 0 ? 'bg-muted-foreground/20' : TONE_SOLID[phaseTone(runs)])}
            />
          );
        })}
        <span>·</span>
        <RelativeTime ts={group.lastTs} />
      </div>
      {open && (
        <ol className="mt-1.5 space-y-0.5 pl-3">
          {[...group.runs].sort((a, b) => b.created_at - a.created_at).map((job) => {
            const outcome = runOutcome(job);
            const on = job.id === selectedJobId;
            return (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => onSelect(job.id)}
                  className={cn('flex w-full items-center gap-2 rounded-sm py-0.5 text-left text-[11.5px]', on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', TONE_SOLID[outcome.tone])} />
                  <span className="min-w-0 flex-1 truncate">
                    {pipelineLabel(job.pipeline)} · <span className={cn(outcome.tone !== 'success' && TONE_TEXT[outcome.tone])}>{outcome.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px]">#{job.id}</span>
                  <RelativeTime ts={job.created_at} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}
