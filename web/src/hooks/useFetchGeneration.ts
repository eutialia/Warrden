import { useCallback, useRef } from 'react';

/**
 * Ready-made guard for a page's own async refetch: call it right before starting the
 * fetch to get back an `isStale()` check, then skip applying the result (`setState`,
 * etc.) if `isStale()` is true by the time it resolves. Each call bumps a shared
 * generation counter, so it protects against ANY overlapping trigger clobbering an
 * earlier one — an SSE burst, a manual retry, a tab switch — not just SSE traffic
 * specifically.
 *
 * Split out of `useSseRefetch` (which used to return this alongside `disconnected`) so a
 * page's own `refetch` callback can depend on it directly: `refetch` needs `beginFetch`,
 * but `useSseRefetch` needs `refetch` as its own `onEvent` argument — pulling
 * `beginFetch` into its own hook breaks that circular reference instead of working around
 * it with a ref-indirection (the `refetchRef` dance Attention/ManagedObjects used to need).
 */
export function useFetchGeneration(): () => () => boolean {
  const generationRef = useRef(0);
  return useCallback(() => {
    const generation = ++generationRef.current;
    return () => generationRef.current !== generation;
  }, []);
}
