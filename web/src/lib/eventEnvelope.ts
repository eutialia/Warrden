import type { EventRow } from '@/api';
import type { Tone } from '@/lib/tone';

/**
 * The envelope every `events.data` carries. Hand-copied from `src/events/envelope.ts` —
 * there is no shared package between `web/` and the backend (same arrangement as `EventRow`
 * and `AccessTier` in `@/api`), so keep the two in step.
 *
 * The dashboard reads THIS and nothing else. Before the envelope, `stepParts` ran a
 * data-then-regex-then-message ladder because emitters attached structure inconsistently;
 * every stored row now carries facts, so there is nothing left to fall back to and the
 * fallback is gone. A row that somehow has no envelope reads as its own `kind`, which is a
 * visible defect rather than a plausible-looking sentence pulled out of a message.
 */

export interface EpisodeFact {
  season: number;
  episode: number;
  title?: string;
}

export interface FileFact {
  path: string;
  quality?: string;
  group?: string;
  size?: number;
  subs?: string[];
  audio?: string[];
}

export interface ReleaseFact {
  title?: string;
  indexer?: string;
  type?: 'pack' | 'multi' | 'single';
  guid?: string;
  group?: string;
  quality?: string;
}

export interface EventFacts {
  site?: string;
  tier?: string;
  instance?: string;
  url?: string;
  round?: number;
  maxRounds?: number;
  steps?: number;
  stop?: string;
  callsite?: string;
  detail?: string;
  title?: string;
  season?: number;
  episodes?: EpisodeFact[];
  file?: FileFact;
  files?: FileFact[];
  sourcePath?: string;
  release?: ReleaseFact;
  indexers?: string[];
  languages?: string[];
  archive?: string;
  source?: string;
  eventType?: string;
  pipeline?: string;
  downloadId?: string;
  outcome?: string;
  delayMs?: number;
  reason?: string;
  reasons?: string[];
  error?: string;
  permanent?: boolean;
  retried?: boolean;
  counts?: Record<string, number>;
  coalesceKey?: string;
}

export interface EventEnvelope {
  scope: string;
  action: string;
  facts?: EventFacts;
  verdict?: { tone: Tone };
}

/** Anything carrying an event `data` blob: an `EventRow`, or the attention item that
 * mirrors one (`AttentionItem` stores the event's `data` verbatim). */
export interface EnvelopeCarrier {
  data: Record<string, unknown>;
}

/** The envelope on a row, or `null` for a row written before the migration. */
export function envelopeOf(event: EnvelopeCarrier): EventEnvelope | null {
  const { scope, action, facts, verdict } = event.data as Partial<EventEnvelope>;
  if (typeof scope !== 'string' || typeof action !== 'string') return null;
  return { scope, action, ...(facts ? { facts } : {}), ...(verdict ? { verdict } : {}) };
}

export function factsOf(event: EnvelopeCarrier): EventFacts {
  return envelopeOf(event)?.facts ?? {};
}

/**
 * Collapses a burst of rows that share a `facts.coalesceKey` into the newest one, tagged
 * with how many it swallowed.
 *
 * The fold is here, on the read side, and not at the emitter: a pack import really does
 * fire one webhook per file and a settle-wait really does reschedule every two minutes, so
 * every row is a thing that happened and the log stays append-only. Only the *display*
 * wants one line for "34 webhooks arrived".
 *
 * Order is preserved by first appearance, so a folded burst keeps the place in the run
 * where it started rather than jumping to where it ended.
 */
export function foldByCoalesceKey(events: EventRow[]): { event: EventRow; folded: number }[] {
  const out: { event: EventRow; folded: number }[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    const key = factsOf(event).coalesceKey;
    if (key === undefined) {
      out.push({ event, folded: 1 });
      continue;
    }
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ event, folded: 1 });
      continue;
    }
    const slot = out[at]!;
    // The newest row wins the line: a reschedule burst's last delay and a webhook burst's
    // last outcome are the ones still true.
    out[at] = { event, folded: slot.folded + 1 };
  }
  return out;
}
