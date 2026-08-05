import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { handleWebhook } from '../arr/webhooks.js';
import type { AppContext } from '../context.js';

const DEFAULT_EVENTS_LIMIT = 100;
const MAX_EVENTS_LIMIT = 1000;

// `?limit=` (empty) and `?limit=abc` (non-numeric) both fall back to the default rather
// than reaching better-sqlite3, which rejects NaN/negative bind params outright.
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_EVENTS_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EVENTS_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_EVENTS_LIMIT);
}

// `?level=` (empty) means "no filter", same as omitting the param entirely.
function parseLevel(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

export function createApp(ctx: Partial<AppContext>): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (ctx.events) {
    const events = ctx.events;

    app.get('/api/events', (c) => {
      const limit = parseLimit(c.req.query('limit'));
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

  if (ctx.queue && ctx.events) {
    // Full AppContext here, minus fields handleWebhook never touches (db, config, clients) —
    // the guard above already guarantees the two it does.
    const webhookCtx = ctx as AppContext;

    app.post('/webhooks/:instance', async (c) => {
      const instance = c.req.param('instance');
      const payload: unknown = await c.req.json().catch(() => undefined);
      // Always 200: the arrs retry non-2xx webhook deliveries, which we don't want.
      return c.json(handleWebhook(webhookCtx, instance, payload));
    });
  }

  return app;
}
