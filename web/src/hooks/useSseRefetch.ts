import { useCallback, useEffect, useRef, useState } from 'react';

export interface SseRefetch {
  /** True while the `/api/events/stream` connection is down; clears itself the moment it
   * reconnects (a RE-connect also fires `onEvent` once to catch up on anything missed while
   * it was down — the first open of a fresh mount doesn't, the page's own initial load
   * covers that). Render a "reconnecting…" hint off this, or ignore it entirely. */
  disconnected: boolean;
  /**
   * Tears down the current `EventSource` (if any) and opens a fresh one. Needed because a
   * `readyState === CLOSED` error (the browser gave up retrying on its own — a hard
   * HTTP-level failure, not a transient drop `EventSource`'s built-in backoff would have
   * recovered from) leaves `disconnected` stuck `true` forever with nothing left to bring
   * the stream back except a brand-new connection. Wire this to a "Retry" button next to
   * the disconnected banner.
   */
  reconnect: () => void;
}

/**
 * Owns the one shared shape behind every dashboard page's "live-updating list": an
 * `EventSource` subscription to `/api/events/stream` for the component's lifetime, trailing
 * debounced (`debounceMs`) so a burst of writes (a busy pipeline, several webhooks landing
 * together) triggers one `onEvent` call instead of one per SSE message; a `disconnected`
 * flag while the stream is down; and an immediate (non-debounced) `onEvent` call on
 * reconnect to catch up on whatever was missed while it was down.
 *
 * `onEvent` is read through a ref rather than the effect's own dependency array, so the
 * connection is opened once per mount (or `reconnect()` call) and stays open across
 * re-renders (a new `onEvent` closure — e.g. from a page's own state changing — never
 * tears down and reopens it).
 *
 * `debounceMs: 0` skips debouncing entirely: every message calls `onEvent` immediately.
 * Use this for a page watching one specific thing (e.g. a single job's detail) where SSE
 * traffic is never a "burst" worth coalescing.
 *
 * `enabled: false` skips opening the connection at all (and closes it if it was already
 * open) — for a page whose subject doesn't exist yet (e.g. no `:id` route param resolved
 * yet), rather than opening a connection whose `onEvent` would just no-op.
 */
export function useSseRefetch(onEvent: () => void, debounceMs = 500, enabled = true): SseRefetch {
  const [disconnected, setDisconnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether this hook has ever successfully opened a connection before — the very first
  // open of the component's lifetime has nothing to "catch up" on yet (whatever the
  // page's own initial fetch already loaded covers it); only a RECONNECT (a drop followed
  // by the stream coming back, or a manual reconnect()) needs the catch-up refetch.
  const wasConnectedRef = useRef(false);
  // Bumped by reconnect() to force the effect below to tear down the old EventSource and
  // open a brand-new one — a plain state flip wouldn't otherwise change anything the
  // effect's own dependency array reads.
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  // Deliberately does NOT touch `wasConnectedRef` — a manual reconnect is still a
  // *reconnect* (there was a prior connection, now broken), so its first `onopen` must
  // still fire the catch-up call, same as an automatic browser-retried reconnect would.
  // Only the very first connection of the hook's lifetime skips it.
  const reconnect = useCallback(() => {
    setConnectionAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/events/stream');
    source.onmessage = () => {
      if (debounceMs <= 0) {
        onEventRef.current();
        return;
      }
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onEventRef.current(), debounceMs);
    };
    source.onopen = () => {
      // Drop any debounced call still pending from just before the drop — without this,
      // it fires its own extra `onEvent` up to `debounceMs` after the catch-up call below
      // already did the job.
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setDisconnected(false);
      if (wasConnectedRef.current) {
        onEventRef.current(); // reconnected — catch up on anything missed while the stream was down
      }
      wasConnectedRef.current = true;
    };
    source.onerror = () => {
      setDisconnected(true);
      // `readyState === CLOSED` means the browser has already given up retrying this
      // connection on its own (EventSource's automatic backoff only applies while it's
      // still `CONNECTING`) — `disconnected` will never clear itself in that case, so
      // `reconnect()` (a fresh `EventSource`, not a retry of this one) is the only way
      // back. A transient drop still mid-retry leaves `readyState` at `CONNECTING`, and
      // its own eventual `onopen` clears `disconnected` normally with no action needed.
    };
    return () => {
      source.close();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [debounceMs, enabled, connectionAttempt]);

  return { disconnected, reconnect };
}
