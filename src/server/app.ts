import { Hono } from 'hono';
import type { AppContext } from '../context.js';

export function createApp(_ctx: Partial<AppContext>): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}
