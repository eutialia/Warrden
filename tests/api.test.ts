import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { ConfigSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/store.js';
import type { AppContext } from '../src/context.js';
import { makeCtx, configWithArrs, arrInstance, fakeArrClient, withFakeTime } from './helpers.js';

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

    it("bounds a terminal job's detail record to its own run window — an older job's detail does not pick up a later re-pick's record, and returns null when its own run produced none", async () => {
      await withFakeTime(async () => {
        const ctx = makeCtx();
        const records = new AcquireRecords(ctx.db);
        const app = createApp(ctx);

        // Job A: enqueued, runs, produces no record of its own (crashed before recording,
        // say), then completes — a terminal job with nothing in its own window.
        vi.setSystemTime(1_000);
        const jobAId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
        vi.setSystemTime(2_000);
        ctx.queue.complete(ctx.queue.claim()!.id);

        // A manual re-pick creates job B, strictly after job A finished, which DOES grab
        // and record something.
        vi.setSystemTime(3_000);
        const jobBId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
        vi.setSystemTime(4_000);
        records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'grabbed', pickedGuid: 'g1' });

        const detailA: any = await (await app.request(`/api/jobs/${jobAId}`)).json();
        expect(detailA.acquireRecord).toBeNull(); // job B's later record must not leak into job A's detail

        vi.setSystemTime(5_000);
        ctx.queue.complete(ctx.queue.claim()!.id);
        const detailB: any = await (await app.request(`/api/jobs/${jobBId}`)).json();
        expect(detailB.acquireRecord).toMatchObject({ status: 'grabbed', picked_guid: 'g1' });
      });
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

    it('a PUT actually persists to disk — a fresh loadConfig() off the same dataDir sees it, not just ctx.config in memory', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const got: any = await (await app.request('/api/config')).json();
      got.reconcileIntervalMinutes = 42;

      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);

      const onDisk = loadConfig(ctx.dataDir);
      expect(onDisk.reconcileIntervalMinutes).toBe(42);
      expect(onDisk.arrs[0]?.apiKey).toBe('test-api-key'); // the sentinel-restored secret was persisted too, not just held in memory
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

    it('a PUT immediately updates ctx.config so a later GET sees it, without a restart', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
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
    });

    it('webhook/acquire "known instance" is driven by ctx.clients, not config.arrs — an instance already in config but not yet wired up (pre-restart) is still unknown', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') }); // in config.arrs, but no ArrClient registered yet
      const app = createApp(ctx);

      const webhookRes = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Test' }),
      });
      expect(await webhookRes.json()).toEqual({ handled: false, reason: 'unknown instance' });

      const acquireRes = await app.request('/api/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 1 }),
      });
      expect(acquireRes.status).toBe(400);
    });

    it('removing an arr from config does not retroactively revoke webhook access — ctx.clients (built once at startup) is untouched by a config PUT', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
      const app = createApp(ctx);
      const got: any = await (await app.request('/api/config')).json();

      const removed = { ...got, arrs: [] };
      await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(removed),
        headers: { 'content-type': 'application/json' },
      });

      const webhookRes = await app.request('/webhooks/sonarr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'Test' }),
      });
      // Still known: the client persists until a restart rebuilds ctx.clients from the new
      // config (arr connections are startup-only — see the README's config docs).
      expect(await webhookRes.json()).toEqual({ handled: true });
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
        {
          label: 'renaming an arr instance while its apiKey is still the sentinel is rejected with 400',
          mutate: (body: any) => {
            body.arrs[0].name = 'sonarr-renamed'; // dashboard round-tripped the sentinel, unaware of the rename
          },
          expectedStatus: 400,
          verify: (ctx: AppContext) => {
            // Nothing was saved: the original instance survives under its original name
            // and key, and no "sonarr-renamed" entry (holding the literal sentinel) exists.
            expect(ctx.config.arrs.find((a) => a.name === 'sonarr')?.apiKey).toBe('sonarr-key');
            expect(ctx.config.arrs.some((a) => a.name === 'sonarr-renamed')).toBe(false);
          },
        },
        {
          label: 'adding a brand-new arr instance with a real apiKey still succeeds',
          mutate: (body: any) => {
            body.arrs.push({ name: 'sonarr2', kind: 'sonarr', baseUrl: 'http://sonarr2:8989', apiKey: 'fresh-real-key' });
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.arrs.find((a) => a.name === 'sonarr2')?.apiKey).toBe('fresh-real-key');
          },
        },
        {
          label: 'duplicate arr instance names are rejected with 400',
          mutate: (body: any) => {
            // Both entries share the stored "sonarr" name, so restoreArrApiKey resolves
            // each sentinel apiKey fine on its own — the rejection has to come from the
            // schema's uniqueness check, not the secret-restore step.
            body.arrs.push({ ...body.arrs[0] });
          },
          expectedStatus: 400,
          verify: (ctx: AppContext) => {
            expect(ctx.config.arrs.filter((a) => a.name === 'sonarr')).toHaveLength(1);
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
      const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', fakeArrClient()]]) });
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
