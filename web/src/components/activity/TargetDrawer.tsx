import { useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage, postAcquire, type Job } from '@/api';
import { PhaseStepper } from '@/components/activity/PhaseStepper';
import { PhaseTimeline } from '@/components/activity/PhaseTimeline';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PHASES, jobTitle, type Phase, type TargetGroup } from '@/lib/jobs';
import { pipelineLabel, targetKindLabel } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

function latestAcquire(group: TargetGroup): Job | undefined {
  const runs = group.byPhase.acquire;
  if (runs.length === 0) return undefined;
  return runs.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
}

function acquireIsSettled(job: Job): boolean {
  return job.acquireOutcome === 'grabbed' || job.acquireOutcome === 'already-satisfied';
}

function RepickAction({ group }: { group: TargetGroup }) {
  const acquire = latestAcquire(group);
  const [repicking, setRepicking] = useState(false);
  if (!acquire) return null;

  const settled = acquireIsSettled(acquire);

  async function handleRepick(): Promise<void> {
    if (settled) return;
    setRepicking(true);
    try {
      await postAcquire({
        arrInstance: group.latest.arr_instance,
        targetKind: group.latest.target_kind,
        targetId: group.latest.target_id,
      });
      toast.success('Re-pick queued');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to queue re-pick'));
    } finally {
      setRepicking(false);
    }
  }

  const button = (
    <Button variant="outline" size="sm" disabled={repicking || settled} onClick={() => void handleRepick()}>
      {repicking ? 'Queuing…' : 'Pick a different release'}
    </Button>
  );

  return (
    <div className="mt-3">
      {settled ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
          <TooltipContent>This target already has what it needs.</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </div>
  );
}

function TargetDrawerBody({ group }: { group: TargetGroup }) {
  const firstWithRuns = PHASES.find((p) => group.byPhase[p].length > 0) ?? 'acquire';
  const [phase, setPhase] = useState<Phase>(firstWithRuns);
  const runs = group.byPhase[phase];
  return (
    <div className="space-y-5">
      <PhaseStepper group={group} selected={phase} onSelect={setPhase} />
      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          {pipelineLabel(phase)} · {runs.length} run{runs.length === 1 ? '' : 's'}
        </p>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">This phase has not run for this title.</p>
        ) : (
          <PhaseTimeline runs={runs} />
        )}
      </div>
    </div>
  );
}

export function TargetDrawer({ group, onClose }: { group: TargetGroup | null; onClose: () => void }) {
  return (
    <Sheet open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-3xl!">
        {group && (
          <div className="flex h-full flex-col gap-5 overflow-y-auto p-6">
            <div>
              <h2 className="font-serif text-2xl">{jobTitle(group.latest)}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {group.latest.arr_instance} · {targetKindLabel(group.latest.target_kind)} · {group.runs.length} runs ·
                last {formatRelativeTime(group.lastTs)}
              </p>
              <RepickAction group={group} />
            </div>
            <TargetDrawerBody key={group.key} group={group} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
