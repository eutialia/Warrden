import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../context.js';

export function createApp(ctx: Partial<AppContext>): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (ctx.events) {
    const events = ctx.events;

    app.get('/api/events', (c) => {
      const limitParam = c.req.query('limit');
      const level = c.req.query('level');
      return c.json(
        events.list({
          limit: limitParam === undefined ? undefined : Number(limitParam),
          level,
        }),
      );
    });

    app.get('/api/events/stream', (c) => {
      return streamSSE(c, async (stream) => {
        const unsubscribe = events.subscribe((e) => {
          void stream.writeSSE({ data: JSON.stringify(e) });
        });
        const aborted = new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener('abort', () => resolve());
        });
        try {
          await aborted;
        } finally {
          unsubscribe();
        }
      });
    });
  }

  return app;
}
