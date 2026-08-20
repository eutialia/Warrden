import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Job } from '@/api';
import { ToneBadge } from '@/components/ToneBadge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { foldJobsByTarget, jobTitle, PHASES, phaseSummary, phaseTone, type TargetGroup } from '@/lib/jobs';
import { pipelineLabel, runOutcome, targetKindLabel } from '@/lib/labels';
import { TONE_SOLID } from '@/lib/tone';
import { cn, formatRelativeTime } from '@/lib/utils';

function RelativeTime({ ts }: { ts: number }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs text-muted-foreground">{formatRelativeTime(ts)}</span>} />
      <TooltipContent>{new Date(ts).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}

function PhaseDots({ group }: { group: TargetGroup }) {
  return (
    <span className="flex items-center gap-0.5">
      {PHASES.map((p, i) => {
        const runs = group.byPhase[p];
        return (
          <span key={p} className="flex items-center gap-0.5">
            {i > 0 && <span className="h-px w-3 bg-border" />}
            <span
              title={`${pipelineLabel(p)} - ${phaseSummary(p, runs)}`}
              className={cn('size-2 rounded-full', runs.length === 0 ? 'bg-muted-foreground/20' : TONE_SOLID[phaseTone(runs)])}
            />
          </span>
        );
      })}
    </span>
  );
}

export function ActivityList({
  jobs,
  onOpen,
  dense = false,
  limit,
}: {
  jobs: Job[];
  onOpen: (g: TargetGroup) => void;
  dense?: boolean;
  /** Caps rendered groups, not jobs: the cap is meaningful only after folding, since a
   * single title can account for every job in the window. */
  limit?: number;
}) {
  const groups = useMemo(() => {
    const folded = foldJobsByTarget(jobs);
    return limit === undefined ? folded : folded.slice(0, limit);
  }, [jobs, limit]);

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24">Last run</TableHead>
          <TableHead>Title</TableHead>
          {!dense && <TableHead className="w-32">Pipeline</TableHead>}
          <TableHead className="w-56">Status</TableHead>
          {!dense && <TableHead className="w-20 text-right">Runs</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => {
          const outcome = runOutcome(g.latest);
          return (
            // The row is the hit area; the title is a real button so it can be
            // tabbed to. `relative` on <tr> is ignored, so the overlay would cover
            // the table and only the last row would receive clicks. A transform
            // contains it.
            <TableRow key={g.key} className="cursor-pointer [transform:translateZ(0)]">
              <TableCell>
                <RelativeTime ts={g.lastTs} />
              </TableCell>
              <TableCell className="max-w-0">
                <button type="button" onClick={() => onOpen(g)} className="block max-w-full text-left font-medium after:absolute after:inset-0">
                  <span className="block truncate">{jobTitle(g.latest)}</span>
                </button>
                <div className="truncate text-xs text-muted-foreground">
                  {g.latest.arr_instance} · {targetKindLabel(g.latest.target_kind)}
                </div>
              </TableCell>
              {!dense && (
                <TableCell>
                  <PhaseDots group={g} />
                </TableCell>
              )}
              <TableCell>
                <ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>
              </TableCell>
              {!dense && (
                <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                  {g.runs.length}
                  <ChevronRight className="ml-1 inline size-3" />
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
