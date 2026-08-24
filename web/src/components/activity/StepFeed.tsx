import { ElapsedTime } from '@/components/activity/ElapsedTime';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { BrailleSpinner } from '@/components/ui/spinner';
import { type Tone, TONE_SOLID, TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

export interface StepFeedItem {
  id: string | number;
  /** The one line that stays on screen. */
  label: string;
  /** The rest, shown on hover. */
  detail: string;
  ts: number;
  tone?: Tone;
}

/**
 * A live tail of what something is doing right now, newest on top.
 *
 * Deliberately flat: the feed has to stay legible while it moves, so a step is one
 * `Marker` with one truncated line and its detail behind a hover, never a rail with a
 * paragraph under it. The newest dot pulses while the work is live.
 *
 * `steps` arrive oldest-first (the order every event log is written in); the display
 * flips them. Knows nothing about jobs or events — feed it whatever you have.
 */
export function StepFeed({
  steps,
  running,
  spinner = true,
  emptyLabel = 'Starting up…',
  isNew,
}: {
  steps: StepFeedItem[];
  running: boolean;
  /** Off for a job that is queued rather than working: a spinner claims an agent is
   * turning, and a pending run is deliberately doing nothing. The pulsing dot still says
   * the feed is live. */
  spinner?: boolean;
  emptyLabel?: string;
  /** Whether a step arrived after the feed was on screen — see `useEntranceGate`. Only
   * those play the entrance; the rest are already-happened history. */
  isNew: (id: string | number) => boolean;
}) {
  if (steps.length === 0) {
    if (!running) return null;
    return (
      <Marker className="text-xs">
        <MarkerIcon className={cn('flex items-center justify-center', spinner && 'text-center font-mono')}>
          {spinner ? (
            <BrailleSpinner />
          ) : (
            <span className={cn('size-1.5 rounded-full', TONE_SOLID.info, 'animate-pulse')} />
          )}
        </MarkerIcon>
        <MarkerContent>{emptyLabel}</MarkerContent>
      </Marker>
    );
  }

  return (
    <ol className="space-y-1">
      {steps
        .slice()
        .reverse()
        .map((step, i) => {
          const live = running && i === 0;
          return (
            // Keyed by id so an arriving step mounts — and only then plays its
            // entrance — rather than the whole list re-animating on every append.
            <li
              key={step.id}
              className={cn(
                isNew(step.id) && 'animate-in duration-240 ease-panel fade-in-0 slide-in-from-top-1 motion-reduce:animate-none',
              )}
            >
              <Marker className={cn('text-xs', live && 'text-foreground', step.tone && TONE_TEXT[step.tone])}>
                <MarkerIcon className="flex items-center justify-center">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      live ? cn(TONE_SOLID.info, 'animate-pulse') : 'bg-muted-foreground/40',
                    )}
                  />
                </MarkerIcon>
                <HoverCard>
                  <HoverCardTrigger render={<MarkerContent />} className="flex-1 truncate">
                    {step.label}
                  </HoverCardTrigger>
                  <HoverCardContent side="top" align="start" className="w-96">
                    <p className="text-xs leading-relaxed break-words">{step.detail}</p>
                  </HoverCardContent>
                </HoverCard>
                {/* Elapsed, not relative: a six-step window of a live run spans well under a
                    minute, where `formatRelativeTime` says "just now" six times over. Seconds
                    are what make a stalled last step visible. */}
                <ElapsedTime ts={step.ts} className="shrink-0 text-[0.7rem] text-muted-foreground/70" />
              </Marker>
            </li>
          );
        })}
    </ol>
  );
}
