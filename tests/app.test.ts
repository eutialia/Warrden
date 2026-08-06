import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { EventLog } from '../src/events/log.js';
import { freshDb, makeCtx, configWithArrs, fakeArrClient } from './helpers.js';

describe('app', () => {
  it('serves healthz', async () => {
    const res = await createApp({}).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('does not mount the events routes when ctx.events is absent', async () => {
    const res = await createApp({}).request('/api/events');
    expect(res.status).toBe(404);
  });

  it('does not mount the webhooks route when ctx.queue/events/clients are absent', async () => {
    // content-type: application/json so the CSRF middleware (which runs ahead of route
    // mounting on every /webhooks/* request) doesn't itself 403 a request with no
    // content-type header at all (its own "simple content type" default) before this test
    // ever gets to observe the 404 it's actually checking for.
    const res = await createApp({}).request('/webhooks/sonarr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  describe('webhooks route', () => {
    it('responds 200 with handleWebhook\'s result, even for an unhandled event', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Rename' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: false, reason: 'ignored' });
    });

    it('responds 200 with "unknown instance" for an arr with no registered client', async () => {
      const ctx = makeCtx(); // default config: arrs: [], clients: {}
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren' } }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: false, reason: 'unknown instance' });
      expect(ctx.queue.claim()).toBeNull();
    });

    it('enqueues an acquire job and answers 200 for a SeriesAdd event', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren' } }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: true });
      expect(ctx.queue.claim()).toMatchObject({ pipeline: 'acquire', target_kind: 'series', target_id: 42 });
    });
  });

  describe('CSRF protection (hono/csrf on /api/* and /webhooks/*)', () => {
    it('blocks a cross-origin request against /webhooks/* using a "simple" content type that dodges CORS preflight', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: JSON.stringify({ eventType: 'Test' }),
      });

      expect(res.status).toBe(403);
    });

    it('blocks the same cross-origin attempt against /api/*', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);

      const res = await app.request('/api/acquire', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 1 }),
      });

      expect(res.status).toBe(403);
    });

    it('allows a request with no Origin header at all, like the arr\'s own webhook POST', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Test' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: true });
    });
  });

  describe('events routes', () => {
    it('GET /api/events returns the JSON list, newest first', async () => {
      const events = new EventLog(freshDb());
      events.append({ kind: 'job.started', message: 'go' });
      events.append({ kind: 'job.done', message: 'done' });
      const app = createApp({ events });

      const res = await app.request('/api/events?limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string }[];
      expect(body.map((e) => e.kind)).toEqual(['job.done']);
    });

    it.each([
      { query: '', expectedKinds: ['job.done', 'job.started'] }, // no params -> default limit 100, all rows
      { query: '?limit=1', expectedKinds: ['job.done'] },
      { query: '?limit=abc', expectedKinds: ['job.done', 'job.started'] }, // non-numeric -> falls back to default
      { query: '?limit=', expectedKinds: ['job.done', 'job.started'] }, // empty -> falls back to default, not LIMIT 0
      { query: '?level=', expectedKinds: ['job.done', 'job.started'] }, // empty level -> no filter, not WHERE level=''
    ])('GET /api/events$query returns $expectedKinds', async ({ query, expectedKinds }) => {
      const events = new EventLog(freshDb());
      events.append({ kind: 'job.started', message: 'go' });
      events.append({ kind: 'job.done', message: 'done' });
      const app = createApp({ events });

      const res = await app.request(`/api/events${query}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string }[];
      expect(body.map((e) => e.kind)).toEqual(expectedKinds);
    });

    it('GET /api/events clamps an outsized ?limit= to MAX_LIMIT (1000) rather than passing it straight to SQL', async () => {
      const db = freshDb();
      const events = new EventLog(db);
      const insert = db.prepare(`INSERT INTO events (ts, kind, level, message, data) VALUES (?, 'job.done', 'info', 'done', '{}')`);
      for (let i = 0; i < 1001; i++) insert.run(i);
      const app = createApp({ events });

      const res = await app.request('/api/events?limit=999999');
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toHaveLength(1000);
    });

    it('GET /api/events/stream responds with text/event-stream and streams an appended event', async () => {
      const events = new EventLog(freshDb());
      const app = createApp({ events });
      const controller = new AbortController();

      const res = await app.request('/api/events/stream', { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(events.subscriberCount).toBe(1);

      events.append({ kind: 'job.started', message: 'go' });

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('data: ');
      const payload = JSON.parse(chunk.replace(/^data: /, '').trim()) as { kind: string };
      expect(payload.kind).toBe('job.started');

      controller.abort();
      await reader.cancel();
      await vi.waitFor(() => expect(events.subscriberCount).toBe(0));
    });
  });

  describe('static serving (ctx.webDistDir)', () => {
    it('serves index.html for a client-side route, keeps /api and /webhooks 404ing as JSON, and leaves /healthz alone', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'warrden-web-dist-'));
      try {
        const indexHtml = '<!doctype html><html><body>fixture shell</body></html>';
        writeFileSync(join(dir, 'index.html'), indexHtml);
        const app = createApp({ webDistDir: dir });

        const deepLink = await app.request('/jobs/5');
        expect(deepLink.status).toBe(200);
        expect(await deepLink.text()).toBe(indexHtml);

        const unknownApi = await app.request('/api/unknown');
        expect(unknownApi.status).toBe(404);
        expect(await unknownApi.json()).toEqual({ error: 'not found' });

        const health = await app.request('/healthz');
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: 'ok' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
