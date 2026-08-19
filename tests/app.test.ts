import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { AttentionItems } from '../src/db/attention.js';
import { ManagedObjects } from '../src/db/managedObjects.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { SiteProfiles } from '../src/db/siteProfiles.js';
import { SubtitleRuns } from '../src/db/subtitleRuns.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX } from '../src/pipelines/acquire/pin.js';
import { ConfigSchema } from '../src/config/schema.js';
import { freshDb, makeCtx, configWithArrs, fakeArrClient, ctxWithClient, findEvent, bundleImportPayload, openAttentionForJob } from './helpers.js';

const jsonHeaders = { 'content-type': 'application/json' };

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
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
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
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
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
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: JSON.stringify({ eventType: 'Test' }),
      });

      expect(res.status).toBe(403);
    });

    it('blocks the same cross-origin attempt against /api/*', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/api/acquire', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 1 }),
      });

      expect(res.status).toBe(403);
    });

    it('allows a request with no Origin header at all, like the arr\'s own webhook POST', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
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

  describe('attention routes', () => {
    it('GET /api/attention defaults to status=open and honors an explicit ?status=', async () => {
      const ctx = makeCtx();
      const attentionItems = new AttentionItems(ctx.db);
      const open = attentionItems.open({ kind: 'ingest.unmatched', message: 'open one' });
      const dismissed = attentionItems.open({ kind: 'ingest.unmatched', message: 'dismissed one', jobId: 99 });
      attentionItems.setStatus(dismissed.id, 'dismissed');
      const app = createApp(ctx);

      const defaultRes: any = await (await app.request('/api/attention')).json();
      expect(defaultRes.items.map((i: any) => i.id)).toEqual([open.id]);

      const dismissedRes: any = await (await app.request('/api/attention?status=dismissed')).json();
      expect(dismissedRes.items.map((i: any) => i.id)).toEqual([dismissed.id]);
    });

    it('POST /api/attention/:id/dismiss: 404 unknown, 409 non-open, 200 ok on an open item', async () => {
      const ctx = makeCtx();
      const attentionItems = new AttentionItems(ctx.db);
      const item = attentionItems.open({ kind: 'ingest.unmatched', message: 'x' });
      const app = createApp(ctx);

      expect((await app.request('/api/attention/999/dismiss', { method: 'POST', headers: jsonHeaders })).status).toBe(404);

      const res = await app.request(`/api/attention/${item.id}/dismiss`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(attentionItems.get(item.id)!.status).toBe('dismissed');
      expect(findEvent(ctx.events.list(), 'attention.dismissed')).toMatchObject({ data: { id: item.id, kind: 'ingest.unmatched' } });

      const again = await app.request(`/api/attention/${item.id}/dismiss`, { method: 'POST', headers: jsonHeaders });
      expect(again.status).toBe(409);
    });

    it('POST /api/attention/:id/retry: 400 with no linked job, 400 when the linked job is gone, otherwise re-enqueues the JOB\'S OWN pipeline with source: retry and marks resolved only after enqueuing', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);

      const noJob = attentionItems.open({ kind: 'ingest.unmatched', message: 'no job' });
      expect((await app.request(`/api/attention/${noJob.id}/retry`, { method: 'POST', headers: jsonHeaders })).status).toBe(400);

      const goneJobId = 12345;
      const goneJobItem = attentionItems.open({ kind: 'ingest.unmatched', message: 'gone job', jobId: goneJobId });
      expect((await app.request(`/api/attention/${goneJobItem.id}/retry`, { method: 'POST', headers: jsonHeaders })).status).toBe(400);

      const enqueueResult = ctx.queue.enqueue({
        pipeline: 'ingest',
        targetKind: 'series',
        targetId: 42,
        arrInstance: 'sonarr',
        payload: { downloadId: 'dl-1' },
      });
      const item = attentionItems.open({ kind: 'ingest.unmatched', message: 'retry me', jobId: enqueueResult.id! });

      const res = await app.request(`/api/attention/${item.id}/retry`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(attentionItems.get(item.id)!.status).toBe('resolved');

      // Re-enqueued the job's OWN pipeline (ingest, not hardcoded acquire), same target,
      // payload carrying `source: 'retry'` alongside the original payload.
      const requeued = ctx.db.prepare(`SELECT * FROM jobs WHERE id != ? ORDER BY id DESC LIMIT 1`).get(enqueueResult.id) as any;
      expect(requeued).toBeUndefined(); // coalesced into the same pending row, not a new one
      const job = ctx.queue.get(enqueueResult.id!)!;
      expect(job.pipeline).toBe('ingest');
      expect(job.payload).toEqual({ downloadId: 'dl-1', source: 'retry' });

      const retriedEvent = findEvent(ctx.events.list(), 'attention.retried');
      expect(retriedEvent).toMatchObject({ data: { id: item.id, jobId: enqueueResult.id, pipeline: 'ingest' } });
    });

    it('POST /api/attention/:id/retry and /repick trace a trigger.manual on the enqueued job', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app, item } = openAttentionForJob(ctx, { pipeline: 'ingest', payload: { downloadId: 'dl-1' }, kind: 'ingest.unmatched' });
      expect((await app.request(`/api/attention/${item.id}/retry`, { method: 'POST', headers: jsonHeaders })).status).toBe(200);

      // Its own context: `openAttentionForJob` claims+completes, which would otherwise pick
      // up the pending job the retry above just re-enqueued.
      const ctx2 = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app: app2, item: item2 } = openAttentionForJob(ctx2, { pipeline: 'acquire', targetId: 77, kind: 'acquire.failed' });
      expect(
        (await app2.request(`/api/attention/${item2.id}/repick`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ hint: 'prefer 1080p' }) })).status,
      ).toBe(200);

      const collect = (c: typeof ctx) => new TraceEntries(c.db).summaries().flatMap((s) => new TraceEntries(c.db).listByJob(s.job_id));
      const entries = [...collect(ctx), ...collect(ctx2)];
      const retry = entries.find((e) => e.summary === 'attention retry');
      const repick = entries.find((e) => e.summary === 'attention repick');
      expect(retry).toMatchObject({ kind: 'trigger.manual' });
      expect(JSON.parse(retry!.payload ?? '')).toMatchObject({ attentionId: item.id, pipeline: 'ingest' });
      expect(repick).toMatchObject({ kind: 'trigger.manual' });
      expect(JSON.parse(repick!.payload ?? '')).toMatchObject({ attentionId: item2.id, hint: 'prefer 1080p' });
    });

    it('POST /api/attention/:id/retry: 400 when the linked job\'s arr instance has no registered client (parity with /api/acquire)', async () => {
      const ctx = makeCtx(); // no clients registered at all
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const enqueueResult = ctx.queue.enqueue({ pipeline: 'ingest', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: {} });
      const item = attentionItems.open({ kind: 'ingest.unmatched', message: 'x', jobId: enqueueResult.id! });

      const res = await app.request(`/api/attention/${item.id}/retry`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/repick: enqueues pipeline "acquire" even when the linked job\'s own pipeline was "ingest" (repick is always a re-pick, never the original pipeline)', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app, item } = openAttentionForJob(ctx, {
        pipeline: 'ingest',
        payload: { downloadId: 'dl-1' },
        kind: 'ingest.rescue-proposed',
      });

      const res = await app.request(`/api/attention/${item.id}/repick`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
      expect(res.status).toBe(200);

      const repicked = ctx.queue.claim()!;
      expect(repicked.pipeline).toBe('acquire'); // NOT 'ingest' — mutating this to job.pipeline must fail
    });

    it('POST /api/attention/:id/repick: 400 when the linked job\'s arr instance has no registered client', async () => {
      const ctx = makeCtx(); // no clients registered at all
      const { app, attentionItems, item } = openAttentionForJob(ctx);

      const res = await app.request(`/api/attention/${item.id}/repick`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/repick: rejects a hint over 2000 characters with 400', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app, item } = openAttentionForJob(ctx);

      const res = await app.request(`/api/attention/${item.id}/repick`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hint: 'x'.repeat(2001) }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/attention/:id/repick: always pipeline acquire, carries the hint, marks resolved', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app, attentionItems, item, jobId } = openAttentionForJob(ctx, {
        payload: { title: 'Frieren' },
        message: 'needs a hint',
      });

      const res = await app.request(`/api/attention/${item.id}/repick`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hint: 'prefer the 10bit encode' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(attentionItems.get(item.id)!.status).toBe('resolved');

      const repicked = ctx.queue.claim()!;
      expect(repicked.pipeline).toBe('acquire');
      expect(repicked.payload).toEqual({ title: 'Frieren', source: 'repick', hint: 'prefer the 10bit encode' });

      const repickedEvent = findEvent(ctx.events.list(), 'attention.repicked');
      expect(repickedEvent).toMatchObject({ data: { id: item.id, jobId, hasHint: true } });
    });

    it('POST /api/attention/:id/repick works with no hint given', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const { app, item } = openAttentionForJob(ctx, { payload: { title: 'Frieren' } });

      const res = await app.request(`/api/attention/${item.id}/repick`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      const repicked = ctx.queue.claim()!;
      expect(repicked.payload).toEqual({ title: 'Frieren', source: 'repick' });
    });

    it('POST /api/attention/:id/accept: executes the bundle-import with importMode "copy" and marks resolved only after it succeeds', async () => {
      const client = fakeArrClient();
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);

      const files = [{ path: '/downloads/Show/ep1.mkv', movieId: 7 }];
      const item = attentionItems.open({
        kind: 'ingest.rescue-proposed',
        message: 'needs review',
        data: bundleImportPayload({ files, reasoning: 'low confidence' }),
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(client.executeManualImport).toHaveBeenCalledWith(files, 'copy');
      expect(attentionItems.get(item.id)!.status).toBe('resolved');
      expect(findEvent(ctx.events.list(), 'attention.accepted')).toMatchObject({
        data: { id: item.id, kind: 'ingest.rescue-proposed', fileCount: 1 },
      });
    });

    it('POST /api/attention/:id/accept: 400 on malformed data (not a bundle-import action)', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({ kind: 'ingest.unmatched', message: 'not acceptable', data: { instance: 'sonarr' } });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it.each([
      { name: 'an empty files array', files: [] },
      { name: 'a file missing path', files: [{ movieId: 7 }] },
      { name: 'a file with an empty-string path', files: [{ path: '' }] },
    ])('POST /api/attention/:id/accept: 400 on $name', async ({ files }) => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'ingest.rescue-proposed',
        message: 'x',
        data: bundleImportPayload({ files, reasoning: 'x' }),
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/accept: two concurrent requests for the SAME item only execute the import once — one 200, one 409', async () => {
      const client = fakeArrClient();
      client.executeManualImport = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'ingest.rescue-proposed',
        message: 'x',
        data: bundleImportPayload({ files: [{ path: '/x.mkv' }] }),
      });

      const [res1, res2] = await Promise.all([
        app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders }),
        app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders }),
      ]);

      expect([res1.status, res2.status].sort()).toEqual([200, 409]);
      expect(client.executeManualImport).toHaveBeenCalledTimes(1);
      expect(attentionItems.get(item.id)!.status).toBe('resolved');
    });

    it('POST /api/attention/:id/accept: 400 on an unknown client instance', async () => {
      const ctx = makeCtx();
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'ingest.rescue-proposed',
        message: 'x',
        data: bundleImportPayload({ instance: 'no-such-instance', files: [{ path: '/x.mkv' }] }),
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/accept: a failed executeManualImport leaves the item open, not resolved', async () => {
      const client = fakeArrClient();
      client.executeManualImport = vi.fn(async () => {
        throw new Error('arr rejected the import');
      });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'ingest.rescue-proposed',
        message: 'x',
        data: bundleImportPayload({ files: [{ path: '/x.mkv' }] }),
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(500);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/accept: a force-grab item grabs the offered release and resolves', async () => {
      const client = fakeArrClient();
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'acquire.none-viable',
        message: 'the model rejected every release',
        data: { action: 'force-grab', instance: 'sonarr', guid: 'g-top', indexerId: 3, pickedTitle: '[Trix] S01 Batch' },
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(client.grabbed).toEqual([{ guid: 'g-top', indexerId: 3 }]);
      expect(attentionItems.get(item.id)!.status).toBe('resolved');
      expect(findEvent(ctx.events.list(), 'attention.accepted')).toMatchObject({
        data: { id: item.id, kind: 'acquire.none-viable', guid: 'g-top' },
      });
    });

    it('POST /api/attention/:id/accept: a failed force-grab returns 502 and leaves the item open for a re-pick', async () => {
      const client = fakeArrClient();
      client.grabRelease = vi.fn(async () => {
        throw new Error('release not found in cache');
      });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'acquire.none-viable',
        message: 'the model rejected every release',
        data: { action: 'force-grab', instance: 'sonarr', guid: 'g-top', indexerId: 3, pickedTitle: '[Trix] S01 Batch' },
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(502);
      expect((await res.json() as { error: string }).error).toContain('release not found in cache');
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it('POST /api/attention/:id/accept: 400 on a force-grab naming an unknown arr instance', async () => {
      const ctx = makeCtx();
      const attentionItems = new AttentionItems(ctx.db);
      const app = createApp(ctx);
      const item = attentionItems.open({
        kind: 'acquire.none-viable',
        message: 'x',
        data: { action: 'force-grab', instance: 'no-such-instance', guid: 'g-top', indexerId: 3, pickedTitle: 'x' },
      });

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(400);
      expect(attentionItems.get(item.id)!.status).toBe('open');
    });

    it.each([
      ['accept', 'accept', true],
      ['dismiss', 'dismiss', false],
    ])('%s on a site-unusable item sets the disabled flag accordingly', async (_l, route, expectDisabled) => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      ctx.events.append({
        kind: 'subtitle.site-unusable',
        level: 'attention',
        message: 'x.test cannot be automated',
        data: { action: 'disable-site', baseUrl: 'https://x.test', reason: 'bot wall' },
      });
      const id = new AttentionItems(ctx.db).list({ status: 'open' })[0]!.id;

      const res = await app.request(`/api/attention/${id}/${route}`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(new SiteProfiles(ctx.db).get('https://x.test')!.disabled_at === null).toBe(!expectDisabled);
    });

    it('accept on a site-unusable item marks it resolved and appends attention.accepted', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      ctx.events.append({
        kind: 'subtitle.site-unusable',
        level: 'attention',
        message: 'x.test cannot be automated',
        data: { action: 'disable-site', baseUrl: 'https://x.test', reason: 'bot wall' },
      });
      const attentionItems = new AttentionItems(ctx.db);
      const item = attentionItems.list({ status: 'open' })[0]!;

      const res = await app.request(`/api/attention/${item.id}/accept`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(attentionItems.get(item.id)!.status).toBe('resolved');
      expect(findEvent(ctx.events.list(), 'attention.accepted')).toMatchObject({
        data: { id: item.id, kind: 'subtitle.site-unusable', baseUrl: 'https://x.test' },
      });
    });

    it('dismiss on a site-unusable item also clears failCount for a clean retry', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      new SiteProfiles(ctx.db).upsert({ baseUrl: 'https://x.test' });
      new SiteProfiles(ctx.db).update('https://x.test', { failCount: 4 });
      ctx.events.append({
        kind: 'subtitle.site-unusable',
        level: 'attention',
        message: 'x.test cannot be automated',
        data: { action: 'disable-site', baseUrl: 'https://x.test', reason: 'bot wall' },
      });
      const item = new AttentionItems(ctx.db).list({ status: 'open' })[0]!;

      const res = await app.request(`/api/attention/${item.id}/dismiss`, { method: 'POST', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(new SiteProfiles(ctx.db).get('https://x.test')).toMatchObject({ disabled_at: null, disabled_reason: '', fail_count: 0 });
    });
  });

  describe('managed objects routes', () => {
    it('GET /api/managed-objects lists everything registered', async () => {
      const ctx = makeCtx();
      const managedObjects = new ManagedObjects(ctx.db);
      managedObjects.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });
      const app = createApp(ctx);

      const res: any = await (await app.request('/api/managed-objects')).json();
      expect(res.objects).toHaveLength(1);
      expect(res.objects[0]).toMatchObject({ arr_instance: 'sonarr', kind: 'tag', external_id: 3 });
    });

    it('DELETE /api/managed-objects/:id: 404 for an unknown row, otherwise safe-deletes via deleteManagedObject and removes the registry entry', async () => {
      const client = fakeArrClient({ tags: [{ id: 3, label: `${WARRDEN_TAG_PREFIX}group` }] });
      const ctx = ctxWithClient('sonarr', client);
      const managedObjects = new ManagedObjects(ctx.db);
      managedObjects.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });
      const rowId = managedObjects.list()[0]!.id;
      const app = createApp(ctx);

      expect((await app.request('/api/managed-objects/999999', { method: 'DELETE', headers: jsonHeaders })).status).toBe(404);

      const res = await app.request(`/api/managed-objects/${rowId}`, { method: 'DELETE', headers: jsonHeaders });
      expect(res.status).toBe(200);
      // `deletedInArr` round-trips deleteManagedObject's own computed result — the caller
      // needs to tell "the live Sonarr/Radarr object is gone too" from "registry-only".
      expect(await res.json()).toEqual({ ok: true, deletedInArr: true });
      expect(client.deleteTag).toHaveBeenCalledWith(3);
      expect(managedObjects.list()).toHaveLength(0);
    });

    it('DELETE /api/managed-objects/:id: deletedInArr is false when there is no live client for the instance — registry-only removal', async () => {
      const ctx = makeCtx({ clients: new Map() });
      const managedObjects = new ManagedObjects(ctx.db);
      managedObjects.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });
      const rowId = managedObjects.list()[0]!.id;
      const app = createApp(ctx);

      const res = await app.request(`/api/managed-objects/${rowId}`, { method: 'DELETE', headers: jsonHeaders });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deletedInArr: false });
    });

    it('DELETE /api/managed-objects/:id: a non-404 arr failure surfaces as 500, appends a managed.delete-failed warn event, and leaves the registry row in place', async () => {
      const client = fakeArrClient({
        profiles: [{ id: 9, name: `${WARRDEN_PROFILE_PREFIX}[Group]`, enabled: true, required: ['Group'], ignored: [], tags: [], indexerId: 0 }],
      });
      client.deleteReleaseProfile = vi.fn(async () => {
        throw new Error('arr is down');
      });
      const ctx = ctxWithClient('sonarr', client);
      const managedObjects = new ManagedObjects(ctx.db);
      managedObjects.insert({ arrInstance: 'sonarr', kind: 'release_profile', externalId: 9, name: `${WARRDEN_PROFILE_PREFIX}[Group]` });
      const rowId = managedObjects.list()[0]!.id;
      const app = createApp(ctx);

      const res = await app.request(`/api/managed-objects/${rowId}`, { method: 'DELETE', headers: jsonHeaders });

      expect(res.status).toBe(500);
      expect(managedObjects.list()).toHaveLength(1); // NOT dropped — still the retry pointer
      expect(findEvent(ctx.events.list({ level: 'warn' }), 'managed.delete-failed')).toMatchObject({
        data: { instance: 'sonarr', kind: 'release_profile', externalId: 9 },
      });
    });
  });

  describe('GET /api/jobs/:id placedFiles', () => {
    it('includes placedFiles for an ingest job and an empty array for a non-ingest job', async () => {
      const ctx = makeCtx();
      const ingestJobId = ctx.queue.enqueue({ pipeline: 'ingest', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
      new PlacedFiles(ctx.db).upsert({
        arrInstance: 'sonarr',
        targetKind: 'series',
        targetId: 42,
        kind: 'subtitle',
        placedPath: '/lib/Show - S01E01.en.srt',
        videoPath: '/lib/Show - S01E01.mkv',
        sourcePath: '/downloads/Show/sub.srt',
        jobId: ingestJobId,
      });
      const acquireJobId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 7, arrInstance: 'sonarr' }).id!;
      const app = createApp(ctx);

      const ingestDetail: any = await (await app.request(`/api/jobs/${ingestJobId}`)).json();
      expect(ingestDetail.placedFiles).toHaveLength(1);
      expect(ingestDetail.placedFiles[0]).toMatchObject({ placed_path: '/lib/Show - S01E01.en.srt' });

      const acquireDetail: any = await (await app.request(`/api/jobs/${acquireJobId}`)).json();
      expect(acquireDetail.placedFiles).toEqual([]);
    });
  });

  describe('POST /api/acquire hint', () => {
    it('forwards an optional hint into the enqueued job payload', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/api/acquire', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 7, hint: 'prefer 10bit' }),
      });
      expect(res.status).toBe(200);
      const job = ctx.queue.claim()!;
      expect(job.payload).toMatchObject({ hint: 'prefer 10bit' });
    });

    it('rejects a hint over 2000 characters with 400', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/api/acquire', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 7, hint: 'x'.repeat(2001) }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/subtitle', () => {
    it('enqueues a subtitle job for a known instance', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/api/subtitle', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42 }),
      });
      expect(res.status).toBe(200);
      const job = ctx.queue.claim()!;
      expect(job).toMatchObject({ pipeline: 'subtitle', arr_instance: 'sonarr', target_kind: 'series', target_id: 42 });
      expect(job.payload).toEqual({ source: 'manual' });
    });

    it('rejects an unknown instance with 400', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);

      const res = await app.request('/api/subtitle', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ arrInstance: 'radarr', targetKind: 'series', targetId: 42 }),
      });
      expect(res.status).toBe(400);
      expect(ctx.queue.claim()).toBeNull();
    });
  });

  describe('site profile routes', () => {
    function ctxWithSites(sites: { baseUrl: string }[]) {
      return makeCtx({ config: ConfigSchema.parse({ subtitle: { sites } }) });
    }

    it('GET /api/site-profiles merges config sites with stored rows', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const profiles = new SiteProfiles(ctx.db);
      profiles.upsert({ baseUrl: 'https://acg.rip' });
      profiles.update('https://acg.rip', { lastWorkingTier: 'curl', failCount: 3 });
      const app = createApp(ctx);

      const res: any = await (await app.request('/api/site-profiles')).json();
      expect(res.profiles).toHaveLength(1);
      expect(res.profiles[0]).toMatchObject({
        base_url: 'https://acg.rip',
        last_working_tier: 'curl',
        fail_count: 3,
      });
    });

    it('GET /api/site-profiles shows a configured site with no stored row as defaults', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const app = createApp(ctx);

      const res: any = await (await app.request('/api/site-profiles')).json();
      // No stored row -> SiteProfiles.upsert was never called, so the row has DB defaults.
      expect(res.profiles).toHaveLength(1);
      expect(res.profiles[0]).toMatchObject({
        base_url: 'https://acg.rip',
        fail_count: 0,
        last_working_tier: null,
        search_url_patterns: [],
        disabled_at: null,
        disabled_reason: '',
      });
    });

    it('PUT /api/site-profiles updates tier and search patterns (partial body)', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const app = createApp(ctx);

      const res = await app.request('/api/site-profiles', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({
          baseUrl: 'https://acg.rip',
          lastWorkingTier: 'chromium',
          searchUrlPatterns: ['https://acg.rip/?q={query}'],
        }),
      });
      expect(res.status).toBe(200);

      // The response body is the post-update row — the dashboard swaps its table row with it.
      const body = await res.json();
      expect(body).toMatchObject({ last_working_tier: 'chromium', search_url_patterns: ['https://acg.rip/?q={query}'] });

      const profile = new SiteProfiles(ctx.db).get('https://acg.rip')!;
      expect(profile.last_working_tier).toBe('chromium');
      expect(profile.search_url_patterns).toEqual(['https://acg.rip/?q={query}']);
      expect(profile.fail_count).toBe(0); // untouched by the partial body
    });

    it('PUT /api/site-profiles 404s for an unconfigured site', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const app = createApp(ctx);

      const res = await app.request('/api/site-profiles/nope', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ failCount: 0 }),
      });
      expect(res.status).toBe(404);
    });

    it('PUT /api/site-profiles rejects a bogus tier with 400', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const app = createApp(ctx);
      const profiles = new SiteProfiles(ctx.db);
      profiles.upsert({ baseUrl: 'https://acg.rip' });

      const res = await app.request('/api/site-profiles', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ baseUrl: 'https://acg.rip', lastWorkingTier: 'sneaker-net' }),
      });
      expect(res.status).toBe(400);
      expect(profiles.get('https://acg.rip')!.last_working_tier).toBeNull();
    });

    it('PUT /api/site-profiles accepts failCount 0 (reset failures)', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const profiles = new SiteProfiles(ctx.db);
      profiles.upsert({ baseUrl: 'https://acg.rip' });
      profiles.update('https://acg.rip', { failCount: 5, lastFailureAt: Date.now() });
      const app = createApp(ctx);

      const res = await app.request('/api/site-profiles', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ baseUrl: 'https://acg.rip', failCount: 0 }),
      });
      expect(res.status).toBe(200);
      // Resetting failures also clears last_failure_at so the site is not left in cooldown.
      expect(profiles.get('https://acg.rip')).toMatchObject({ fail_count: 0, last_failure_at: null });
    });

    it('PUT /api/site-profiles accepts disabledAt: null (the dashboard re-enable button) and clears the whole disabled state', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const profiles = new SiteProfiles(ctx.db);
      profiles.upsert({ baseUrl: 'https://acg.rip' });
      profiles.update('https://acg.rip', { disabledAt: Date.now(), disabledReason: 'unusable', failCount: 3, lastFailureAt: Date.now() });
      const app = createApp(ctx);

      const res = await app.request('/api/site-profiles', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ baseUrl: 'https://acg.rip', disabledAt: null }),
      });
      expect(res.status).toBe(200);
      expect(profiles.get('https://acg.rip')).toMatchObject({
        disabled_at: null,
        disabled_reason: '',
        fail_count: 0,
        last_failure_at: null,
      });
    });

    it('PUT /api/site-profiles rejects a non-null disabledAt — a site can only be disabled through the attention accept route', async () => {
      const ctx = ctxWithSites([{ baseUrl: 'https://acg.rip' }]);
      const profiles = new SiteProfiles(ctx.db);
      profiles.upsert({ baseUrl: 'https://acg.rip' });
      const app = createApp(ctx);

      const res = await app.request('/api/site-profiles', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ baseUrl: 'https://acg.rip', disabledAt: Date.now() }),
      });
      expect(res.status).toBe(400);
      expect(profiles.get('https://acg.rip')!.disabled_at).toBeNull();
    });
  });

  describe('GET /api/jobs/:id subtitleRuns', () => {
    it('includes subtitleRuns for a job that has runs, empty array otherwise', async () => {
      const ctx = makeCtx();
      const jobId = ctx.queue.enqueue({ pipeline: 'subtitle', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
      const runs = new SubtitleRuns(ctx.db);
      const runId = runs.start(jobId, 'acg.rip');
      runs.appendTranscript(runId, [{ ts: 1, tier: 'curl', action: 'search', detail: 'page' }]);
      runs.finish(runId, 'done');
      const app = createApp(ctx);

      const detail: any = await (await app.request(`/api/jobs/${jobId}`)).json();
      expect(detail.subtitleRuns).toHaveLength(1);
      expect(detail.subtitleRuns[0]).toMatchObject({ site: 'acg.rip', status: 'done' });
      expect(detail.subtitleRuns[0].transcript).toEqual([{ ts: 1, tier: 'curl', action: 'search', detail: 'page' }]);
    });
  });

  describe('trace routes', () => {
    it('lists traces newest first with job metadata', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      const { id } = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'movie', targetId: 1, arrInstance: 'radarr', payload: { title: 'Dune' } });
      ctx.trace.event({ jobId: id!, kind: 'trigger.manual', summary: 't' });
      const res = await app.request('/api/traces');
      const body = (await res.json()) as { traces: Record<string, unknown>[] };
      expect(res.status).toBe(200);
      expect(body.traces[0]).toMatchObject({
        jobId: id,
        targetTitle: 'Dune',
        entryCount: 1,
        // The target triple the debug view links same-target traces across phases with.
        arrInstance: 'radarr',
        targetKind: 'movie',
        targetId: 1,
      });
    });

    it('keeps a trace whose job row is gone, with a synthesized header', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      const { id } = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'movie', targetId: 1, arrInstance: 'radarr', payload: { title: 'Dune' } });
      ctx.trace.event({ jobId: id!, kind: 'trigger.manual', summary: 't' });
      ctx.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);

      const body = (await (await app.request('/api/traces')).json()) as { traces: Record<string, unknown>[] };
      // The trace is still readable, so dropping its row would shrink the window below
      // its own size for no gain.
      expect(body.traces).toHaveLength(1);
      expect(body.traces[0]).toMatchObject({
        jobId: id,
        targetTitle: `job #${id}`,
        pipeline: 'unknown',
        jobStatus: 'unknown',
        arrInstance: null,
        targetKind: null,
        targetId: null,
      });
    });

    it('reports the job status and whether it is terminal so a crashed mid-step entry reads as interrupted', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      const { id } = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'movie', targetId: 1, arrInstance: 'radarr' });
      ctx.trace.begin({ jobId: id!, kind: 'pipeline.step', summary: 'never finished' });

      const live = (await (await app.request(`/api/traces/${id}`)).json()) as Record<string, unknown>;
      expect(live).toMatchObject({ jobStatus: 'pending', jobTerminal: false });

      ctx.queue.claim();
      ctx.queue.fail(id!, 'boom', { maxAttempts: 1 });
      const dead = (await (await app.request(`/api/traces/${id}`)).json()) as Record<string, unknown>;
      expect(dead).toMatchObject({ jobStatus: 'failed', jobTerminal: true });
    });

    it('returns entries without payloads, then one payload on demand', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      const { id } = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'movie', targetId: 1, arrInstance: 'radarr' });
      ctx.trace.event({ jobId: id!, kind: 'trigger.manual', summary: 't', payload: () => ({ secret: 'body' }) });
      const list = (await (await app.request(`/api/traces/${id}`)).json()) as { entries: Record<string, unknown>[] };
      expect(list.entries[0].payload).toBeUndefined();
      expect(list.entries[0].hasPayload).toBe(true);
      // Same row shape as the list route (raw payload column dropped, hasPayload kept),
      // plus the parsed payload: the web type promises both.
      const one = (await (await app.request(`/api/traces/${id}/entries/0`)).json()) as Record<string, unknown>;
      expect(one.payload).toEqual({ secret: 'body' });
      expect(one).toMatchObject({ seq: 0, kind: 'trigger.manual', hasPayload: true });
    });

    it('404s on unknown trace and unknown entry', async () => {
      const app = createApp(makeCtx());
      expect((await app.request('/api/traces/999')).status).toBe(404);
      expect((await app.request('/api/traces/999/entries/0')).status).toBe(404);
    });

    it('overview reports debugEnabled from config', async () => {
      const ctx = makeCtx();
      ctx.config.debug.enabled = true;
      const res = (await (await createApp(ctx).request('/api/overview')).json()) as { debugEnabled: boolean };
      expect(res.debugEnabled).toBe(true);
    });
  });

  describe('GET /api/llm/models', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns the projected catalog shape', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'openai/gpt-5',
                  name: 'GPT-5',
                  context_length: 128_000,
                  pricing: { prompt: '0.000001', completion: '0.000002' },
                  top_provider: { context_length: 128_000 },
                  reasoning: null,
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      const res = await createApp(makeCtx()).request('/api/llm/models');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: unknown[]; stale: boolean; fetchedAt: number };
      expect(body.stale).toBe(false);
      expect(typeof body.fetchedAt).toBe('number');
      expect(body.models).toEqual([
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          supportedEfforts: [],
          mandatoryReasoning: false,
          reasoningCapable: false,
          contextLength: 128_000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ]);
    });

    it('404s when ctx.config is absent', async () => {
      const res = await createApp({}).request('/api/llm/models');
      expect(res.status).toBe(404);
    });

    it('responds 502 with the upstream error when the fetch fails and nothing is cached', async () => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('down', { status: 500 })));
      const res = await createApp(makeCtx()).request('/api/llm/models');
      expect(res.status).toBe(502);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
    });
  });
});
