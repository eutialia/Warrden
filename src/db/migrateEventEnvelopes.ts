import type Database from 'better-sqlite3';
import { eventEnvelope, readEnvelope, type EventEnvelope, type EventFacts, type EventTone } from '../events/envelope.js';

/**
 * One-time rewrite of every stored `events.data` into the envelope
 * (`src/events/envelope.ts`).
 *
 * The event log is append-only everywhere else; this is the single sanctioned exception,
 * and it exists so the dashboard can drop its regex-and-fallback ladder entirely. After it
 * runs, every surviving row carries `{scope, action, facts?, verdict?}` and a reader can
 * trust `data` unconditionally.
 *
 * **A row whose `kind` has no rule below is DELETED**, not left behind: a permanent
 * frontend fallback for rows nobody can name is exactly what this refactor is removing.
 * That is a deliberate, operator-visible loss — hence the report, and hence `dryRun`.
 *
 * Idempotent: a row that already parses as an envelope is left exactly as it is, so a
 * second run is a no-op and an interrupted run resumes safely.
 */

/** `[site] head: detail` — the shape every agent event's message was composed in. `s` flag
 * because a detail can run to several lines. */
const COMPOSED_MESSAGE = /^\[([^\]]+)\] ([^:]+): (.+)$/s;

interface ComposedParts {
  site: string;
  head: string;
  detail: string;
}

export function parseComposedMessage(message: string): ComposedParts | null {
  const m = COMPOSED_MESSAGE.exec(message);
  return m ? { site: m[1]!, head: m[2]!, detail: m[3]! } : null;
}

interface Row {
  id: number;
  kind: string;
  message: string;
  data: string;
}

export interface MigrationReport {
  /** Rows rewritten, by kind. */
  migrated: Record<string, number>;
  /** Rows dropped for having no rule, by kind. */
  deleted: Record<string, number>;
  /** Rows already carrying an envelope, by kind — a re-run's whole population. */
  skipped: Record<string, number>;
  total: number;
}

/** A per-kind rule: where the event belongs, what it did, and what it knew. */
interface Rule {
  scope: string;
  action: string;
  facts?: (data: Record<string, unknown>, message: string) => EventFacts;
  verdict?: (data: Record<string, unknown>) => EventTone;
}

// --- readers over the untyped legacy `data` -------------------------------------------

function str(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' ? v : undefined;
}

function num(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === 'number' ? v : undefined;
}

function strings(data: Record<string, unknown>, key: string): string[] | undefined {
  const v = data[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

function arrayLength(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return Array.isArray(v) ? v.length : undefined;
}

function counts(data: Record<string, unknown>): Record<string, number> | undefined {
  const v = data.counts;
  if (typeof v !== 'object' || v === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number') out[k] = n;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Legacy episode rows (`subtitle.unresolved`) carried arr ids and per-episode language
 * lists. The envelope's shape is `{season, episode}` plus one `languages` list for the
 * event, which is what every consumer actually reads. */
function episodes(data: Record<string, unknown>): { episodes?: EventFacts['episodes']; languages?: string[] } {
  const raw = data.episodes;
  if (!Array.isArray(raw)) return {};
  const langs = new Set<string>();
  const out: { season: number; episode: number }[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const rec = e as Record<string, unknown>;
    if (typeof rec.seasonNumber === 'number' && typeof rec.episodeNumber === 'number') {
      out.push({ season: rec.seasonNumber, episode: rec.episodeNumber });
    }
    for (const l of Array.isArray(rec.missingLanguages) ? rec.missingLanguages : []) {
      if (typeof l === 'string') langs.add(l);
    }
  }
  return { ...(out.length > 0 ? { episodes: out } : {}), ...(langs.size > 0 ? { languages: [...langs] } : {}) };
}

/** The parts every job-scoped legacy row already carried in the same names the envelope
 * uses. Shared by most rules so a rule only spells out what is peculiar to its kind. */
function common(data: Record<string, unknown>): EventFacts {
  return {
    site: str(data, 'site'),
    title: str(data, 'title'),
    instance: str(data, 'instance'),
    season: num(data, 'seasonNumber'),
    counts: counts(data),
  };
}

/** The detail half of a `[site] head: detail` message — the agent's own sentence. */
function detailOf(message: string): string | undefined {
  return parseComposedMessage(message)?.detail;
}

/** The failure narration every `*-failed` kind put in its message and nowhere else. */
function errorOf(message: string): string {
  const colon = message.indexOf(': ');
  return colon === -1 ? message : message.slice(colon + 2);
}

// --- rule table -----------------------------------------------------------------------

const WARN = (): EventTone => 'warning';
const DANGER = (): EventTone => 'danger';
const SUCCESS = (): EventTone => 'success';

/** Narration with nothing structured to lift: scope + action are the whole rule. */
function plain(scope: string, action: string, verdict?: () => EventTone): Rule {
  return { scope, action, facts: common, ...(verdict ? { verdict } : {}) };
}

function failure(scope: string, action: string): Rule {
  return {
    scope,
    action,
    facts: (d, m) => ({ ...common(d), error: errorOf(m) }),
    verdict: WARN,
  };
}

/**
 * Every kind that has ever been written to this table, and what it becomes.
 *
 * Kinds that no longer exist in the code (`acquire.grabbed`, `job.failed`,
 * `acquire.candidates-capped`, `subtitle.site-cooldown`, `webhook.recreate-failed`, the old
 * `subtitle.filter`) still get rules: they are in real installs' history, and deleting a
 * year of runs because the emitter was renamed is not a migration.
 */
const RULES: Record<string, Rule> = {
  // --- triggers ---
  'webhook.received': {
    scope: 'trigger',
    action: 'webhook',
    facts: (d) => ({
      source: 'webhook',
      instance: str(d, 'instance'),
      eventType: str(d, 'eventType'),
      outcome: str(d, 'outcome'),
      reason: d.isUpgrade === true ? 'upgrade' : d.isUpgrade === false ? 'new' : undefined,
    }),
  },
  'trigger.reconcile': { scope: 'trigger', action: 'reconcile', facts: (d) => ({ ...common(d), source: 'reconcile' }) },
  'trigger.manual': { scope: 'trigger', action: 'manual', facts: (d) => ({ ...common(d), source: 'manual' }) },

  // --- run lifecycle ---
  'run.finished': { scope: 'run', action: 'finished', facts: common },
  'job.failed': {
    scope: 'run',
    action: 'finished',
    facts: (d, m) => ({
      pipeline: str(d, 'pipeline'),
      error: errorOf(m),
      retried: typeof d.retried === 'boolean' ? d.retried : undefined,
      permanent: typeof d.permanent === 'boolean' ? d.permanent : undefined,
    }),
    verdict: DANGER,
  },
  'job.attention': {
    scope: 'run',
    action: 'attention',
    facts: (d, m) => ({ pipeline: str(d, 'pipeline'), error: errorOf(m) }),
    verdict: DANGER,
  },
  'job.rescheduled': {
    scope: 'run',
    action: 'rescheduled',
    facts: (d, m) => ({ pipeline: str(d, 'pipeline'), delayMs: num(d, 'delayMs'), reason: errorOf(m) }),
  },
  'jobs.reclaimed': { scope: 'jobs', action: 'reclaimed', facts: (d) => ({ counts: { count: num(d, 'count') ?? 0 } }) },
  'events.pruned': { scope: 'events', action: 'pruned', facts: (d) => ({ counts: { count: num(d, 'count') ?? 0 } }) },
  'traces.pruned': { scope: 'traces', action: 'pruned', facts: (d) => ({ counts: { count: num(d, 'count') ?? 0 } }) },
  'events.prune-failed': failure('events', 'prune-failed'),
  'llm.effort-ignored': plain('llm', 'effort-ignored'),

  // --- acquire ---
  'acquire.search': { scope: 'acquire', action: 'search', facts: (d) => ({ ...common(d), indexers: strings(d, 'indexers') }) },
  'acquire.filter': { scope: 'acquire', action: 'filter', facts: (d) => ({ ...common(d), reasons: strings(d, 'reasons') }) },
  'acquire.candidates-capped': {
    scope: 'acquire',
    action: 'filter',
    facts: (d) => ({ ...common(d), counts: { capped: num(d, 'droppedCount') ?? 0 } }),
    verdict: WARN,
  },
  'acquire.pick': { scope: 'acquire', action: 'pick', facts: common },
  'acquire.grabbed': {
    scope: 'acquire',
    action: 'pick',
    facts: (d, m) => ({
      ...common(d),
      release: { title: quoted(m), guid: str(d, 'guid'), group: str(d, 'releaseGroup') },
      counts: { grabbed: 1 },
    }),
    verdict: SUCCESS,
  },
  'acquire.no-candidates': { scope: 'acquire', action: 'no-candidates', facts: common, verdict: WARN },
  'acquire.none-viable': {
    scope: 'acquire',
    action: 'none-viable',
    facts: (d) => ({ ...common(d), reason: str(d, 'reasoning') }),
    verdict: WARN,
  },
  'acquire.already-satisfied': { scope: 'acquire', action: 'already-satisfied', facts: common, verdict: SUCCESS },
  'acquire.skip-unaired': plain('acquire', 'skip-unaired'),
  'acquire.skip-already-grabbed': plain('acquire', 'skip-already-grabbed'),
  'acquire.pin-failed': failure('acquire', 'pin-failed'),
  'acquire.season-search-failed': failure('acquire', 'season-search-failed'),
  'acquire.record-failed': failure('acquire', 'record-failed'),

  // --- ingest ---
  'ingest.placed': { scope: 'ingest', action: 'placed', facts: fileFacts, verdict: SUCCESS },
  'ingest.rescued': {
    scope: 'ingest',
    action: 'rescued',
    facts: (d) => ({ ...common(d), counts: { files: arrayLength(d, 'files') ?? 0 } }),
    verdict: SUCCESS,
  },
  'ingest.rescue-proposed': {
    scope: 'ingest',
    action: 'rescue-proposed',
    facts: (d) => ({ ...common(d), reason: str(d, 'reasoning'), counts: { files: num(d, 'fileCount') ?? arrayLength(d, 'files') ?? 0 } }),
    verdict: WARN,
  },
  'ingest.rescue-skipped': plain('ingest', 'rescue-skipped'),
  'ingest.rescue-deferred': plain('ingest', 'rescue-deferred'),
  'ingest.rescue-failed': failure('ingest', 'rescue-failed'),
  'ingest.deferred': plain('ingest', 'deferred'),
  'ingest.unmatched': { scope: 'ingest', action: 'unmatched', facts: fileFacts, verdict: WARN },
  'ingest.place-failed': failure('ingest', 'place-failed'),
  'ingest.skipped-extra': { scope: 'ingest', action: 'skipped-extra', facts: fileFacts },
  'ingest.skipped-foreign': { scope: 'ingest', action: 'skipped-foreign', facts: fileFacts, verdict: WARN },
  'ingest.skipped-collision': { scope: 'ingest', action: 'skipped-collision', facts: fileFacts, verdict: WARN },
  'ingest.settle-timeout': plain('ingest', 'settle-timeout', WARN),
  'ingest.source-fallback': plain('ingest', 'source-fallback'),
  'ingest.source-fallback-miss': plain('ingest', 'source-fallback-miss', WARN),
  'ingest.source-fallback-skipped': plain('ingest', 'source-fallback-skipped'),
  'ingest.stale-cleaned': plain('ingest', 'stale-cleaned'),
  'ingest.stale-clean-failed': failure('ingest', 'stale-clean-failed'),

  // --- subtitle ---
  'subtitle.transcript': {
    scope: 'subtitle',
    // A legacy row's action lives on `data.entry`, and failing that in the message head.
    action: 'step',
    facts: (d, m) => ({
      site: str(d, 'site') ?? parseComposedMessage(m)?.site,
      tier: entryField(d, 'tier'),
      detail: entryField(d, 'detail') ?? detailOf(m),
    }),
  },
  'agent.stop': {
    scope: 'subtitle',
    action: 'visit',
    facts: (d, m) => ({
      site: str(d, 'site') ?? parseComposedMessage(m)?.site,
      tier: str(d, 'tier'),
      round: num(d, 'round'),
      maxRounds: num(d, 'maxRounds'),
      steps: num(d, 'steps'),
      callsite: str(d, 'callsite'),
      url: str(d, 'url'),
      stop: stopKind(d),
      reason: detailOf(m),
    }),
    verdict: (d) => (stopKind(d) === 'done' ? 'success' : stopKind(d) === 'skipped' ? 'neutral' : 'warning'),
  },
  // The pre-`agent.stop` spelling of a visit verdict — a handful of rows exist in the
  // wild (job #76's "gave up" rounds), carrying the same site/round/tier/steps shape.
  'subtitle.search-round': {
    scope: 'subtitle',
    action: 'visit',
    facts: (d, m) => ({
      site: str(d, 'site') ?? parseComposedMessage(m)?.site,
      tier: str(d, 'tier'),
      round: num(d, 'round'),
      steps: num(d, 'steps'),
      outcome: str(d, 'outcome'),
      reason: str(d, 'reason') ?? detailOf(m),
    }),
    verdict: WARN,
  },
  'subtitle.site-failed': { scope: 'subtitle', action: 'site-failed', facts: (d, m) => ({ ...common(d), error: errorOf(m) }), verdict: DANGER },
  'subtitle.site-exhausted': { scope: 'subtitle', action: 'site-exhausted', facts: common, verdict: WARN },
  'subtitle.site-cooldown': { scope: 'subtitle', action: 'visit', facts: (d) => ({ ...common(d), stop: 'skipped', outcome: 'cooldown' }) },
  'subtitle.site-unusable': {
    scope: 'subtitle',
    action: 'site-unusable',
    facts: (d) => ({ site: str(d, 'targetId'), reason: str(d, 'reason'), reasons: strings(d, 'tiersAttempted') }),
    verdict: DANGER,
  },
  'subtitle.missing': { scope: 'subtitle', action: 'missing', facts: common },
  'subtitle.complete': { scope: 'subtitle', action: 'complete', facts: common, verdict: SUCCESS },
  'subtitle.cache-hit': {
    scope: 'subtitle',
    action: 'cache-hit',
    facts: (d) => ({ ...common(d), archive: str(d, 'archive'), counts: { covered: num(d, 'count') ?? 0 } }),
  },
  'subtitle.placed': {
    scope: 'subtitle',
    action: 'placed',
    facts: (d) => ({ file: pathFile(d, 'placedPath'), sourcePath: str(d, 'sourcePath') }),
    verdict: SUCCESS,
  },
  'subtitle.resynced': {
    scope: 'subtitle',
    action: 'resynced',
    facts: (d) => ({ file: pathFile(d, 'placedPath'), sourcePath: str(d, 'sourcePath'), counts: { offsetMs: num(d, 'offsetMs') ?? 0 } }),
    verdict: SUCCESS,
  },
  'subtitle.quarantined': {
    scope: 'subtitle',
    action: 'quarantined',
    facts: (d) => ({ file: pathFile(d, 'quarantinedPath'), sourcePath: str(d, 'sourcePath') ?? str(d, 'sourceFile') }),
    verdict: WARN,
  },
  'subtitle.skipped-collision': {
    scope: 'subtitle',
    action: 'skipped-collision',
    facts: (d) => ({ file: pathFile(d, 'targetPath'), sourcePath: str(d, 'sourcePath') }),
    verdict: WARN,
  },
  'subtitle.skipped-foreign': {
    scope: 'subtitle',
    action: 'skipped-foreign',
    facts: (d) => ({ file: pathFile(d, 'targetPath'), sourcePath: str(d, 'sourcePath') }),
    verdict: WARN,
  },
  'subtitle.unresolved': {
    scope: 'subtitle',
    action: 'unresolved',
    facts: (d) => ({ ...common(d), ...episodes(d) }),
    verdict: WARN,
  },
  'subtitle.pack-empty': { scope: 'subtitle', action: 'pack-empty', facts: (d, m) => ({ ...common(d), url: str(d, 'url'), error: errorOf(m) }), verdict: WARN },
  'subtitle.duplicate-pack': { scope: 'subtitle', action: 'duplicate-pack', facts: (d) => ({ ...common(d), url: str(d, 'url'), archive: str(d, 'archive') }) },
  'subtitle.filter': { scope: 'subtitle', action: 'filter', facts: common },
  'subtitle.candidates-capped': { scope: 'subtitle', action: 'filter', facts: common, verdict: WARN },
  'subtitle.search-scoped': { scope: 'subtitle', action: 'search-scoped', facts: common },
  'subtitle.settle-timeout': plain('subtitle', 'settle-timeout', WARN),
  'subtitle.videos-absent': plain('subtitle', 'videos-absent', WARN),
  'subtitle.videos-unreachable': plain('subtitle', 'videos-unreachable', WARN),
  'subtitle.tool-missing': plain('subtitle', 'tool-missing', WARN),
  'subtitle.knowledge-updated': {
    scope: 'subtitle',
    action: 'knowledge-updated',
    facts: (d) => ({ ...common(d), counts: { applied: num(d, 'applied') ?? 0, dropped: num(d, 'droppedCount') ?? 0 } }),
  },
  'subtitle.knowledge-refused': { scope: 'subtitle', action: 'knowledge-refused', facts: (d) => ({ ...common(d), reasons: strings(d, 'patterns'), detail: str(d, 'excerpt') }), verdict: DANGER },
  'subtitle.knowledge-unreadable': failure('subtitle', 'knowledge-unreadable'),
  'subtitle.knowledge-failed': failure('subtitle', 'knowledge-failed'),
  'subtitle.knowledge-skipped': plain('subtitle', 'knowledge-skipped'),
  'subtitle.knowledge-dropped': plain('subtitle', 'knowledge-dropped', WARN),
  'subtitle.knowledge-overflow': plain('subtitle', 'knowledge-overflow', WARN),
  'subtitle.knowledge-conflict': plain('subtitle', 'knowledge-conflict', WARN),
  // `${scope}.mount-missing` in src/pipelines/mounts.ts — one kind per pipeline.
  'subtitle.mount-missing': plain('subtitle', 'mount-missing', DANGER),
  'ingest.mount-missing': plain('ingest', 'mount-missing', DANGER),
  'acquire.mount-missing': plain('acquire', 'mount-missing', DANGER),

  // --- reconcile / managed / webhook registration ---
  'reconcile.bootstrapped': { scope: 'reconcile', action: 'bootstrapped', facts: (d) => ({ instance: str(d, 'instance'), counts: { items: num(d, 'count') ?? 0 } }) },
  'reconcile.history-bootstrapped': { scope: 'reconcile', action: 'history-bootstrapped', facts: (d) => ({ instance: str(d, 'instance'), counts: { cursor: num(d, 'cursor') ?? 0 } }) },
  'reconcile.history-cursor-reset': { scope: 'reconcile', action: 'history-cursor-reset', facts: (d) => ({ instance: str(d, 'instance'), counts: { cursor: num(d, 'cursor') ?? 0 } }), verdict: WARN },
  'reconcile.missed-adds': { scope: 'reconcile', action: 'missed-adds', facts: (d) => ({ instance: str(d, 'instance'), counts: { enqueued: num(d, 'count') ?? 0, alreadyHandled: num(d, 'alreadyHandled') ?? 0 } }) },
  'reconcile.missed-imports': { scope: 'reconcile', action: 'missed-imports', facts: (d) => ({ instance: str(d, 'instance'), counts: { enqueued: arrayLength(d, 'targets') ?? 0 } }) },
  'reconcile.gc': plain('reconcile', 'gc'),
  'reconcile.gc-skip-profile': plain('reconcile', 'gc-skip-profile'),
  'reconcile.gc-skip-tag': plain('reconcile', 'gc-skip-tag'),
  'reconcile.gc-skip-tag-foreign-profile': plain('reconcile', 'gc-skip-tag-foreign-profile'),
  'reconcile.gc-failed': failure('reconcile', 'gc-failed'),
  'reconcile.gc-failed-global': failure('reconcile', 'gc-failed-global'),
  'reconcile.gc-row-failed': failure('reconcile', 'gc-row-failed'),
  'reconcile.failed': failure('reconcile', 'failed'),
  'reconcile.crashed': failure('reconcile', 'crashed'),
  'managed.deleted': plain('managed', 'deleted'),
  'managed.delete-skipped': plain('managed', 'delete-skipped'),
  'managed.delete-failed': failure('managed', 'delete-failed'),
  'managed.sync-failed': failure('managed', 'sync-failed'),
  'webhook.registered': { scope: 'webhook', action: 'registered', facts: (d) => ({ instance: str(d, 'instance'), url: str(d, 'url') }), verdict: SUCCESS },
  'webhook.register-failed': failure('webhook', 'register-failed'),
  'webhook.register-crashed': failure('webhook', 'register-crashed'),
  'webhook.recreate-failed': failure('webhook', 'recreate-failed'),

  // --- operator actions ---
  'attention.dismissed': { scope: 'attention', action: 'dismissed', facts: (d) => ({ reason: str(d, 'kind') }) },
  'attention.retried': { scope: 'attention', action: 'retried', facts: (d) => ({ reason: str(d, 'kind'), pipeline: str(d, 'pipeline') }) },
  'attention.repicked': { scope: 'attention', action: 'repicked', facts: (d) => ({ reason: str(d, 'kind'), pipeline: str(d, 'pipeline') }) },
  'attention.accepted': { scope: 'attention', action: 'accepted', facts: (d) => ({ reason: str(d, 'kind'), pipeline: str(d, 'pipeline') }) },
};

/** A file-shaped legacy payload: the arr's own `path`, plus whatever quality/group came
 * with it. Every ingest kind wrote some subset of these. */
function fileFacts(d: Record<string, unknown>): EventFacts {
  const path = str(d, 'path') ?? str(d, 'placedPath') ?? str(d, 'targetPath');
  return {
    ...common(d),
    ...(path === undefined ? {} : { file: { path, group: str(d, 'releaseGroup') } }),
    sourcePath: str(d, 'sourcePath'),
  };
}

function pathFile(d: Record<string, unknown>, key: string): EventFacts['file'] {
  const path = str(d, key);
  return path === undefined ? undefined : { path };
}

/** `data.stop` was the whole `StopReason` object; the envelope keeps only its `kind`. */
function stopKind(d: Record<string, unknown>): string | undefined {
  const stop = d.stop;
  if (typeof stop === 'string') return stop;
  if (typeof stop === 'object' && stop !== null) {
    const kind = (stop as Record<string, unknown>).kind;
    if (typeof kind === 'string') return kind;
  }
  return undefined;
}

function entryField(d: Record<string, unknown>, key: string): string | undefined {
  const entry = d.entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const v = (entry as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** The first `"quoted"` run in a message — how the grab kinds named their release. */
function quoted(message: string): string | undefined {
  return /"([^"]+)"/.exec(message)?.[1];
}

// --- the migration itself ---------------------------------------------------------------

/** The protocol keys a migrated row keeps outside the envelope: the attention target
 * triple, its dedupe discriminator, and any re-executable accept payload. Everything else
 * either mapped into facts or is dropped. */
function carried(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['instance', 'targetKind', 'targetId', 'dedupeKey']) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  const accept = legacyAccept(data);
  if (accept) out.accept = accept;
  // `attention.retried`/`repicked` route on `data.pipeline`, and the accept route reads
  // `data.instance` — both stay verbatim.
  if (typeof data.pipeline === 'string') out.pipeline = data.pipeline;
  if (typeof data.reasoning === 'string') out.reasoning = data.reasoning;
  return out;
}

/** Old rows put the accept payload's discriminator at `data.action`, which is the
 * envelope's field now. Anything that parses as one of the three known proposals moves
 * under `data.accept` verbatim so the accept route keeps working. */
function legacyAccept(data: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof data.accept === 'object' && data.accept !== null) return data.accept as Record<string, unknown>;
  const action = data.action;
  const keys = ACCEPT_KEYS[action as string];
  if (keys === undefined) return null;
  const out: Record<string, unknown> = { action };
  for (const key of keys) if (data[key] !== undefined) out[key] = data[key];
  return out;
}

/** Exactly the fields each accept schema reads (`src/server/app.ts`) — copying the whole
 * old `data` would drag the target triple in alongside them for no reason. */
const ACCEPT_KEYS: Record<string, readonly string[]> = {
  'force-grab': ['instance', 'guid', 'indexerId', 'pickedTitle', 'releaseGroup', 'seasonNumber'],
  'disable-site': ['baseUrl', 'reason'],
  'bundle-import': ['instance', 'files'],
};

function envelopeFor(rule: Rule, row: Row, data: Record<string, unknown>): EventEnvelope & Record<string, unknown> {
  return eventEnvelope(
    {
      scope: rule.scope,
      action: rule.action,
      facts: rule.facts?.(data, row.message),
      ...(rule.verdict ? { verdict: { tone: rule.verdict(data) } } : {}),
    },
    carried(data),
  );
}

function bump(tally: Record<string, number>, kind: string): void {
  tally[kind] = (tally[kind] ?? 0) + 1;
}

/**
 * Rewrites (or deletes) every row in one transaction and reports what it did.
 *
 * `dryRun` does the whole pass — every parse, every rule lookup — and rolls back, so the
 * report is exactly what a real run would produce. That is the only safe way to find out
 * how many rows a rule table is about to delete.
 */
export function migrateEventEnvelopes(db: Database.Database, opts: { dryRun?: boolean } = {}): MigrationReport {
  const report: MigrationReport = { migrated: {}, deleted: {}, skipped: {}, total: 0 };
  const rows = db.prepare('SELECT id, kind, message, data FROM events ORDER BY id').all() as Row[];
  const update = db.prepare('UPDATE events SET data = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM events WHERE id = ?');

  const run = db.transaction(() => {
    for (const row of rows) {
      report.total += 1;
      const data = parseData(row.data);
      if (readEnvelope(data) !== null) {
        bump(report.skipped, row.kind);
        continue;
      }
      const rule = RULES[row.kind];
      if (rule === undefined) {
        bump(report.deleted, row.kind);
        remove.run(row.id);
        continue;
      }
      bump(report.migrated, row.kind);
      update.run(JSON.stringify(envelopeFor(rule, row, data)), row.id);
    }
    if (opts.dryRun === true) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    // A dry run rolls the whole transaction back through the one exception better-sqlite3
    // gives us for it. Anything else is a real failure and must not look like success.
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

class DryRun extends Error {}

/** A `data` column that is not an object at all (never written by this codebase, but the
 * column is free text) reads as an empty payload, so its rule still applies rather than
 * the row being deleted for a reason its `kind` had nothing to do with. */
function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Every kind the table knows how to migrate — exported so a test can assert the rule set
 * covers every kind the code can actually emit. */
export const MIGRATABLE_KINDS: readonly string[] = Object.keys(RULES);
