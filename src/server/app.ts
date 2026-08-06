import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { handleWebhook } from '../arr/webhooks.js';
import { ConfigSchema, type Config } from '../config/schema.js';
import { saveConfig } from '../config/store.js';
import type { AppContext } from '../context.js';
import { AcquireRecords } from '../db/acquireRecords.js';

const DEFAULT_EVENTS_LIMIT = 100;
const DEFAULT_JOBS_LIMIT = 50;
const MAX_LIMIT = 1000;

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

const REDACTED_SECRET = '•••';

type LlmKeys = Config['llm']['keys'];

/** Replaces every *set* `llm.keys` value with a `•••` sentinel for `GET /api/config` —
 * an unset key stays absent rather than becoming a fake sentinel, so the dashboard can
 * tell "never configured" apart from "configured, just not shown". */
function redactConfig(config: Config): Config {
  const redactedKeys = Object.fromEntries(
    Object.entries(config.llm.keys).map(([key, value]) => [key, value === undefined ? value : REDACTED_SECRET]),
  ) as LlmKeys;
  return { ...config, llm: { ...config.llm, keys: redactedKeys } };
}

/** Undoes `redactConfig` on the way in: any `llm.keys` value that's still the `•••`
 * sentinel (the dashboard round-tripped it unchanged) is swapped back for the real
 * stored secret before validating/saving, so a config edit that doesn't touch keys
 * can't accidentally wipe them. A key set to anything else (a new value, or removed
 * entirely) passes through as the caller wrote it. */
function restoreSecrets(body: unknown, current: Config): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const record = body as Record<string, unknown>;
  const llm = record.llm;
  if (typeof llm !== 'object' || llm === null) return body;
  const llmRecord = llm as Record<string, unknown>;
  const keys = llmRecord.keys;
  if (typeof keys !== 'object' || keys === null) return body;
  const keysRecord = keys as Record<string, unknown>;
  const restoredKeys = Object.fromEntries(
    Object.entries(keysRecord).map(([key, value]) => [
      key,
      value === REDACTED_SECRET ? current.llm.keys[key as keyof LlmKeys] : value,
    ]),
  );
  return { ...record, llm: { ...llmRecord, keys: restoredKeys } };
}

const AcquireBodySchema = z.object({
  arrInstance: z.string().min(1),
  targetKind: z.enum(['series', 'movie']),
  targetId: z.number().int(),
  title: z.string().optional(),
});

export function createApp(ctx: Partial<AppContext>): Hono {
  const app = new Hono();
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

  if (ctx.queue && ctx.events && ctx.config) {
    const webhookCtx = { queue: ctx.queue, events: ctx.events, config: ctx.config };

    app.post('/webhooks/:instance', async (c) => {
      const instance = c.req.param('instance');
      const payload: unknown = await c.req.json().catch(() => undefined);
      // Always 200: the arrs retry non-2xx webhook deliveries, which we don't want.
      return c.json(handleWebhook(webhookCtx, instance, payload));
    });
  }

  if (ctx.queue && ctx.db) {
    const queue = ctx.queue;
    const acquireRecords = new AcquireRecords(ctx.db);

    app.get('/api/jobs', (c) => {
      const limit = parseLimit(c.req.query('limit'), DEFAULT_JOBS_LIMIT);
      return c.json(queue.list({ limit }));
    });

    app.get('/api/jobs/:id', (c) => {
      const id = Number(c.req.param('id'));
      const job = Number.isInteger(id) ? queue.get(id) : null;
      if (!job) return c.json({ error: 'job not found' }, 404);
      // `listByTarget` orders newest first, so [0] is the latest outcome for this target.
      const acquireRecord = acquireRecords.listByTarget(job.arr_instance, job.target_kind, job.target_id)[0] ?? null;
      return c.json({ job, acquireRecord });
    });
  }

  if (ctx.queue) {
    const queue = ctx.queue;

    app.post('/api/acquire', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = AcquireBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
      }
      const { arrInstance, targetKind, targetId, title } = parsed.data;
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
      return c.json(redactConfig(ctx.config as Config));
    });

    app.put('/api/config', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const merged = restoreSecrets(body, ctx.config as Config);
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

  return app;
}
