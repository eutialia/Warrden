import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/app.js';
import { EventLog } from '../src/events/log.js';
import { freshDb } from './helpers.js';

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

    it('GET /api/events/stream responds with text/event-stream and streams an appended event', async () => {
      const events = new EventLog(freshDb());
      const app = createApp({ events });
      const controller = new AbortController();

      const res = await app.request('/api/events/stream', { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      events.append({ kind: 'job.started', message: 'go' });

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('data: ');
      const payload = JSON.parse(chunk.replace(/^data: /, '').trim()) as { kind: string };
      expect(payload.kind).toBe('job.started');

      controller.abort();
      await reader.cancel();
    });
  });
});
