import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { handleWebhook } from '../arr/webhooks.js';
import { ConfigSchema, SECRET_PLACEHOLDER, type Config } from '../config/schema.js';
import { saveConfig } from '../config/store.js';
import type { AppContext } from '../context.js';
import { AcquireRecords } from '../db/acquireRecords.js';
import type { TargetKind } from '../jobs/queue.js';

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

const AcquireBodySchema = z.object({
  arrInstance: z.string().min(1),
  targetKind: z.enum(['series', 'movie']),
  targetId: z.number().int(),
  title: z.string().optional(),
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
  // "simple" content type (`text/plain`, form-urlencoded, multipart) — the classic CSRF
  // vector against a JSON API that parses the body regardless of its declared type (see
  // `c.req.json()` below, used everywhere). A request with no Origin header at all —
  // Sonarr/Radarr's own webhook POSTs, or any other server-to-server call — is allowed
  // through unaffected; only a browser sends Origin in the first place.
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
    const acquireRecords = new AcquireRecords(ctx.db);

    // The dashboard-facing "did this job actually grab anything" status: `null` for a
    // non-acquire pipeline, or an acquire job with no record yet (still pending/running,
    // or it crashed before recording). See `AcquireRecords.outcomeForJob` for why this is
    // an aggregate over every record the job's own run produced, not just the latest one.
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
      // can't retroactively change this job's badge; live jobs stay unbounded.
      const terminal = job.status === 'done' || job.status === 'failed';
      return acquireRecords.outcomeForJob(
        job.arr_instance,
        job.target_kind,
        job.target_id,
        job.created_at,
        terminal ? job.updated_at : undefined,
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
      // `listByTarget` orders newest first, so [0] is the latest outcome for this target —
      // shown for its detail (reasoning, candidates); `acquireOutcome` above is the
      // aggregate used for the status badge.
      const acquireRecord = acquireRecords.listByTarget(job.arr_instance, job.target_kind, job.target_id)[0] ?? null;
      return c.json({ job, acquireRecord, acquireOutcome: acquireOutcome(job) });
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
      const { arrInstance, targetKind, targetId, title } = parsed.data;
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
        payload: { title, source: 'manual' },
      });
      return c.json({ outcome: result.outcome });
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
