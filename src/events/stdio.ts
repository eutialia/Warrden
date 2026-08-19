import type { EventRow } from './log.js';

/** One line, no payload: `data` can be huge (candidate lists, traces) and docker
 * logs already have the human `message`. Level is padded so `kind` starts in the
 * same column whether the event is `info` or `attention`. */
export function formatEventLine(e: Pick<EventRow, 'ts' | 'level' | 'kind' | 'message'>): string {
  return `${new Date(e.ts).toISOString()} ${e.level.padEnd(10)} ${e.kind}  ${e.message}`;
}

export function writeEventToStdio(e: EventRow): void {
  const line = formatEventLine(e);
  if (e.level === 'info') console.log(line);
  else if (e.level === 'warn') console.warn(line);
  else console.error(line);
}

/** Docker's log driver only sees this process's stdio. EventLog itself is SQLite + SSE,
 * so a process-level subscriber is what makes `docker logs` show the same operational
 * history as the dashboard. `broadcast` events are not persisted and stay off stdio
 * (they are high-volume trace pings). */
export function bindEventLogToStdio(events: { subscribe: (fn: (e: EventRow) => void) => () => void }): () => void {
  return events.subscribe((e) => {
    // `broadcast` fans out with `id: 0` and never hits the events table. Those are
    // high-volume trace pings (`trace.appended`); docker logs should see persisted
    // operational events only.
    if (e.id === 0) return;
    writeEventToStdio(e);
  });
}
