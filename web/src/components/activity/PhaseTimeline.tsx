import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Job } from '@/api';
import { ElapsedTime } from '@/components/activity/ElapsedTime';
import { RelativeTime } from '@/components/activity/RelativeTime';
import { RunDetail } from '@/components/activity/RunDetail';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BrailleSpinner } from '@/components/ui/spinner';
import { jobDuration } from '@/lib/jobs';
import { runOutcome } from '@/lib/labels';
import { TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

/** Toggle set: comparing two runs means having both open at once, so never an accordion.
 * `initialId` is a deep link (`?run=`): start with that node open so RunDetail mounts
 * for the run the operator clicked, rather than waiting for a second click. */
function useOpenSet(initialId?: number): [ReadonlySet<number>, (id: number) => void] {
  const [open, setOpen] = useState<ReadonlySet<number>>(
    () => (initialId === undefined ? new Set() : new Set([initialId])),
  );
  return [
    open,
    (id: number) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  ];
}

/**
 * One phase's runs as a vertical timeline, one node per run, no folding.
 *
 * An earlier draft collapsed consecutive same-outcome runs behind an `xN` chip, because
 * this database held fifteen identical ingest runs for one season pack. Those predate
 * `68270a7`, which debounces a webhook storm into a single run at the queue. Redundant
 * runs are a queue bug, already fixed there; hiding them in the UI would only have made
 * the next one harder to notice.
 */
export function PhaseTimeline({ runs, expandRunId }: { runs: Job[]; expandRunId?: number }) {
  const [open, toggle] = useOpenSet(expandRunId);
  return (
    <ol className="relative space-y-1 border-l pl-6">
      {runs.map((job) => {
        const { label, tone } = runOutcome(job);
        const isOpen = open.has(job.id);
        const running = job.status === 'running';
        // A queued run's detail streams like a live one, so its node has to look alive too.
        // The dot pulses for both; the braille spinner stays with `running` alone — it says
        // an agent is turning, and a pending job is deliberately doing nothing yet.
        const live = running || job.status === 'pending';
        return (
          <li key={job.id} className="relative">
            <span
              className={cn(
                'absolute top-3.5 -left-[1.7rem] size-2 rounded-full ring-4 ring-popover',
                TONE_SOLID[tone],
                live && 'animate-pulse',
              )}
            />
            <Collapsible open={isOpen} onOpenChange={() => toggle(job.id)}>
              <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
                <ChevronRight
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform duration-240 ease-panel',
                    isOpen && 'rotate-90',
                  )}
                />
                <span className={cn('text-sm', tone === 'success' ? '' : TONE_TEXT[tone])}>{label}</span>
                {running && (
                  <>
                    <BrailleSpinner />
                    <span className="sr-only">Working</span>
                  </>
                )}
                {/* A live run shows one number. Duration and "started X ago" are the same
                    value until the run ends, so pairing them reads as a stutter; the pair
                    returns once there is a finish to measure against. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {live ? (
                    <ElapsedTime ts={job.created_at} />
                  ) : (
                    <>
                      <span className="font-mono tabular-nums">{jobDuration(job) ?? '—'}</span>
                      <span>·</span>
                      <RelativeTime ts={job.created_at} />
                    </>
                  )}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="overflow-hidden data-closed:animate-conceal data-open:animate-reveal">
                {/* Mounted only while open so the detail fetch is still on demand; the
                    panel measures its own height once the content lands. */}
                {isOpen && <RunDetail jobId={job.id} />}
              </CollapsibleContent>
            </Collapsible>
          </li>
        );
      })}
    </ol>
  );
}
