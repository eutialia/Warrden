import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ManualImportFile } from '../arr/types.js';
import { handleWebhook } from '../arr/webhooks.js';
import { ConfigSchema, SECRET_PLACEHOLDER, type Config } from '../config/schema.js';
import { saveConfig } from '../config/store.js';
import type { AppContext } from '../context.js';
import { AcquireRecords } from '../db/acquireRecords.js';
import { AttentionItems, type AttentionStatus } from '../db/attention.js';
import { ManagedObjects } from '../db/managedObjects.js';
import { PlacedFiles } from '../db/placedFiles.js';
import { SiteProfiles, type SiteProfileRow, type UpdateSiteProfileInput } from '../db/siteProfiles.js';
import { SubtitleRuns } from '../db/subtitleRuns.js';
import type { TargetKind } from '../jobs/queue.js';
import { deleteManagedObject } from '../managed/deleteObject.js';

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
// (clears the "known-good" tier), `searchUrlPatterns` capped at 5 non-empty entries,
// `notes` at 2000 chars (matching HINT_MAX_LENGTH's rationale — a pasted-in quirk note
// shouldn't inflate the agent's prompt unboundedly). `failCount` is the accessible reset
// seam: PUT `{ failCount: 0 }` clears the escalation/backoff bookkeeping.
const SiteProfileUpdateSchema = z.object({
  notes: z.string().max(2000).optional(),
  lastWorkingTier: z.enum(['curl', 'chromium', 'camoufox', 'remote']).nullable().optional(),
  searchUrlPatterns: z.array(z.string().min(1)).max(5).optional(),
  failCount: z.number().int().min(0).optional(),
  // Explicit null clears the timestamp (used with failCount: 0 by "reset failures").
  lastFailureAt: z.number().int().nullable().optional(),
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
    const clients = ctx.clients;

    app.post('/webhooks/:instance', async (c) => {
      const instance = c.req.param('instance');
      const payload: unknown = await c.req.json().catch(() => undefined);
      // `requireConfig(ctx)` (not a value snapshotted here at mount time) so a config
      // reloaded via `PUT /api/config` is picked up starting with the very next webhook.
      const webhookCtx = { queue, events, config: requireConfig(ctx), clients };
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

    app.get('/api/jobs', (c) => {
      const limit = parseLimit(c.req.query('limit'), DEFAULT_JOBS_LIMIT);
      const jobs = queue.list({ limit });
      return c.json(jobs.map((job) => ({ ...job, acquireOutcome: acquireOutcome(job) })));
    });

    app.get('/api/jobs/:id', (c) => {
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
      return c.json({
        job,
        acquireRecord,
        acquireOutcome: acquireOutcome(job),
        placedFiles: placedFiles.listByJob(job.id),
        // This job's own subtitle site-search runs, transcript included — the dashboard's
        // JobDetail "Subtitle runs" card renders these as a chronological step list.
        subtitleRuns: new SubtitleRuns(db).listByJob(job.id),
      });
    });
  }

  if (ctx.queue && ctx.config && ctx.clients) {
    const queue = ctx.queue;
    const clients = ctx.clients;

    app.post('/api/acquire', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = AcquireBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      const { arrInstance, targetKind, targetId, title, hint } = parsed.data;
      // Checked against `ctx.clients` (the runner's actual resolution source), not
      // `config.arrs` — see `handleWebhook`'s matching comment for why the two can drift.
      // This is still a client mistake (typo'd/removed/not-yet-restarted instance name),
      // so it's a 400 here rather than the webhook route's always-200 "unknown instance"
      // (which exists only because arrs retry non-2xx deliveries; nothing retries a
      // dashboard button click).
      if (!clients.has(arrInstance)) {
        return c.json({ error: `unknown arr instance "${arrInstance}"` }, 400);
      }
      const result = queue.enqueue({
        pipeline: 'acquire',
        arrInstance,
        targetKind,
        targetId,
        payload: { title, source: 'manual', hint },
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
      if (!clients.has(arrInstance)) {
        return c.json({ error: `unknown arr instance "${arrInstance}"` }, 400);
      }
      const result = queue.enqueue({
        pipeline: 'subtitle',
        arrInstance,
        targetKind,
        targetId,
        payload: { source: 'manual' },
      });
      return c.json({ outcome: result.outcome });
    });
  }

  if (ctx.db && ctx.queue && ctx.clients && ctx.events) {
    const db = ctx.db;
    const queue = ctx.queue;
    const clients = ctx.clients;
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
      // matching comment for why the two can drift.
      if (!clients.has(job.arr_instance)) return c.json({ error: `unknown arr instance "${job.arr_instance}"` }, 400);

      // Re-enqueues the JOB'S OWN pipeline (ingest or acquire, whichever it actually
      // was) — unlike repick below, a retry isn't necessarily an acquire re-pick, so it
      // must not hardcode one.
      queue.enqueue({
        pipeline: job.pipeline,
        targetKind: job.target_kind,
        targetId: job.target_id,
        arrInstance: job.arr_instance,
        payload: { ...job.payload, source: 'retry' },
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
      if (!clients.has(job.arr_instance)) return c.json({ error: `unknown arr instance "${job.arr_instance}"` }, 400);

      const body: unknown = await c.req.json().catch(() => ({}));
      const parsed = RepickBodySchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);

      // Always pipeline 'acquire' (unlike retry above) — a repick is specifically "try the
      // pick again, with a human's hint this time," regardless of which pipeline the
      // linked job itself ran.
      queue.enqueue({
        pipeline: 'acquire',
        targetKind: job.target_kind,
        targetId: job.target_id,
        arrInstance: job.arr_instance,
        payload: { ...job.payload, source: 'repick', hint: parsed.data.hint },
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
        // Only ever re-executes exactly the `bundle-import` shape `runIngestJob`'s rescue
        // stage itself proposed — validated before the client is even looked up, so a
        // malformed payload never gets as far as touching the arr.
        const parsed = AcceptDataSchema.safeParse(item.data);
        if (!parsed.success) return c.json({ error: 'malformed accept data', issues: parsed.error.issues }, 400);
        const client = clients.get(parsed.data.instance);
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
    const clients = ctx.clients;
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
      const { deletedInArr } = await deleteManagedObject({ db, clients, events, config: requireConfig(ctx) }, row);
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
    function defaultProfile(name: string, baseUrl: string): SiteProfileRow {
      const now = Date.now();
      return {
        name,
        base_url: baseUrl,
        last_working_tier: null,
        search_url_patterns: [],
        notes: '',
        last_success_at: null,
        last_failure_at: null,
        fail_count: 0,
        created_at: now,
      };
    }

    // Merges config over the stored table so the dashboard always shows exactly the
    // configured site set, with any learned per-site state layered on top.
    app.get('/api/site-profiles', (c) => {
      const config = requireConfig(ctx);
      const profilesBySite = new Map(profiles.list().map((p) => [p.name, p]));
      return c.json({
        profiles: config.subtitle.sites.map((site) => profilesBySite.get(site.name) ?? defaultProfile(site.name, site.baseUrl)),
      });
    });

    app.put('/api/site-profiles/:name', async (c) => {
      const name = c.req.param('name');
      // 404 for any name outside the configured site set — the dashboard only edits what
      // config declares, so a stale/typo'd site is a caller mistake, not a silent no-op.
      if (!requireConfig(ctx).subtitle.sites.some((s) => s.name === name)) {
        return c.json({ error: `site "${name}" is not configured` }, 404);
      }
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = SiteProfileUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      // `null` fields (clear tier / clear lastFailureAt) pass straight through to `update`,
      // whose `!== undefined` guard still writes the column to null while an absent field
      // is untouched. When the client only sends `failCount: 0` (the dashboard "reset
      // failures" button), also clear lastFailureAt so the cooldown bookkeeping is fully
      // wiped — fail_count alone is not enough if a stale last_failure_at remains.
      const patch: UpdateSiteProfileInput = {
        ...parsed.data,
        ...(parsed.data.failCount === 0 && parsed.data.lastFailureAt === undefined
          ? { lastFailureAt: null }
          : {}),
      };
      // Upsert-then-update (not just update) so a partial PUT still creates the row when
      // the agent hasn't run for this site yet — then only the provided fields land.
      const site = requireConfig(ctx).subtitle.sites.find((s) => s.name === name)!;
      profiles.upsert({ name, baseUrl: site.baseUrl });
      profiles.update(name, patch);
      // Return the post-update row: the dashboard replaces its table row with the response.
      return c.json(profiles.get(name));
    });
  }

  if (ctx.config && ctx.dataDir) {
    const dataDir = ctx.dataDir;

    app.get('/api/config', (c) => {
      return c.json(redactConfig(requireConfig(ctx)));
    });

    app.put('/api/config', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      let merged: unknown;
      try {
        merged = restoreSecrets(body, requireConfig(ctx));
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
      // Restart applies provider/LLM changes in Phase 1 (noted in the response below), but
      // everything else the config touches (server port aside) is read live off `ctx.config`
      // on every request — updating it in place lets a subsequent GET reflect the new save
      // without a restart.
      ctx.config = result.data;
      return c.json({ saved: true, restartRequired: true });
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
