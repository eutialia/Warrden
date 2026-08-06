import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/app.js';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { ConfigSchema } from '../src/config/schema.js';
import type { AppContext } from '../src/context.js';
import { makeCtx, configWithArrs, arrInstance } from './helpers.js';

describe('dashboard api', () => {
  describe('GET /api/jobs, /api/jobs/:id', () => {
    it('lists jobs and fetches detail with its latest acquire record', async () => {
      const ctx = makeCtx();
      ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
      new AcquireRecords(ctx.db).insert({
        arrInstance: 'sonarr',
        targetKind: 'series',
        targetId: 42,
        status: 'grabbed',
        pickedGuid: 'release-guid-1',
        releaseGroup: 'SubsPlease',
        reasoning: 'best available candidate',
      });
      const app = createApp(ctx);

      const list: any[] = await (await app.request('/api/jobs')).json();
      expect(list).toHaveLength(1);

      const detail: any = await (await app.request(`/api/jobs/${list[0].id}`)).json();
      expect(detail.job.pipeline).toBe('acquire');
      expect(detail.acquireRecord).toMatchObject({
        status: 'grabbed',
        picked_guid: 'release-guid-1',
        release_group: 'SubsPlease',
        reasoning: 'best available candidate',
      });

      expect((await app.request('/api/jobs/999')).status).toBe(404);
    });

    it('returns acquireRecord: null when the job has no acquire record yet', async () => {
      const ctx = makeCtx();
      ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
      const app = createApp(ctx);

      const list: any[] = await (await app.request('/api/jobs')).json();
      const detail: any = await (await app.request(`/api/jobs/${list[0].id}`)).json();
      expect(detail.acquireRecord).toBeNull();
    });
  });

  describe('GET/PUT /api/config', () => {
    it('redacts llm keys and arr apiKeys on GET and preserves them through a PUT round-trip', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      ctx.config.llm.keys.openrouter = 'sk-secret';
      const app = createApp(ctx);

      const got: any = await (await app.request('/api/config')).json();
      expect(got.llm.keys.openrouter).toBe('•••');
      expect(got.arrs[0].apiKey).toBe('•••');

      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(ctx.config.llm.keys.openrouter).toBe('sk-secret'); // sentinel preserved the secret
      expect(ctx.config.arrs[0].apiKey).toBe('test-api-key'); // sentinel preserved the arr's key too
    });

    it('rejects invalid config with issues', async () => {
      const ctx = makeCtx();
      const app = createApp(ctx);
      const bad = { ...ctx.config, arrs: [{ name: '', kind: 'sonarr', baseUrl: 'x', apiKey: '' }] };
      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(bad),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
    });

    it('a PUT immediately updates ctx.config so a later GET (and the webhook route) see it', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const got: any = await (await app.request('/api/config')).json();
      got.reconcileIntervalMinutes = 30;
      await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });

      const after: any = await (await app.request('/api/config')).json();
      expect(after.reconcileIntervalMinutes).toBe(30);

      // The webhook route builds its `HandleWebhookCtx.config` fresh per request rather
      // than snapshotting it once at `createApp` time — an arr renamed away by that same
      // PUT is unknown to the very next webhook delivery, not just to future app instances.
      const renamed = { ...got, arrs: [] };
      await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(renamed),
        headers: { 'content-type': 'application/json' },
      });
      const webhookRes = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Test' }),
      });
      expect(await webhookRes.json()).toEqual({ handled: false, reason: 'unknown instance' });
    });

    describe('secret redact/restore round trip', () => {
      function seedCtx(): AppContext {
        const ctx = makeCtx({
          config: {
            ...ConfigSchema.parse({}),
            arrs: [
              arrInstance({ name: 'sonarr', kind: 'sonarr', apiKey: 'sonarr-key' }),
              arrInstance({ name: 'radarr', kind: 'radarr', baseUrl: 'http://radarr:0', apiKey: 'radarr-key' }),
            ],
          },
        });
        ctx.config.llm.keys.openrouter = 'sk-or-secret';
        ctx.config.llm.keys.anthropic = 'sk-an-secret';
        // openai is intentionally left unset
        return ctx;
      }

      it.each([
        {
          label: 'omitting llm.keys entirely on PUT keeps every stored secret',
          mutate: (body: any) => {
            delete body.llm.keys;
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBe('sk-or-secret');
            expect(ctx.config.llm.keys.anthropic).toBe('sk-an-secret');
          },
        },
        {
          label: 'rotating one key while the other stays the sentinel only changes the rotated one',
          mutate: (body: any) => {
            body.llm.keys.openrouter = 'sk-or-rotated';
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBe('sk-or-rotated');
            expect(ctx.config.llm.keys.anthropic).toBe('sk-an-secret');
          },
        },
        {
          label: 'a key that was never set stays unset through a round trip',
          mutate: () => {
            /* no-op: PUT the GET response back verbatim */
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openai).toBeUndefined();
          },
        },
        {
          label: 'each arr apiKey sentinel restores its own stored key, matched by name',
          mutate: () => {
            /* no-op: PUT the GET response back verbatim */
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.arrs.find((a) => a.name === 'sonarr')?.apiKey).toBe('sonarr-key');
            expect(ctx.config.arrs.find((a) => a.name === 'radarr')?.apiKey).toBe('radarr-key');
          },
        },
        {
          label: 'an empty-string llm key is rejected with 400, not saved as a blank credential',
          mutate: (body: any) => {
            body.llm.keys.openrouter = '';
          },
          expectedStatus: 400,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBe('sk-or-secret'); // unchanged after rejection
          },
        },
      ])('$label', async ({ mutate, expectedStatus, verify }) => {
        const ctx = seedCtx();
        const app = createApp(ctx);
        const got = await (await app.request('/api/config')).json();
        mutate(got);
        const res = await app.request('/api/config', {
          method: 'PUT',
          body: JSON.stringify(got),
          headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(expectedStatus);
        verify(ctx);
      });
    });
  });

  describe('POST /api/acquire', () => {
    it('enqueues a manual acquire job for a known arr instance', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const res = await app.request('/api/acquire', {
        method: 'POST',
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 7 }),
        headers: { 'content-type': 'application/json' },
      });
      expect((await res.json()).outcome).toBe('enqueued');
    });

    it('rejects an unknown arr instance with 400 and enqueues nothing', async () => {
      const ctx = makeCtx(); // default config: arrs: []
      const app = createApp(ctx);
      const res = await app.request('/api/acquire', {
        method: 'POST',
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 7 }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect(ctx.queue.claim()).toBeNull();
    });

    it('rejects an invalid body with 400', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const res = await app.request('/api/acquire', {
        method: 'POST',
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'episode', targetId: 7 }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
    });
  });
});
