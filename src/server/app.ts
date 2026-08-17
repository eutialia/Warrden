import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  KNOWLEDGE_CHAR_CAP,
  KnowledgeConflictError,
  agentCharCount,
  defaultSeedsDir,
  loadKnowledgeWithVersion,
  parseKnowledge,
  renderKnowledge,
  saveKnowledge,
  type SiteKnowledge,
} from '../agent/siteKnowledge.js';
import { registerWebhooksInBackground } from '../arr/register.js';
import type { ArrApi, ManualImportFile } from '../arr/types.js';
import { handleWebhook } from '../arr/webhooks.js';
import { ConfigSchema, SECRET_PLACEHOLDER, type Config } from '../config/schema.js';
import { siteKey } from '../config/siteLabel.js';
import { saveConfig } from '../config/store.js';
import { applyConfig, type AppContext } from '../context.js';
import { AcquireRecords } from '../db/acquireRecords.js';
import { AttentionItems, type AttentionStatus } from '../db/attention.js';
import { ManagedObjects } from '../db/managedObjects.js';
import { Overview } from '../db/overview.js';
import { PlacedFiles } from '../db/placedFiles.js';
import { SiteProfiles, type SiteProfileRow, type UpdateSiteProfileInput } from '../db/siteProfiles.js';
import { SubtitleRuns } from '../db/subtitleRuns.js';
import { TraceEntries } from '../db/traceEntries.js';
import type { TargetKind } from '../jobs/queue.js';
import { deleteManagedObject } from '../managed/deleteObject.js';
import { NOOP_TRACER, traceTrigger } from '../trace/tracer.js';
import { cachedStorage, probeStorage } from './storageHealth.js';
import { fallbackTargetLabel, jobTitleKey, resolveJobTitle, resolveJobTitles } from './titles.js';

const DEFAULT_EVENTS_LIMIT = 100;
const DEFAULT_JOBS_LIMIT = 50;
const MAX_LIMIT = 1000;

// Default when `ctx.webDistDir` isn't given: resolved relative to this module's own
// location (not process.cwd()), same convention as `src/db/db.ts`'s MIGRATIONS_DIR — works
// the same whether running from `src/` (tsx) or `dist/` (compiled), since both sit one
// level under the repo root at `server/`.
const DEFAULT_WEB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

// `?limit=` (empty) and `?limit=abc` (non-numeric) both fall back to `fallback` rather
// than reaching better-sqlite3, which rejects NaN/negative bind params outright.
function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_LIMIT);
}

// `?level=` (empty) means "no filter", same as omitting the param entirely.
function parseLevel(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

type LlmKeys = Config['llm']['keys'];

/** Thrown by `restoreArrApiKey` when an incoming arr entry's `apiKey` is still the
 * `SECRET_PLACEHOLDER` sentinel but no stored arr shares its `name` — there's nothing to
 * restore it from, and the sentinel itself must never reach `saveConfig`. Caught in the
 * `PUT /api/config` handler and turned into a 400 (`ConfigSchema`'s own sentinel-rejecting
 * `superRefine` is only the second line of defense, for anything that reaches it by some
 * other path). */
class ConfigMergeError extends Error {}

/** Replaces every *set* `llm.keys` value, and every `arrs[].apiKey` (always set — it's
 * required by `ArrInstanceSchema`), with the `SECRET_PLACEHOLDER` sentinel for
 * `GET /api/config`. An unset llm key stays absent rather than becoming a fake sentinel,
 * so the dashboard can tell "never configured" apart from "configured, just not shown". */
function redactConfig(config: Config): Config {
  const redactedKeys = Object.fromEntries(
    Object.entries(config.llm.keys).map(([key, value]) => [key, value === undefined ? value : SECRET_PLACEHOLDER]),
  ) as LlmKeys;
  const redactedArrs = config.arrs.map((arr) => ({ ...arr, apiKey: SECRET_PLACEHOLDER }));
  return { ...config, arrs: redactedArrs, llm: { ...config.llm, keys: redactedKeys } };
}

/**
 * Undoes `redactConfig` on the way in, for both secrets it redacts:
 *
 * - `llm.keys`: any value still equal to the `•••` sentinel (the dashboard round-tripped
 *   it unchanged) is swapped back for the real stored secret. A key set to anything else
 *   (a new value, or dropped from the object) passes through as the caller wrote it. The
 *   whole `llm.keys` object being missing — not just individual keys inside it — is
 *   treated the same as every key being the sentinel: a PUT that doesn't mention keys at
 *   all (e.g. a client only patching an unrelated field) must not fall through to the
 *   schema's `{}` default and silently erase every stored secret.
 * - `arrs[].apiKey`: same sentinel swap, matched by `name` against the stored `arrs`
 *   list — an arr entry keeps its stored key if its `apiKey` is still the sentinel and
 *   its `name` still matches a stored entry; a brand-new or rotated key passes through
 *   unchanged. Unlike `llm.keys`, a missing `arrs` array or a missing `apiKey` on an
 *   entry is *not* given the same treatment: an absent `arrs` legitimately means "remove
 *   every instance" (the schema default), and `apiKey` is a required field, so dropping
 *   it is correctly a 400, not a silent no-op. A sentinel `apiKey` whose `name` *doesn't*
 *   match anything stored (a rename, or a new entry that somehow arrives pre-redacted)
 *   throws `ConfigMergeError` rather than saving the literal sentinel as a credential —
 *   there is nothing to restore it from.
 *
 * @throws ConfigMergeError if an arr entry's `apiKey` is the sentinel with no stored
 * match to restore it from.
 */
function restoreSecrets(body: unknown, current: Config): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const record = body as Record<string, unknown>;

  const llmValue = record.llm;
  const llmRecord: Record<string, unknown> =
    typeof llmValue === 'object' && llmValue !== null ? { ...(llmValue as Record<string, unknown>) } : {};

  const keysValue = llmRecord.keys;
  const restoredKeys: Record<string, unknown> =
    typeof keysValue === 'object' && keysValue !== null
      ? Object.fromEntries(
          Object.entries(keysValue as Record<string, unknown>).map(([key, value]) => [
            key,
            value === SECRET_PLACEHOLDER ? current.llm.keys[key as keyof LlmKeys] : value,
          ]),
        )
      : current.llm.keys; // `llm.keys` omitted entirely -> every stored secret survives as-is

  const arrsValue = record.arrs;
  const restoredArrs = Array.isArray(arrsValue) ? arrsValue.map((entry) => restoreArrApiKey(entry, current)) : arrsValue;

  return { ...record, arrs: restoredArrs, llm: { ...llmRecord, keys: restoredKeys } };
}

function restoreArrApiKey(entry: unknown, current: Config): unknown {
  if (typeof entry !== 'object' || entry === null) return entry;
  const arrRecord = entry as Record<string, unknown>;
  if (arrRecord.apiKey !== SECRET_PLACEHOLDER) return entry;
  const name = arrRecord.name;
  const stored = typeof name === 'string' ? current.arrs.find((a) => a.name === name) : undefined;
  if (!stored) {
    const label = typeof name === 'string' && name.length > 0 ? name : '(unnamed)';
    throw new ConfigMergeError(`apiKey required for new or renamed instance '${label}'`);
  }
  return { ...arrRecord, apiKey: stored.apiKey };
}

// 2000 is a generous ceiling for a freeform operator note, not a real limit anyone should
// hit — it exists so a runaway/pasted-in-error hint can't inflate the LLM prompt (and its
// token cost) unboundedly.
const HINT_MAX_LENGTH = 2000;

const AcquireBodySchema = z.object({
  arrInstance: z.string().min(1),
  targetKind: z.enum(['series', 'movie']),
  targetId: z.number().int(),
  title: z.string().optional(),
  hint: z.string().max(HINT_MAX_LENGTH).optional(),
});

const RepickBodySchema = z.object({ hint: z.string().max(HINT_MAX_LENGTH).optional() });

// Dashboard edits to a site profile — every field optional so a partial PUT only touches
// what the client sent. `lastWorkingTier` is the full AccessTier union or explicit null
// (clears the "known-good" tier), `searchUrlPatterns` capped at 5 non-empty entries.
// `failCount` is the accessible reset seam: PUT `{ failCount: 0 }` clears the
// escalation/backoff bookkeeping. Setting `disabledAt` is not writable here — a site is
// only ever disabled through the evidence-gated attention accept route below. Clearing it
// (`disabledAt: null`) is: the Sites page's "re-enable" button, an operator override for a
// site the evidence-gated path shut off and the operator disagrees with, distinct from
// dismissing an still-open attention item (which clears the same flag on its own path,
// before a disable was ever accepted).
const SiteProfileUpdateSchema = z.object({
  /** Which site to write to — its base URL, the only identity a site has. */
  baseUrl: z.url(),
  lastWorkingTier: z.enum(['curl', 'chromium', 'camoufox', 'remote']).nullable().optional(),
  searchUrlPatterns: z.array(z.string().min(1)).max(5).optional(),
  failCount: z.number().int().min(0).optional(),
  // Explicit null clears the timestamp (used with failCount: 0 by "reset failures").
  lastFailureAt: z.number().int().nullable().optional(),
  // Only `null` (re-enable) validates; any other value is rejected by the literal, so this
  // route can never be used to set the timestamp that disables a site.
  disabledAt: z.literal(null).optional(),
});

// What `runIngestJob`'s rescue stage (`src/pipelines/ingest/run.ts`) actually puts in an
// `ingest.rescue-proposed` attention item's `data` — the accept endpoint below only ever
// re-executes exactly that shape, never an arbitrary command a client could construct.
// Each file needs a non-empty `path` to be a meaningful `ManualImportFile`; `quality`/
// `languages` are typed (but left optional and unvalidated in shape) purely so the parsed
// type overlaps `ManualImportFile` enough for a single narrowing cast below, without this
// route re-deriving/re-validating the whole contract — `runIngestJob` already built these
// values. `.loose()` keeps every other key (`folderName`, `releaseGroup`, ...) round-tripped
// verbatim.
const AcceptFileSchema = z
  .object({
    path: z.string().min(1),
    quality: z.record(z.string(), z.unknown()).optional(),
    languages: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose();
// Exported so tests can run a producer's actual emitted `ingest.rescue-proposed` payload
// straight through this exact schema — a shared fixture guards against DRIFT between the
// two shapes, but only running the real thing through the real schema catches it for sure.
export const AcceptDataSchema = z.object({
  action: z.literal('bundle-import'),
  instance: z.string(),
  files: z.array(AcceptFileSchema).min(1),
});

// What `raiseUnusable` (`src/pipelines/subtitle/run.ts`) puts in a `subtitle.site-unusable`
// attention item's `data` — the accept endpoint below only ever re-executes exactly this
// shape. Server-side input validation, not an LLM-facing schema, so `.min()`/optionality
// conventions elsewhere in the codebase don't apply here.
const DisableSiteSchema = z.object({ action: z.literal('disable-site'), baseUrl: z.url(), reason: z.string() });

/**
 * Reads the *current* config directly off `ctx` rather than a value captured once at
 * `createApp` time — every route below shares this so a `PUT /api/config` (which
 * reassigns `ctx.config` in place) is visible to all of them on their very next request,
 * not just to `/api/config` itself. Only ever called from routes gated on `ctx.config`
 * at mount time, and the only mutation afterward is a successful PUT's re-validated
 * `Config`, so `ctx.config` can never actually be unset by the time this runs — the
 * throw documents that invariant instead of laundering it through an `as Config` cast.
 */
function requireConfig(ctx: Partial<AppContext>): Config {
  if (!ctx.config) throw new Error('config unexpectedly unset after being gated on at startup');
  return ctx.config;
}

/** The live `ctx.clients`, read per request for the same reason `requireConfig` is: a
 * config save swaps BOTH (`applyConfig`), so a Map captured when the routes were mounted
 * would keep answering for arr instances the operator has since renamed or removed. */
function requireClients(ctx: Partial<AppContext>): Map<string, ArrApi> {
  if (!ctx.clients) throw new Error('clients unexpectedly unset after being gated on at startup');
  return ctx.clients;
}

export function createApp(ctx: Partial<AppContext>): Hono {
  const app = new Hono();

  // Blocks a cross-origin browser POST/PUT/etc. that dodges CORS preflight by using a
  // "simple" content type (`text/plain`, form-urlencoded, multipart, or no content-type
  // header at all — hono/csrf treats a missing header the same as `text/plain`) — the
  // classic CSRF vector against a JSON API that parses the body regardless of its declared
  // type (see `c.req.json()` below, used everywhere). What actually exempts a
  // server-to-server call like Sonarr/Radarr's own webhook POST is its `application/json`
  // content-type, not the absence of an Origin header: hono/csrf only skips the check for
  // a non-"simple" content-type, so a bare origin-less POST sent with no content-type (or
  // a form one) is still blocked, same as a browser's would be.
  app.use('/api/*', csrf());
  app.use('/webhooks/*', csrf());

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (ctx.events) {
    const events = ctx.events;

    app.get('/api/events', (c) => {
      const limit = parseLimit(c.req.query('limit'), DEFAULT_EVENTS_LIMIT);
      const level = parseLevel(c.req.query('level'));
      return c.json(events.list({ limit, level }));
    });

    app.get('/api/events/stream', (c) => {
      return streamSSE(c, async (stream) => {
        const unsubscribe = events.subscribe((e) => {
          void stream.writeSSE({ data: JSON.stringify(e) });
        });
        const aborted = new Promise<void>((resolve) => {
          // Both hooked: the request signal covers the common disconnect path, and
          // stream.onAbort (Hono's adapter-independent hook) also covers the readable
          // being cancelled directly, which doesn't always fire the request signal.
          c.req.raw.signal.addEventListener('abort', () => resolve());
          stream.onAbort(() => resolve());
        });
        try {
          await aborted;
        } finally {
          unsubscribe();
        }
      });
    });
  }

  if (ctx.queue && ctx.events && ctx.config && ctx.clients) {
    const queue = ctx.queue;
    const events = ctx.events;

    app.post('/webhooks/:instance', async (c) => {
      const instance = c.req.param('instance');
      const payload: unknown = await c.req.json().catch(() => undefined);
      // `requireConfig(ctx)` (not a value snapshotted here at mount time) so a config
      // reloaded via `PUT /api/config` is picked up starting with the very next webhook.
      const webhookCtx = { queue, events, config: requireConfig(ctx), clients: requireClients(ctx), trace: ctx.trace ?? NOOP_TRACER };
      // Always 200: the arrs retry non-2xx webhook deliveries, which we don't want.
      return c.json(handleWebhook(webhookCtx, instance, payload));
    });
  }

  if (ctx.queue && ctx.db) {
    const queue = ctx.queue;
    const db = ctx.db;
    const acquireRecords = new AcquireRecords(ctx.db);
    const placedFiles = new PlacedFiles(ctx.db);

    // The dashboard-facing "did this job actually grab anything" status: `null` for a
    // non-acquire pipeline, or an acquire job with no record yet (still pending/running,
    // or it crashed before recording). See `AcquireRecords.outcomeForJob` for why this is
    // an aggregate over every record the job's own run produced, not just the latest one.
    // A job is "terminal" once its own run has fully finished (done or failed) — its
    // record window is closed at that point, so it can be bounded exactly rather than
    // left open to whatever a later re-pick writes for the same target.
    function isTerminal(job: { status: string }): boolean {
      return job.status === 'done' || job.status === 'failed';
    }

    function acquireOutcome(job: {
      pipeline: string;
      arr_instance: string;
      target_kind: TargetKind;
      target_id: number;
      created_at: number;
      status: string;
      updated_at: number;
    }) {
      if (job.pipeline !== 'acquire') return null;
      // Terminal jobs are bounded to their own run window so a later re-pick's records
      // can't retroactively change this job's badge; live jobs stay unbounded above.
      return acquireRecords.outcomeForJob(
        job.arr_instance,
        job.target_kind,
        job.target_id,
        job.created_at,
        isTerminal(job) ? job.updated_at : undefined,
      );
    }

    app.get('/api/jobs', async (c) => {
      const limit = parseLimit(c.req.query('limit'), DEFAULT_JOBS_LIMIT);
      const jobs = queue.list({ limit });
      const clients = ctx.clients ?? new Map();
      const titles = await resolveJobTitles(jobs, clients);
      return c.json(
        jobs.map((job) => ({
          ...job,
          acquireOutcome: acquireOutcome(job),
          targetTitle:
            titles.get(jobTitleKey(job.arr_instance, job.target_kind, job.target_id)) ??
            fallbackTargetLabel(job.target_kind, job.target_id),
        })),
      );
    });

    app.get('/api/jobs/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const job = Number.isInteger(id) ? queue.get(id) : null;
      if (!job) return c.json({ error: 'job not found' }, 404);
      // Bounded to this job's own run window — exactly like `acquireOutcome` above —
      // rather than the target's unbounded latest record, which could belong to a
      // different job entirely (an earlier or later re-pick of the same target). Within
      // that window, `listByTarget` orders newest first, so [0] is this run's latest
      // outcome, shown for its detail (reasoning, candidates).
      const acquireRecord =
        acquireRecords.listByTarget(job.arr_instance, job.target_kind, job.target_id, {
          since: job.created_at,
          until: isTerminal(job) ? job.updated_at : undefined,
        })[0] ?? null;
      const targetTitle = await resolveJobTitle({
        client: ctx.clients?.get(job.arr_instance),
        arrInstance: job.arr_instance,
        targetKind: job.target_kind,
        targetId: job.target_id,
        payload: job.payload,
      });
      return c.json({
        job: { ...job, targetTitle, acquireOutcome: acquireOutcome(job) },
        acquireRecord,
        acquireOutcome: acquireOutcome(job),
        placedFiles: placedFiles.listByJob(job.id),
        // This job's own subtitle site-search runs, transcript included — the dashboard's
        // JobDetail "Subtitle runs" card renders these as a chronological step list.
        subtitleRuns: new SubtitleRuns(db).listByJob(job.id),
      });
    });

    const traces = new TraceEntries(db);

    app.get('/api/traces', (c) => {
      const summaries = traces.summaries(100);
      // One lookup for the whole window instead of a `queue.get` per summary: the list is
      // refetched on every trace.appended, so 100 point queries per tick add up.
      const jobs = new Map(queue.getMany(summaries.map((s) => s.job_id)).map((j) => [j.id, j]));
      const out = summaries.map((s) => {
        const job = jobs.get(s.job_id);
        // A trace whose job row is gone is still viewable, so it stays in the list with a
        // synthesized header rather than silently shrinking the window below its size.
        const title = typeof job?.payload.title === 'string' ? job.payload.title : job ? `${job.target_kind} #${job.target_id}` : `job #${s.job_id}`;
        return {
          jobId: s.job_id,
          pipeline: job?.pipeline ?? 'unknown',
          targetTitle: title,
          jobStatus: job?.status ?? 'unknown',
          // The target triple, so the debug view can link a trace to the other phases'
          // traces for the SAME target (acquire -> ingest -> subtitle) client-side. Null
          // for a vanished job: it can be linked to nothing.
          arrInstance: job?.arr_instance ?? null,
          targetKind: job?.target_kind ?? null,
          targetId: job?.target_id ?? null,
          entryCount: s.entry_count,
          firstTs: s.first_ts,
          lastTs: s.last_ts,
        };
      });
      return c.json({ traces: out });
    });

    app.get('/api/traces/:jobId/entries/:seq', (c) => {
      const jobId = Number(c.req.param('jobId'));
      const seq = Number(c.req.param('seq'));
      const row = Number.isInteger(jobId) && Number.isInteger(seq) ? traces.get(jobId, seq) : null;
      if (!row) return c.json({ error: 'entry not found' }, 404);
      // Same entry shape the list route returns (raw payload column dropped, hasPayload
      // added), plus the parsed payload this route exists to deliver.
      const { payload, ...rest } = row;
      return c.json({ ...rest, hasPayload: payload !== null, payload: payload === null ? null : (JSON.parse(payload) as unknown) });
    });

    app.get('/api/traces/:jobId', (c) => {
      const jobId = Number(c.req.param('jobId'));
      const rows = Number.isInteger(jobId) ? traces.listByJob(jobId) : [];
      if (rows.length === 0) return c.json({ error: 'trace not found' }, 404);
      // A still-`running` entry on a job that has already finished means the job crashed
      // mid-step; the UI needs `jobTerminal` to render those as interrupted rather than
      // as live work. A vanished job (pruned) counts as terminal: nothing can advance it.
      const job = queue.get(jobId);
      return c.json({
        jobId,
        jobStatus: job?.status ?? null,
        jobTerminal: job ? isTerminal(job) : true,
        entries: rows.map(({ payload, ...rest }) => ({ ...rest, hasPayload: payload !== null })),
      });
    });
  }

  if (ctx.queue && ctx.config && ctx.clients) {
    const queue = ctx.queue;

    app.post('/api/acquire', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = AcquireBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      const { arrInstance, targetKind, targetId, title, hint } = parsed.data;
      // Checked against `ctx.clients` (the runner's actual resolution source), not
      // `config.arrs` — see `handleWebhook`'s matching comment. This is a client mistake (a
      // typo'd or since-removed instance name), so it's a 400 here rather than the webhook
      // route's always-200 "unknown instance" (which exists only because arrs retry non-2xx
      // deliveries; nothing retries a dashboard button click).
      if (!requireClients(ctx).has(arrInstance)) {
        return c.json({ error: `unknown arr instance "${arrInstance}"` }, 400);
      }
      const result = queue.enqueue({
        pipeline: 'acquire',
        arrInstance,
        targetKind,
        targetId,
        payload: { title, source: 'manual', hint },
      });
      traceTrigger(ctx.trace, result, {
        kind: 'trigger.manual',
        summary: `manual acquire (${arrInstance})`,
        payload: () => parsed.data,
      });
      return c.json({ outcome: result.outcome });
    });

    // Mirrors /api/acquire minus title/hint: a subtitle job has no search hint to carry
    // (unlike a release pick), and its target title is re-derived from the arr by
    // runSubtitleJob itself. Payload distinguishes a manual trigger from the automatic
    // ingest follow-on (`source: 'ingest'`) so retry/attention links read correctly.
    const SubtitleBodySchema = z.object({
      arrInstance: z.string().min(1),
      targetKind: z.enum(['series', 'movie']),
      targetId: z.number().int(),
    });

    app.post('/api/subtitle', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = SubtitleBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      const { arrInstance, targetKind, targetId } = parsed.data;
      // Same "checked against ctx.clients, the runner's actual resolution source" rule as
      // /api/acquire — see that route's matching comment.
      if (!requireClients(ctx).has(arrInstance)) {
        return c.json({ error: `unknown arr instance "${arrInstance}"` }, 400);
      }
      const result = queue.enqueue({
        pipeline: 'subtitle',
        arrInstance,
        targetKind,
        targetId,
        payload: { source: 'manual' },
      });
      traceTrigger(ctx.trace, result, {
        kind: 'trigger.manual',
        summary: `manual subtitle (${arrInstance})`,
        payload: () => parsed.data,
      });
      return c.json({ outcome: result.outcome });
    });
  }

  if (ctx.db && ctx.queue && ctx.clients && ctx.events) {
    const db = ctx.db;
    const queue = ctx.queue;
    const events = ctx.events;
    const attentionItems = new AttentionItems(db);
    // Guards `POST /api/attention/:id/accept` against two overlapping requests for the SAME
    // item both passing the open-status check before either has resolved it — without this,
    // both would go on to call `executeManualImport`, importing the same files twice. Keyed
    // by attention item id (not request/connection identity) and scoped to this `createApp()`
    // call rather than the module: each app instance owns its own `AttentionItems` table
    // (tests build many independent ones in the same process), so a module-level Set would
    // leak state across them. An id is always removed in the handler's `finally` the moment
    // its own request finishes (success OR failure), so it never outlives the request that
    // added it.
    const inFlightAccepts = new Set<number>();

    app.get('/api/attention', (c) => {
      const raw = c.req.query('status');
      // Anything other than 'dismissed'/'resolved' (including an unrecognized/garbage
      // value, or the param being absent entirely) falls back to 'open', the default view.
      const status: AttentionStatus = raw === 'dismissed' || raw === 'resolved' ? raw : 'open';
      return c.json({ items: attentionItems.list({ status }) });
    });

    app.post('/api/attention/:id/dismiss', (c) => {
      const id = Number(c.req.param('id'));
      const item = Number.isInteger(id) ? attentionItems.get(id) : null;
      if (!item) return c.json({ error: 'attention item not found' }, 404);
      if (item.status !== 'open') return c.json({ error: 'attention item is not open' }, 409);
      attentionItems.setStatus(id, 'dismissed');
      // Dismissing a site-unusable verdict is "keep trying this site" — clear the disabled
      // flag (never set in the first place unless a PRIOR accept was itself later undone)
      // and failCount, so the site gets a clean retry rather than sitting in cooldown from
      // whatever run raised the verdict.
      if (item.kind === 'subtitle.site-unusable') {
        const disableSite = DisableSiteSchema.safeParse(item.data);
        if (disableSite.success) {
          const profiles = new SiteProfiles(db);
          profiles.upsert({ baseUrl: disableSite.data.baseUrl });
          profiles.update(disableSite.data.baseUrl, { disabledAt: null, disabledReason: '', failCount: 0 });
        }
      }
      events.append({ kind: 'attention.dismissed', message: `Dismissed attention item #${id} (${item.kind})`, data: { id, kind: item.kind } });
      return c.json({ ok: true });
    });

    app.post('/api/attention/:id/retry', (c) => {
      const id = Number(c.req.param('id'));
      const item = Number.isInteger(id) ? attentionItems.get(id) : null;
      if (!item) return c.json({ error: 'attention item not found' }, 404);
      if (item.status !== 'open') return c.json({ error: 'attention item is not open' }, 409);
      if (item.job_id === null) return c.json({ error: 'attention item has no linked job' }, 400);
      const job = queue.get(item.job_id);
      if (!job) return c.json({ error: 'the linked job no longer exists' }, 400);
      // Same "known client" check `/api/acquire` makes — checked against `ctx.clients`
      // (the runner's actual resolution source), not `config.arrs`; see that route's
      // matching comment.
      if (!requireClients(ctx).has(job.arr_instance)) return c.json({ error: `unknown arr instance "${job.arr_instance}"` }, 400);

      // Re-enqueues the JOB'S OWN pipeline (ingest or acquire, whichever it actually
      // was) — unlike repick below, a retry isn't necessarily an acquire re-pick, so it
      // must not hardcode one.
      const retried = queue.enqueue({
        pipeline: job.pipeline,
        targetKind: job.target_kind,
        targetId: job.target_id,
        arrInstance: job.arr_instance,
        payload: { ...job.payload, source: 'retry' },
      });
      traceTrigger(ctx.trace, retried, {
        kind: 'trigger.manual',
        summary: 'attention retry',
        payload: () => ({ attentionId: id, attentionKind: item.kind, fromJobId: job.id, pipeline: job.pipeline }),
      });
      // Marked resolved only once the re-enqueue above actually happened.
      attentionItems.setStatus(id, 'resolved');
      events.append({
        kind: 'attention.retried',
        message: `Retried attention item #${id} (${item.kind}) — re-enqueued job #${job.id}'s "${job.pipeline}" pipeline`,
        data: { id, kind: item.kind, jobId: job.id, pipeline: job.pipeline },
      });
      return c.json({ ok: true });
    });

    app.post('/api/attention/:id/repick', async (c) => {
      const id = Number(c.req.param('id'));
      const item = Number.isInteger(id) ? attentionItems.get(id) : null;
      if (!item) return c.json({ error: 'attention item not found' }, 404);
      if (item.status !== 'open') return c.json({ error: 'attention item is not open' }, 409);
      if (item.job_id === null) return c.json({ error: 'attention item has no linked job' }, 400);
      const job = queue.get(item.job_id);
      if (!job) return c.json({ error: 'the linked job no longer exists' }, 400);
      if (!requireClients(ctx).has(job.arr_instance)) return c.json({ error: `unknown arr instance "${job.arr_instance}"` }, 400);

      const body: unknown = await c.req.json().catch(() => ({}));
      const parsed = RepickBodySchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);

      // Always pipeline 'acquire' (unlike retry above) — a repick is specifically "try the
      // pick again, with a human's hint this time," regardless of which pipeline the
      // linked job itself ran.
      const repicked = queue.enqueue({
        pipeline: 'acquire',
        targetKind: job.target_kind,
        targetId: job.target_id,
        arrInstance: job.arr_instance,
        payload: { ...job.payload, source: 'repick', hint: parsed.data.hint },
      });
      traceTrigger(ctx.trace, repicked, {
        kind: 'trigger.manual',
        summary: 'attention repick',
        payload: () => ({ attentionId: id, attentionKind: item.kind, fromJobId: job.id, hint: parsed.data.hint }),
      });
      attentionItems.setStatus(id, 'resolved');
      events.append({
        kind: 'attention.repicked',
        message: `Repicked attention item #${id} (${item.kind})${parsed.data.hint ? ' with an operator hint' : ''}`,
        data: { id, kind: item.kind, jobId: job.id, hasHint: parsed.data.hint !== undefined },
      });
      return c.json({ ok: true });
    });

    app.post('/api/attention/:id/accept', async (c) => {
      const id = Number(c.req.param('id'));
      const item = Number.isInteger(id) ? attentionItems.get(id) : null;
      if (!item) return c.json({ error: 'attention item not found' }, 404);
      if (item.status !== 'open') return c.json({ error: 'attention item is not open' }, 409);
      // Guards against two overlapping accepts for the SAME item both passing the open
      // check above before either resolves it — see `inFlightAccepts`'s own doc.
      if (inFlightAccepts.has(id)) return c.json({ error: 'attention item accept already in progress' }, 409);
      inFlightAccepts.add(id);

      try {
        // A site-unusable item's accept is a second shape this same route honours, rather
        // than a second route: "resolve this attention item by doing what it proposes" is
        // one action regardless of which proposal it is.
        const disableSite = DisableSiteSchema.safeParse(item.data);
        if (disableSite.success) {
          const { baseUrl, reason } = disableSite.data;
          const profiles = new SiteProfiles(db);
          profiles.upsert({ baseUrl });
          profiles.update(baseUrl, { disabledAt: Date.now(), disabledReason: reason });
          attentionItems.setStatus(id, 'resolved');
          events.append({
            kind: 'attention.accepted',
            message: `Accepted disable-site for attention item #${id} (${item.kind}) — ${baseUrl}`,
            data: { id, kind: item.kind, baseUrl },
          });
          return c.json({ ok: true });
        }

        // Only ever re-executes exactly the `bundle-import` shape `runIngestJob`'s rescue
        // stage itself proposed — validated before the client is even looked up, so a
        // malformed payload never gets as far as touching the arr.
        const parsed = AcceptDataSchema.safeParse(item.data);
        if (!parsed.success) return c.json({ error: 'malformed accept data', issues: parsed.error.issues }, 400);
        const client = requireClients(ctx).get(parsed.data.instance);
        if (!client) return c.json({ error: `unknown arr instance "${parsed.data.instance}"` }, 400);

        await client.executeManualImport(parsed.data.files as ManualImportFile[], 'copy');
        // Marked resolved only once the import actually succeeded — a rejected/thrown
        // import leaves the item open so it can be retried or dismissed instead.
        attentionItems.setStatus(id, 'resolved');
        events.append({
          kind: 'attention.accepted',
          message: `Accepted bundle-import for attention item #${id} (${item.kind}) — ${parsed.data.files.length} file(s)`,
          data: { id, kind: item.kind, fileCount: parsed.data.files.length },
        });
        return c.json({ ok: true });
      } finally {
        inFlightAccepts.delete(id);
      }
    });
  }

  if (ctx.db && ctx.clients && ctx.events && ctx.config) {
    const db = ctx.db;
    const events = ctx.events;
    const managedObjects = new ManagedObjects(db);

    app.get('/api/managed-objects', (c) => {
      return c.json({ objects: managedObjects.list() });
    });

    app.delete('/api/managed-objects/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const row = Number.isInteger(id) ? managedObjects.get(id) : null;
      if (!row) return c.json({ error: 'managed object not found' }, 404);
      // `requireConfig(ctx)` (not a value captured at mount time) so a config reloaded via
      // `PUT /api/config` — e.g. an arr instance's `kind` correcting a typo — is honored on
      // the very next delete, same as every other config-reading route in this file.
      const { deletedInArr } = await deleteManagedObject({ db, clients: requireClients(ctx), events, config: requireConfig(ctx) }, row);
      // The dashboard needs to tell the operator whether the live Sonarr/Radarr object is
      // actually gone, or just this row's own bookkeeping — see `deleteManagedObject`'s doc
      // for the cases where it's the latter (no client configured, a foreign-named live
      // object, a tag still carried by another profile, ...).
      return c.json({ ok: true, deletedInArr });
    });
  }

  if (ctx.db && ctx.config) {
    const db = ctx.db;
    const profiles = new SiteProfiles(db);

    // Defaults for a configured site that has no stored profile row yet — mirrors what a
    // freshly-inserted `site_profiles` row (via `profiles.upsert`) carries, so a brand-new
    // site renders identically whether or not a row has been written. `upsert` seeds
    // base_url; `start` (in the agent) back-fills the rest as it learns, so these only
    // ever show for sites the agent hasn't touched.
    function defaultProfile(baseUrl: string): SiteProfileRow {
      const now = Date.now();
      return {
        base_url: baseUrl,
        last_working_tier: null,
        search_url_patterns: [],
        last_success_at: null,
        last_failure_at: null,
        fail_count: 0,
        disabled_at: null,
        disabled_reason: '',
        created_at: now,
      };
    }

    // Merges config over the stored table so the dashboard always shows exactly the
    // configured site set, with any learned per-site state layered on top.
    app.get('/api/site-profiles', (c) => {
      const config = requireConfig(ctx);
      const profilesBySite = new Map(profiles.list().map((p) => [p.base_url, p]));
      return c.json({
        profiles: config.subtitle.sites.map((site) => profilesBySite.get(site.baseUrl) ?? defaultProfile(site.baseUrl)),
      });
    });

    // The site is named in the body, not the path: its identity is a URL, and a URL does
    // not survive a path segment intact.
    app.put('/api/site-profiles', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = SiteProfileUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      // `null` fields (clear tier / clear lastFailureAt) pass straight through to `update`,
      // whose `!== undefined` guard still writes the column to null while an absent field
      // is untouched. When the client only sends `failCount: 0` (the dashboard "reset
      // failures" button), also clear lastFailureAt so the cooldown bookkeeping is fully
      // wiped — fail_count alone is not enough if a stale last_failure_at remains. Same
      // reasoning for `disabledAt: null` (the "re-enable" button): a re-enabled site starts
      // its own clean slate, so the reason text and failure bookkeeping clear with it,
      // exactly what dismissing a still-open site-unusable item already does below.
      const { baseUrl: _baseUrl, ...fields } = parsed.data;
      const patch: UpdateSiteProfileInput = {
        ...fields,
        ...(parsed.data.failCount === 0 && parsed.data.lastFailureAt === undefined
          ? { lastFailureAt: null }
          : {}),
        ...(parsed.data.disabledAt === null ? { disabledReason: '', failCount: 0, lastFailureAt: null } : {}),
      };
      // 404 for any URL outside the configured site set — the dashboard only edits what
      // config declares, so a stale/typo'd site is a caller mistake, not a silent no-op.
      const { baseUrl } = parsed.data;
      if (!requireConfig(ctx).subtitle.sites.some((s) => s.baseUrl === baseUrl)) {
        return c.json({ error: `site "${baseUrl}" is not configured` }, 404);
      }
      // Upsert-then-update (not just update) so a partial PUT still creates the row when
      // the agent hasn't run for this site yet — then only the provided fields land.
      profiles.upsert({ baseUrl });
      profiles.update(baseUrl, patch);
      // Return the post-update row: the dashboard replaces its table row with the response.
      return c.json(profiles.get(baseUrl));
    });
  }

  if (ctx.db) {
    const overview = new Overview(ctx.db);

    // Everything the dashboard home needs to answer "is Warrden healthy right now?"
    // in one request: queue depth, the review backlog, recent outcomes, and the mount
    // probe that would otherwise be a second round-trip.
    app.get('/api/overview', (c) =>
      c.json({ ...overview.counts(), storage: cachedStorage(), debugEnabled: ctx.config?.debug.enabled ?? false }),
    );
  }

  if (ctx.config && ctx.dataDir) {
    const dataDir = ctx.dataDir;
    const seedsDir = defaultSeedsDir();

    // baseUrl arrives from the client and becomes a filename via `siteKey()` inside every
    // `siteKnowledge.ts` path helper. Restricting these three routes to sites already
    // present in config (same 404 guard `/api/site-profiles` uses) means the filesystem is
    // only ever touched for a URL the operator already typed into config, never one a
    // request supplies fresh — a stronger guard than `siteKey`'s own character filtering,
    // and the one this route actually relies on.
    function requireConfiguredSite(baseUrl: string): boolean {
      return requireConfig(ctx).subtitle.sites.some((s) => s.baseUrl === baseUrl);
    }

    app.get('/api/site-knowledge', (c) => {
      const parsed = z.object({ baseUrl: z.url() }).safeParse({ baseUrl: c.req.query('baseUrl') });
      if (!parsed.success) return c.json({ error: 'invalid baseUrl' }, 400);
      const { baseUrl } = parsed.data;
      if (!requireConfiguredSite(baseUrl)) return c.json({ error: `site "${baseUrl}" is not configured` }, 404);

      const { knowledge, version } = loadKnowledgeWithVersion(dataDir, baseUrl, seedsDir);
      return c.json({ baseUrl, markdown: renderKnowledge(knowledge), agentChars: agentCharCount(knowledge), version });
    });

    // The one size bound a PUT is held to: agent sections over `KNOWLEDGE_CHAR_CAP` mean
    // every future reflection write for the site is dropped whole (`reflectOnRun`'s overflow
    // guard), so a hand-edit that overflows it silently freezes that site's learning.
    // Individual bullets have no length cap. The operator is still trusted and still not
    // injection-scanned or truncated: this just refuses the one shape a hand-edit can create
    // that the agent could never dig itself back out of.
    function agentSectionInvariantError(k: SiteKnowledge): string | null {
      const size = agentCharCount(k);
      if (size > KNOWLEDGE_CHAR_CAP) {
        return `the agent sections total ${size} characters, over the ${KNOWLEDGE_CHAR_CAP}-character cap the browse agent itself is held to — every future update it tries to write would be dropped. Put freeform or long content in "## Operator notes" instead, which has no length limit.`;
      }
      return null;
    }

    app.put('/api/site-knowledge', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      // The 200,000-char ceiling here is only an abuse guard on the request body as a
      // whole (operator notes are unbounded by design and can be most of that budget) —
      // the real invariant is `agentSectionInvariantError` below, checked after parsing so
      // it can measure the agent sections on their own rather than the whole file.
      // `version` is optional: the token `GET` handed back with the file this edit started
      // from. When present it's enforced as a compare-and-swap (G2) — a write since then
      // (almost always a reflection run) is refused with 409 rather than silently
      // overwritten. Omitting it keeps the old unconditional-overwrite behaviour for any
      // caller that hasn't been updated to carry the token; the dashboard always sends it.
      const parsed = z
        .object({ baseUrl: z.url(), markdown: z.string().min(1).max(200_000), version: z.string().optional() })
        .safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      const { baseUrl, markdown, version } = parsed.data;
      if (!requireConfiguredSite(baseUrl)) return c.json({ error: `site "${baseUrl}" is not configured` }, 404);

      // A hand-edit is trusted operator input: parsed through the same reader the agent's
      // own writes go through (so a stray line can't corrupt the file's shape) and saved as
      // submitted. It is deliberately NOT injection-scanned — that guard exists for content
      // the agent itself might inject into a prompt unsupervised, not for content a human
      // just typed into their own dashboard, and scan-on-load (the browse loop's own read,
      // Task 3) still catches it before the next run either way. It IS held to the same
      // agent-section-total limit the agent's own writes are held to
      // (`agentSectionInvariantError` above) — an operator PUT is the one path that can
      // create knowledge the agent can never again touch, so this is enforced here rather
      // than left to the next reflection call to notice.
      const knowledge = parseKnowledge(baseUrl, markdown);
      const invariantError = agentSectionInvariantError(knowledge);
      if (invariantError) return c.json({ error: invariantError }, 400);

      try {
        const newVersion = saveKnowledge(dataDir, knowledge, version);
        return c.json({ baseUrl, markdown: renderKnowledge(knowledge), agentChars: agentCharCount(knowledge), version: newVersion });
      } catch (err) {
        if (!(err instanceof KnowledgeConflictError)) throw err;
        // Almost always a reflection run landing between this dialog's GET and this PUT.
        // The file on disk is left alone — reload picks up whatever changed underneath.
        return c.json({ error: 'this site\'s knowledge file changed since it was loaded — reload it and re-apply your edit' }, 409);
      }
    });

    app.post('/api/site-knowledge/reset', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = z.object({ baseUrl: z.url() }).safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid baseUrl' }, 400);
      const { baseUrl } = parsed.data;
      if (!requireConfiguredSite(baseUrl)) return c.json({ error: `site "${baseUrl}" is not configured` }, 404);

      const seedPath = join(seedsDir, `${siteKey(baseUrl)}.md`);
      if (!existsSync(seedPath)) {
        // Meaningful refusal, not a silent no-op: there is nothing to reset to, and
        // deleting the local file anyway would erase every bullet the agent has learned
        // with nothing to fall back on but an empty file.
        return c.json({ error: `no seed knowledge exists for "${baseUrl}"` }, 404);
      }
      // Read the seed and save it through the normal write path — parse, render, atomic
      // temp-file-then-rename, `.bak` of whatever local copy this replaces — rather than
      // copying the seed file over the local one directly. The seed path is only ever a
      // read source here; nothing in this route can write back to `seedsDir`.
      const knowledge = parseKnowledge(baseUrl, readFileSync(seedPath, 'utf8'));
      // Deliberately unconditional, not compare-and-swap: a reset is its own explicit
      // overwrite, chosen by the operator with the current file already in front of them.
      const version = saveKnowledge(dataDir, knowledge);
      return c.json({ baseUrl, markdown: renderKnowledge(knowledge), agentChars: agentCharCount(knowledge), version });
    });

    // Read-only probes for Settings → Storage mounts (four fixed binds; not editable here).
    app.get('/api/health/storage', (c) => c.json({ checks: probeStorage() }));

    app.get('/api/config', (c) => {
      return c.json(redactConfig(requireConfig(ctx)));
    });

    app.put('/api/config', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const previous = requireConfig(ctx);
      let merged: unknown;
      try {
        merged = restoreSecrets(body, previous);
      } catch (err) {
        if (err instanceof ConfigMergeError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
      const result = ConfigSchema.safeParse(merged);
      if (!result.success) {
        return c.json({ error: 'invalid config', issues: result.error.issues }, 400);
      }
      saveConfig(dataDir, result.data);
      const arrsChanged = JSON.stringify(previous.arrs) !== JSON.stringify(result.data.arrs);
      const publicUrlChanged = previous.server.publicUrl !== result.data.server.publicUrl;
      // Every consumer reads `ctx.config` (and, for arr calls, `ctx.clients`) live, so
      // pointing the context at the new config is all it takes for the save to be fully in
      // effect — nothing here is deferred to a restart. Only `server.port` still needs one,
      // since the listener is bound before any of this runs.
      applyConfig(ctx, result.data);
      // Destructured AFTER applyConfig: it replaces `ctx.clients` with a new Map, and
      // registration must use the rebuilt one, not the Map this route saw on entry.
      const { db, events, clients } = ctx;
      if ((arrsChanged || publicUrlChanged) && db && events && clients) {
        // A new/renamed/re-pointed instance needs its webhook; existing healthy ones are
        // left alone by `registerWebhooks` itself. Background, so an unreachable arr can't
        // stall the operator's own save.
        registerWebhooksInBackground({ db, events, clients, config: result.data });
      }
      return c.json({ saved: true });
    });
  }

  // Only mounted when the dist dir actually exists — the dashboard is built separately
  // (`npm run build:web`), and this server's own test suite (which asserts 404s for
  // routes that a given ctx doesn't mount) runs whether or not that build has happened,
  // so this can't turn into a hard dependency for `createApp` to work either way.
  const webDistDir = ctx.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  if (existsSync(webDistDir)) {
    // `serveStatic` calls `next()`, not a 404, when a requested asset doesn't exist, so an
    // unmatched request falls through to Hono's own `notFound` handler below — that's where
    // the client-side-routing fallback to `index.html` lives, *except* for `/api` and
    // `/webhooks` (bare or with a subpath): those must keep 404ing as plain JSON (matching
    // the no-dist-dir case exactly) rather than serving the SPA shell for a mistyped or
    // unmounted API route.
    app.use('*', serveStatic({ root: webDistDir }));
    app.notFound(async (c) => {
      const path = c.req.path;
      const isApiOrWebhook = path === '/api' || path === '/webhooks' || path.startsWith('/api/') || path.startsWith('/webhooks/');
      if (isApiOrWebhook) {
        return c.json({ error: 'not found' }, 404);
      }
      // `serveStatic`'s middleware signature returns the `Response` it built rather than
      // assigning it anywhere on `c` — awaiting it and discarding the result (as an earlier
      // version of this did) serves an empty 200 instead of `index.html`'s actual bytes.
      // `index.html` not existing (dist dir present but somehow missing it) is the only way
      // this comes back undefined, hence the fallback.
      const res = await serveStatic({ path: join(webDistDir, 'index.html') })(c, async () => {});
      return res ?? c.text('not found', 404);
    });
  }

  return app;
}
