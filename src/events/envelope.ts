/**
 * The one shape every `events.data` carries.
 *
 * An event row used to be a composed sentence plus whatever loose keys its emitter felt
 * like attaching, which left every consumer regex-parsing `message` to get back the parts
 * the emitter already had. The envelope inverts that: emitters write FACTS, the UI composes
 * labels from facts, and `message` stays as the human line for the CLI and `docker logs`.
 *
 * Three rules hold everywhere:
 *
 *  - **Facts, never display strings.** `facts.season` is `4`, not `"Season 4"`. The one
 *    exception is `facts.detail`, which is prose the LLM itself wrote — quoting the agent
 *    is reporting a fact, not formatting one.
 *  - **Immutable.** Every envelope is frozen at construction. The tracer captures payloads
 *    as lazy closures, so a shared object mutated after emit would let the trace record a
 *    state that never existed at the moment the event was appended.
 *  - **Append-only.** There is no update path for an event row. The one sanctioned rewrite
 *    is the one-time migration in `src/db/migrateEventEnvelopes.ts`.
 */

/** Verdict colour, mirroring the dashboard's `Tone`. Only closing events carry one. */
export type EventTone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';

/** One episode, the same way for Sonarr webhooks, acquire picks and subtitle coverage.
 * Never a rendered `S04E12` — the UI owns that spelling. */
export interface EpisodeFact {
  readonly season: number;
  readonly episode: number;
  readonly title?: string;
}

/**
 * One media file. Deliberately arr-agnostic: Sonarr's `episodeFile` and Radarr's
 * `movieFile` both normalize into this, so a consumer never branches on which arr sent it
 * (Phase C widens the webhook schema into exactly this shape).
 */
export interface FileFact {
  readonly path: string;
  readonly quality?: string;
  readonly group?: string;
  readonly size?: number;
  /** Subtitle language tags carried inside the container. */
  readonly subs?: readonly string[];
  /** Audio language tags carried inside the container. */
  readonly audio?: readonly string[];
}

/** One release as an indexer describes it. `type` is the shape the picker reasons about. */
export interface ReleaseFact {
  readonly title?: string;
  readonly indexer?: string;
  readonly type?: 'pack' | 'multi' | 'single';
  readonly guid?: string;
  readonly group?: string;
  readonly quality?: string;
}

/**
 * The normalized fact vocabulary. Closed on purpose: an open index signature would let the
 * old per-emitter sprawl back in under a new name, and the whole point is that a consumer
 * can read `facts.site` without knowing which pipeline wrote it.
 *
 * Adding a field here is a deliberate act — check first whether an existing one already
 * says it.
 */
export interface EventFacts {
  // --- where ---
  /** Subtitle site, by label (`subhd.tv`), never a full URL. */
  readonly site?: string;
  /** Access-ladder rung the step ran on. */
  readonly tier?: string;
  readonly instance?: string;
  readonly url?: string;

  // --- agent steps ---
  readonly round?: number;
  readonly maxRounds?: number;
  readonly steps?: number;
  /** `StopReason.kind` — the closed vocabulary from `src/agent/stop.ts`. */
  readonly stop?: string;
  readonly callsite?: string;
  /** Prose the model itself produced. The only free text allowed in facts. */
  readonly detail?: string;

  // --- subject ---
  readonly title?: string;
  readonly season?: number;
  readonly episodes?: readonly EpisodeFact[];
  readonly file?: FileFact;
  readonly files?: readonly FileFact[];
  /** Where `file` came from, when the event is about moving one. */
  readonly sourcePath?: string;
  readonly release?: ReleaseFact;
  readonly indexers?: readonly string[];
  readonly languages?: readonly string[];
  readonly archive?: string;

  // --- narration ---
  /** What put this job in the queue: `webhook`, `reconcile`, `manual`, `ingest`. */
  readonly source?: string;
  readonly eventType?: string;
  readonly pipeline?: string;
  /**
   * The download client's id for the grab this event is about.
   *
   * Its own key rather than a corner of `release`: `release.guid` is the INDEXER's id for a
   * release, and this is the download client's id for a transfer of it — two namespaces
   * that happen to describe the same download, and the only stable join between a webhook
   * and a queue item.
   */
  readonly downloadId?: string;
  /**
   * How an action ended, one level finer than the action itself: a trigger's enqueue
   * (`enqueued`, `coalesced`), a give-up's `because` (`not-found`, `blocked`, `unsure`).
   * `stop`/`action` say what happened; this says which flavour of it.
   */
  readonly outcome?: string;
  readonly delayMs?: number;
  /** One sentence saying why — a model's veto, an operator's note, a failure's message. */
  readonly reason?: string;
  /** Short, repeated causes: the top drop reasons of a filter pass, the tiers tried. */
  readonly reasons?: readonly string[];
  /** First sentence of the error that ended a run. */
  readonly error?: string;
  readonly permanent?: boolean;
  readonly retried?: boolean;
  /** Everything countable, by name: `{ kept: 30, dropped: 98, placed: 12 }`. */
  readonly counts?: Readonly<Record<string, number>>;

  /**
   * Read-side fold key. Rows stay individually stored (append-only, and Phase C wants the
   * per-arrival rows); a consumer collapses a burst by folding on this key at display time.
   */
  readonly coalesceKey?: string;
}

/** What a closing event concluded. Tone only — the words are the consumer's business. */
export interface EventVerdict {
  readonly tone: EventTone;
}

/**
 * The envelope itself.
 *
 * `scope` is the phase (`acquire`, `subtitle`, `trigger`, `run`); `action` is the verb
 * within it (`pick`, `filter`, `finished`). Together they are the stable identity a
 * consumer switches on — `kind` stays as the log's own vocabulary.
 */
export interface EventEnvelope {
  /**
   * The phase this event belongs to. REQUIRED, and the reason a stored row can be told
   * apart from a pre-envelope one at a glance: legacy payloads never had a `scope`, and
   * some of them did have an `action` (the accept-payload discriminator), so `action`
   * alone is not enough to recognise an envelope.
   */
  readonly scope: string;
  readonly action: string;
  readonly facts?: EventFacts;
  readonly verdict?: EventVerdict;
}

/** Nothing outside this module builds an envelope, so the freeze can never be skipped. */
type EnvelopeInput = {
  scope: string;
  action: string;
  facts?: EventFacts;
  verdict?: EventVerdict;
};

/**
 * Builds one event's `data`: the envelope, frozen, merged with whatever protocol fields the
 * emitter carries alongside it (`targetEventData`'s `{instance, targetKind, targetId}`
 * triple and its optional `dedupeKey` — see `src/events/target.ts`).
 *
 * `extra` goes UNDER the envelope in the spread order so no caller can shadow `action` or
 * `facts` with a loose key of the same name.
 *
 * Undefined-valued fact keys are dropped rather than serialized as absent-but-present:
 * `JSON.stringify` already erases them, and dropping them here means an in-memory envelope
 * and its round-tripped self compare equal, which is what the tests rely on.
 */
export function eventEnvelope<E extends object = Record<string, never>>(
  env: EnvelopeInput,
  extra?: E,
): Readonly<EventEnvelope & E> {
  const facts = env.facts === undefined ? undefined : pruned(env.facts);
  return deepFreeze({
    ...(extra as E),
    scope: env.scope,
    action: env.action,
    ...(facts === undefined ? {} : { facts }),
    ...(env.verdict === undefined ? {} : { verdict: env.verdict }),
  }) as Readonly<EventEnvelope & E>;
}

function pruned(facts: EventFacts): EventFacts | undefined {
  const entries = Object.entries(facts).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as EventFacts);
}

/**
 * Freezes an object graph in place. Only plain objects and arrays are walked — a `Date` or
 * a class instance in an envelope would be a bug (nothing here is JSON-safe otherwise), and
 * walking one would freeze someone else's live object.
 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Guarantees an envelope on every appended row.
 *
 * Emitters whose event carries real structure build one explicitly with `eventEnvelope` —
 * that is where verdicts, normalized files and release facts come from. But the log has
 * ~90 emitters and a consumer that reads `data` unconditionally (the dashboard deleted its
 * message-parsing fallback), so "the emitter remembered" is not a strong enough invariant:
 * one narration event appended without an envelope would render as a bare `kind`.
 *
 * So the log closes it here. A `kind` is already `scope.action` by convention everywhere
 * (`ingest.stale-cleaned`, `reconcile.gc-skip-tag`), which is exactly the envelope's own
 * split, and `lift` recovers the facts a legacy-shaped payload already carried under the
 * names the vocabulary uses.
 */
export function ensureEnvelope(kind: string, data: object | undefined): Readonly<EventEnvelope & Record<string, unknown>> {
  const payload = (data ?? {}) as Record<string, unknown>;
  if (typeof payload.scope === 'string' && typeof payload.action === 'string') {
    return deepFreeze(payload) as Readonly<EventEnvelope & Record<string, unknown>>;
  }
  const dot = kind.indexOf('.');
  return eventEnvelope(
    {
      scope: dot === -1 ? 'system' : kind.slice(0, dot),
      action: dot === -1 ? kind : kind.slice(dot + 1),
      facts: lift(payload),
    },
    payload,
  );
}

/**
 * The facts a loosely-shaped `data` already carries, under the names the vocabulary uses.
 *
 * This is the second of two mappers over the same legacy payloads: the one-time migration
 * (`src/db/migrateEventEnvelopes.ts`) has its own per-kind rule table and its own readers,
 * because it can key off the row's `kind` and this can't. Nothing is shared between them —
 * `lift` and `pick` are module-private. What keeps them honest is the drift guard in
 * `tests/migrateEventEnvelopes.test.ts`, which runs both over the same legacy rows and
 * compares the facts they extract. A stored row and a freshly appended one of the same kind
 * should be indistinguishable; change one mapper and that test says so.
 */
function lift(data: Record<string, unknown>): EventFacts {
  // The file the event is ABOUT: where it landed, or where it was set aside to, or the
  // destination it collided with — every emitter that moves a file named one of these.
  const path =
    pick<string>(data, 'path', 'string') ??
    pick<string>(data, 'placedPath', 'string') ??
    pick<string>(data, 'quarantinedPath', 'string') ??
    pick<string>(data, 'targetPath', 'string');
  return {
    site: pick(data, 'site', 'string'),
    title: pick(data, 'title', 'string'),
    instance: pick(data, 'instance', 'string'),
    url: pick(data, 'url', 'string'),
    archive: pick(data, 'archive', 'string'),
    pipeline: pick(data, 'pipeline', 'string'),
    season: pick(data, 'seasonNumber', 'number'),
    // `reasoning` is what the older emitters called the model's own sentence.
    reason: pick(data, 'reason', 'string') ?? pick(data, 'reasoning', 'string'),
    sourcePath: pick(data, 'sourcePath', 'string') ?? pick(data, 'sourceFile', 'string'),
    ...(path === undefined ? {} : { file: { path, group: pick(data, 'releaseGroup', 'string') } }),
    counts: liftCounts(data),
  };
}

function liftCounts(data: Record<string, unknown>): Record<string, number> | undefined {
  const nested = data.counts;
  const out: Record<string, number> = {};
  if (isPlainObject(nested)) {
    for (const [k, v] of Object.entries(nested)) if (typeof v === 'number') out[k] = v;
  }
  const count = pick<number>(data, 'count', 'number');
  if (count !== undefined) out.count = count;
  return Object.keys(out).length === 0 ? undefined : out;
}

function pick<T>(data: Record<string, unknown>, key: string, type: 'string' | 'number'): T | undefined {
  const v = data[key];
  return typeof v === type ? (v as T) : undefined;
}

/** Reads an envelope back off a stored row. Returns `null` when `data` carries none, which
 * after the migration only happens for a row written by an older build. */
export function readEnvelope(data: Record<string, unknown>): EventEnvelope | null {
  const { scope, action } = data;
  if (typeof scope !== 'string' || typeof action !== 'string') return null;
  return {
    scope,
    action,
    ...(isPlainObject(data.facts) ? { facts: data.facts as EventFacts } : {}),
    ...(isPlainObject(data.verdict) ? { verdict: data.verdict as unknown as EventVerdict } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
