import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { EventLog } from '../src/events/log.js';
import { freshDb, makeCtx } from './helpers.js';

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

  it('does not mount the webhooks route when ctx.queue/events are absent', async () => {
    const res = await createApp({}).request('/webhooks/sonarr', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  describe('webhooks route', () => {
    it('responds 200 with handleWebhook\'s result, even for an unhandled event', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Rename' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: false, reason: 'ignored' });
    });

    it('enqueues an acquire job and answers 200 for a SeriesAdd event', async () => {
      const ctx = makeCtx();
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
});
