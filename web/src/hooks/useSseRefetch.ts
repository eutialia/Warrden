import { useEffect, useRef, useState } from 'react';

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
 * Cheap enough to leave on: these endpoints are a few indexed COUNTs, and job titles
 * are cached server-side, so a tick costs no arr round-trips.
 */
const HEARTBEAT_MS = 45_000;

/** How long after an error to abandon a connection for a brand-new one. `EventSource`
 * retries on its own only while CONNECTING — once it gives up and goes CLOSED nothing
 * revives it. Best-effort: when the drop does surface, this restores instant updates
 * sooner than the heartbeat alone would. */
const RECONNECT_AFTER_MS = 15_000;

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
 * `enabled: false` opens nothing — for a page whose subject doesn't exist yet (no
 * `:id` resolved), rather than running a loop whose `onEvent` would just no-op.
 */
export function useSseRefetch(onEvent: () => void, debounceMs = 500, enabled = true): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Survives across reconnect attempts, unlike an effect-local: the very first open
  // of the component's lifetime has nothing to catch up on (the page's own initial
  // load covers it), but every open after a drop does.
  const everConnectedRef = useRef(false);
  // Bumped to force the effect to tear down a dead EventSource and open a new one.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const heartbeat = setInterval(() => onEventRef.current(), HEARTBEAT_MS);
    const source = new EventSource('/api/events/stream');

    source.onmessage = () => {
      if (debounceMs <= 0) {
        onEventRef.current();
        return;
      }
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => onEventRef.current(), debounceMs);
    };

    source.onopen = () => {
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      // Drop any debounced call still pending from just before the drop, so it can't
      // fire a duplicate right after the catch-up below.
      if (debounce !== null) {
        clearTimeout(debounce);
        debounce = null;
      }
      if (everConnectedRef.current) onEventRef.current();
      everConnectedRef.current = true;
    };

    // Fires repeatedly while a connection flaps, so scheduling stays idempotent.
    source.onerror = () => {
      if (retry === null) retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_AFTER_MS);
    };

    return () => {
      source.close();
      clearInterval(heartbeat);
      if (debounce !== null) clearTimeout(debounce);
      if (retry !== null) clearTimeout(retry);
    };
  }, [debounceMs, enabled, attempt]);
}
