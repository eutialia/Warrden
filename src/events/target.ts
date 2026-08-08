import type { TargetKind } from '../jobs/queue.js';

/** The bare minimum a job needs to carry to build its own `targetEventData` — a real
 * `JobRow` always satisfies this; kept structural rather than importing `JobRow` itself
 * so a caller that only has these three fields (not a full row) can still use it. */
interface EventTarget {
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
}

interface TargetEventData {
  instance: string;
  targetKind: TargetKind;
  targetId: number;
}

/**
 * Builds the `{ instance, targetKind, targetId }` triple that every job-scoped event's
 * `data` carries, optionally merged with `extra` fields specific to that event. This exact
 * shape (these exact key names) is the attention-dedupe protocol: `AttentionItems.open`
 * (`src/db/attention.ts`) looks for it on an `attention`-level event's `data` to collapse
 * repeated occurrences for the same target into one open item instead of piling up a row
 * per job run — a hand-written triple that drifts from this shape (a typo'd key, a
 * differently-cased field) would silently fall back to the weaker `(kind, jobId)` dedupe
 * rule instead of failing loudly, so every emitter builds it through here rather than by
 * hand.
 *
 * `extra.dedupeKey`, when present, is a second convention `AttentionItems.open` looks
 * for: a string identifying WHICH sub-target this particular emission is about, for a
 * `kind` that can fail at a finer grain than "the whole target" in one job run. A
 * per-target condition (a stuck download, a settle timeout, a missing mount) should keep
 * recurring into one open row and must NOT pass a `dedupeKey` — only an emitter whose
 * failures are genuinely per-sub-target (one row per failed sidecar, one row per failed
 * season, ...) should pass one (e.g. the sidecar's own path, or `String(seasonNumber)`),
 * so that five sidecars failing in the same run open five rows instead of collapsing into
 * whichever one happened to run last.
 */
export function targetEventData<T extends Record<string, unknown> = Record<string, never>>(
  job: EventTarget,
  extra?: T,
): TargetEventData & T {
  return { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, ...(extra as T) };
}
