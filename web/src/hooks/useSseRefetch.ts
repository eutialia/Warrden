import { useEffect, useRef } from 'react';

/**
 * Unconditional refresh interval — it runs whether or not the stream looks healthy.
 *
 * The tempting design is to poll only while disconnected, but that depends on
 * noticing the disconnect, and a dropped stream does not reliably surface as an
 * `error` event: anything holding the socket open in front of the server (a reverse
 * proxy, the dev server's own proxy) leaves the client believing it is still
 * subscribed while no events will ever arrive again. A refresh that always runs
 * needs no such detection to be correct.
 *
 * Cheap enough to leave on: these endpoints are counts the indexes cover, and job
 * titles are cached server-side, so a tick costs no arr round-trips.
 */
const HEARTBEAT_MS = 45_000;

/** How long after an error to abandon a connection for a brand-new one. `EventSource`
 * retries on its own only while CONNECTING — once it gives up and goes CLOSED nothing
 * revives it. Best-effort: when the drop does surface, this restores instant updates
 * sooner than the heartbeat alone would. */
const RECONNECT_AFTER_MS = 15_000;

/**
 * One stream for the whole tab, shared by every caller.
 *
 * Each hook instance used to open its own `EventSource`, and the shell mounts several
 * at once (the overview provider plus whatever the current page wants). Browsers allow
 * six connections per origin over HTTP/1.1, and a stream holds its socket forever, so a
 * couple of tabs was enough to spend the budget and leave ordinary `fetch` calls queued
 * behind them with nothing to free them.
 */
/** One SSE frame off `/api/events/stream`, mirroring `EventRow` (server) minus its `ts`/`id`
 * bookkeeping, which is all `useSseRefetch` filters need to decide whether to fire. */
export interface SseEvent {
  kind: string;
  job_id: number | null;
  data: Record<string, unknown>;
}

interface Subscriber {
  fire: () => void;
  filter: (e: SseEvent | null) => boolean;
}

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
// The first open of a tab's life has nothing to catch up on — the pages' own initial
// loads cover it. Every open after a drop does.
let everConnected = false;

// null event = connection-level nudge (reconnect, heartbeat): everyone refetches.
function notifyAll(event: SseEvent | null): void {
  for (const sub of subscribers) {
    if (sub.filter(event)) sub.fire();
  }
}

// Trace entries are the noisiest event on the bus (one per pipeline step) and only the
// debug trace view cares about them live, so every other page opts out by default and a
// running job doesn't debounce-thrash unrelated screens.
const defaultFilter = (e: SseEvent | null): boolean => e === null || e.kind !== 'trace.appended';

function openStream(): void {
  if (source !== null) return;
  const stream = new EventSource('/api/events/stream');
  source = stream;

  stream.onmessage = (msg: MessageEvent<string>) => {
    let parsed: SseEvent | null = null;
    try {
      parsed = JSON.parse(msg.data) as SseEvent;
    } catch {
      // Malformed frame: treat as a generic nudge.
    }
    notifyAll(parsed);
  };

  stream.onopen = () => {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    if (everConnected) notifyAll(null);
    everConnected = true;
  };

  // Fires repeatedly while a connection flaps, so scheduling stays idempotent.
  stream.onerror = () => {
    if (retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      stream.close();
      if (source === stream) source = null;
      if (subscribers.size > 0) openStream();
    }, RECONNECT_AFTER_MS);
  };
}

function closeStreamIfIdle(): void {
  if (subscribers.size > 0) return;
  source?.close();
  source = null;
  if (retry !== null) {
    clearTimeout(retry);
    retry = null;
  }
}

/**
 * Keeps a page's data current, by whatever means are working.
 *
 * A subscription to `/api/events/stream` gives instant updates, trailing-debounced
 * (`debounceMs`) so a burst of writes — a busy pipeline, several webhooks landing
 * together — triggers one `onEvent` instead of one per message. Underneath it, a
 * slow heartbeat refreshes regardless, so the screen converges on the truth even if
 * the stream is silently dead.
 *
 * All of this is deliberately invisible. The dashboard shows no connection state:
 * the page being open already proves Warrden is up, so a self-status readout is a
 * tautology taking up room, and the health of the apps Warrden talks to is not
 * something anyone acts on from here. Correctness is the hook's job, not the
 * operator's.
 *
 * `debounceMs: 0` skips debouncing entirely — for a page watching one specific
 * thing (a single job's detail) where traffic is never a burst worth coalescing.
 *
 * `enabled: false` subscribes to nothing — for a page whose subject doesn't exist yet
 * (no `:id` resolved), rather than running a loop whose `onEvent` would just no-op.
 *
 * `filter` decides which SSE frames count as "something changed" for this caller;
 * `null` means a connection-level nudge (reconnect, heartbeat, malformed frame) that
 * every caller should treat as a refetch. Omit it for the default (everything except
 * `trace.appended`), or pass one to opt into trace noise (the debug page) or narrow to
 * a specific `job_id`/`kind`. Kept in a ref like `onEventRef` so an inline closure
 * doesn't resubscribe the stream on every render.
 */
export function useSseRefetch(
  onEvent: () => void,
  debounceMs = 500,
  enabled = true,
  filter?: (e: SseEvent | null) => boolean,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!enabled) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (debounceMs <= 0) {
        onEventRef.current();
        return;
      }
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => onEventRef.current(), debounceMs);
    };

    const heartbeat = setInterval(() => onEventRef.current(), HEARTBEAT_MS);
    const sub: Subscriber = { fire, filter: (e) => (filterRef.current ?? defaultFilter)(e) };
    subscribers.add(sub);
    openStream();

    return () => {
      subscribers.delete(sub);
      clearInterval(heartbeat);
      if (debounce !== null) clearTimeout(debounce);
      closeStreamIfIdle();
    };
  }, [debounceMs, enabled]);
}
