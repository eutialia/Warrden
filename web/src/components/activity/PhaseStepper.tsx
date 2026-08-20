import { Radar } from 'lucide-react';
import { PHASES, phaseSummary, phaseTone, type Phase, type TargetGroup } from '@/lib/jobs';
import { pipelineIcon, pipelineLabel } from '@/lib/labels';
import { TONE_SOFT, TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

export function PhaseStepper({
  group,
  selected,
  onSelect,
}: {
  group: TargetGroup;
  selected: Phase;
  onSelect: (p: Phase) => void;
}) {
  return (
    <div className="grid grid-cols-3">
      {PHASES.map((p, i) => {
        const runs = group.byPhase[p];
        const tone = phaseTone(runs);
        const active = selected === p;
        const Icon = pipelineIcon(p) ?? Radar;
        return (
          // Each phase owns an equal third and centres inside it, so the icons sit at
          // fixed, evenly spaced positions. The rail is drawn from the cell edge to a
          // fixed inset either side of the centre, which means its length depends on the
          // column, never on how wide the label underneath happens to be. Hanging the rail
          // off the label box is what made "grabbed after 8 tries" push its own connector
          // sideways and knock the row out of true.
          <div key={p} className="relative flex flex-col items-center text-center">
            {i > 0 && <span className="absolute top-4 right-[calc(50%+1.5rem)] left-0 h-px bg-border" />}
            {i < PHASES.length - 1 && <span className="absolute top-4 right-0 left-[calc(50%+1.5rem)] h-px bg-border" />}
            <button
              type="button"
              onClick={() => onSelect(p)}
              className={cn(
                'flex w-full min-w-0 flex-col items-center gap-2 rounded-lg px-2 outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover',
                runs.length === 0 && 'opacity-40',
              )}
            >
              <span
                className={cn(
                  'relative flex size-8 shrink-0 items-center justify-center rounded-full border',
                  runs.length === 0 ? 'border-dashed bg-popover text-muted-foreground' : TONE_SOFT[tone],
                  active && 'ring-2 ring-ring ring-offset-2 ring-offset-popover',
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 max-w-full">
                <span className="block truncate text-sm font-medium">{pipelineLabel(p)}</span>
                <span className={cn('block truncate text-xs', runs.length ? TONE_TEXT[tone] : 'text-muted-foreground')}>
                  {phaseSummary(p, runs)}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
