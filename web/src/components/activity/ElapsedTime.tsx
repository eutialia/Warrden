import { useCallback, useSyncExternalStore } from 'react';
import { cn, formatElapsed } from '@/lib/utils';

/**
 * One 1s interval for the whole app, running only while something is on screen to read it.
 *
 * A drawer holds hundreds of these — a timer each would be hundreds of timers and hundreds
 * of renders a second — so they share a clock the way `usePrefersReducedMotion` shares a
 * media query.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  timer ??= setInterval(() => {
    for (const listener of listeners) listener();
  }, 1000);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** How long since `ts`, on the shared clock.
 *
 * `RelativeTime` can sit still — its finest unit is a minute, and whatever renders it
 * refetches long before that matters. A live run is read in seconds, where a frozen number
 * is indistinguishable from a stalled one.
 *
 * The snapshot is the formatted string rather than the tick count, so a row only re-renders
 * when its own text actually changes: every second under a minute, then once a minute, then
 * once an hour. An hour-old step in a finished run costs one render an hour. */
export function ElapsedTime({ ts, className }: { ts: number; className?: string }) {
  const snapshot = useCallback(() => formatElapsed(ts), [ts]);
  const elapsed = useSyncExternalStore(subscribe, snapshot, snapshot);

  return <span className={cn('font-mono tabular-nums', className)}>{elapsed}</span>;
}
