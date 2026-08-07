import { useCallback, useEffect, useRef, useState } from 'react';

export interface SseRefetch {
  /** True while the `/api/events/stream` connection is down; clears itself the moment it
   * reconnects (which also fires `onEvent` once, per below, to catch up on anything missed
   * while it was down). Render a "reconnecting…" hint off this, or ignore it entirely. */
  disconnected: boolean;
  /**
   * Ready-made guard for a page's own async refetch, for pages that don't already have
   * one: call it right before starting the fetch to get back an `isStale()` check, then
   * skip applying the result (`setState`, etc.) if `isStale()` is true by the time it
   * resolves. Each call bumps a shared generation counter, so it protects against ANY
   * overlapping trigger clobbering an earlier one — an SSE burst, a manual retry, a tab
   * switch — not just SSE traffic specifically, the same way Attention's and Managed
   * objects' own `requestIdRef` did before this was pulled out from under them.
   */
  beginFetch: () => () => boolean;
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
 * connection is opened once per mount and stays open across re-renders (a new `onEvent`
 * closure — e.g. from a page's own state changing — never tears down and reopens it).
 *
 * `debounceMs: 0` skips debouncing entirely: every message calls `onEvent` immediately.
 * Use this for a page watching one specific thing (e.g. a single job's detail) where SSE
 * traffic is never a "burst" worth coalescing.
 */
export function useSseRefetch(onEvent: () => void, debounceMs = 500): SseRefetch {
  const [disconnected, setDisconnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  const beginFetch = useCallback(() => {
    const generation = ++generationRef.current;
    return () => generationRef.current !== generation;
  }, []);

  useEffect(() => {
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
      setDisconnected(false);
      onEventRef.current(); // reconnected — catch up on anything missed while the stream was down
    };
    source.onerror = () => setDisconnected(true);
    return () => {
      source.close();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [debounceMs]);

  return { disconnected, beginFetch };
}
