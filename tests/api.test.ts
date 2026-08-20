import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { ArrClient } from '../src/arr/client.js';
import * as register from '../src/arr/register.js';
import * as managedSync from '../src/managed/sync.js';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { AttentionItems } from '../src/db/attention.js';
import { ConfigSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/store.js';
import type { AppContext } from '../src/context.js';
import { makeCtx, configWithArrs, arrInstance, fakeArrClient, withFakeTime, ctxWithClient } from './helpers.js';

describe('dashboard api', () => {
  describe('GET /api/jobs, /api/jobs/:id', () => {
    it('lists jobs and fetches detail with its acquire records window', async () => {
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
        candidates: {
          seasonNumber: 1,
          kept: [
            {
              guid: 'release-guid-1',
              title: '[SubsPlease] Show S01',
              indexer: 'Nyaa',
              size: 1_000,
              seeders: 10,
              fullSeason: true,
              quality: { quality: { name: 'WEB 1080p' } },
              languages: [{ id: 1, name: 'Japanese' }],
            },
          ],
          dropped: [],
        },
      });
      const app = createApp(ctx);

      const list: any[] = await (await app.request('/api/jobs')).json();
      expect(list).toHaveLength(1);

      const detail: any = await (await app.request(`/api/jobs/${list[0].id}`)).json();
      expect(detail.job.pipeline).toBe('acquire');
      expect(detail.acquireRecords).toHaveLength(1);
      expect(detail.acquireRecords[0]).toMatchObject({
        status: 'grabbed',
        picked_guid: 'release-guid-1',
        release_group: 'SubsPlease',
        reasoning: 'best available candidate',
      });
      expect(detail.acquireRecords[0].picked).toEqual({
        title: '[SubsPlease] Show S01',
        indexer: 'Nyaa',
        size: 1_000,
        seeders: 10,
        quality: 'WEB 1080p',
        languages: ['Japanese'],
        shape: 'pack',
        seasonNumber: 1,
        forceGrab: false,
      });
      expect(detail).not.toHaveProperty('acquireRecord');

      expect((await app.request('/api/jobs/999')).status).toBe(404);
    });

    it('returns acquireRecords: [] when the job has no acquire record yet', async () => {
      const ctx = makeCtx();
      ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
      const app = createApp(ctx);

      const list: any[] = await (await app.request('/api/jobs')).json();
      const detail: any = await (await app.request(`/api/jobs/${list[0].id}`)).json();
      expect(detail.acquireRecords).toEqual([]);
    });

    it("bounds a terminal job's detail records to its own run window — an older job's detail does not pick up a later re-pick's record, and returns [] when its own run produced none", async () => {
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
        expect(detailA.acquireRecords).toEqual([]); // job B's later record must not leak into job A's detail

        vi.setSystemTime(5_000);
        ctx.queue.complete(ctx.queue.claim()!.id);
        const detailB: any = await (await app.request(`/api/jobs/${jobBId}`)).json();
        expect(detailB.acquireRecords).toHaveLength(1);
        expect(detailB.acquireRecords[0]).toMatchObject({ status: 'grabbed', picked_guid: 'g1' });
      });
    });

    it('returns every season row a multi-season job wrote in its own window', async () => {
      await withFakeTime(async () => {
        const ctx = makeCtx();
        const records = new AcquireRecords(ctx.db);
        const app = createApp(ctx);

        vi.setSystemTime(1_000);
        const jobId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
        vi.setSystemTime(2_000);
        records.insert({
          arrInstance: 'sonarr',
          targetKind: 'series',
          targetId: 42,
          status: 'grabbed',
          pickedGuid: 's1',
          candidates: { seasonNumber: 1, kept: [], dropped: [] },
        });
        vi.setSystemTime(3_000);
        records.insert({
          arrInstance: 'sonarr',
          targetKind: 'series',
          targetId: 42,
          status: 'none-viable',
          candidates: { seasonNumber: 2, kept: [], dropped: [] },
        });
        vi.setSystemTime(4_000);
        ctx.queue.complete(ctx.queue.claim()!.id);

        const detail: any = await (await app.request(`/api/jobs/${jobId}`)).json();
        expect(detail.acquireRecords).toHaveLength(2);
        // Newest first, matching listByTarget.
        expect(detail.acquireRecords.map((r: { candidates_json: { seasonNumber: number } }) => r.candidates_json.seasonNumber)).toEqual([
          2, 1,
        ]);
        expect(detail.acquireRecords.map((r: { status: string }) => r.status)).toEqual(['none-viable', 'grabbed']);
      });
    });

    it("omits relatedJobs: the drawer already has a target's sibling runs by construction", async () => {
      const ctx = makeCtx();
      const acquireId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
      ctx.queue.claim();
      ctx.queue.complete(acquireId);
      ctx.queue.enqueue({ pipeline: 'ingest', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
      const app = createApp(ctx);

      const detail: any = await (await app.request(`/api/jobs/${acquireId}`)).json();
      expect(detail).not.toHaveProperty('relatedJobs');
    });

    it('omits top-level acquireOutcome: the job row already carries it and nothing reads the duplicate', async () => {
      const ctx = makeCtx();
      const jobId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
      new AcquireRecords(ctx.db).insert({
        arrInstance: 'sonarr',
        targetKind: 'series',
        targetId: 42,
        status: 'grabbed',
      });
      const app = createApp(ctx);

      const detail: any = await (await app.request(`/api/jobs/${jobId}`)).json();
      expect(detail).not.toHaveProperty('acquireOutcome');
      expect(detail.job.acquireOutcome).toBe('grabbed');
    });

    it('includes open attention items for the job and excludes dismissed ones', async () => {
      const ctx = makeCtx();
      const jobId = ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' }).id!;
      const items = new AttentionItems(ctx.db);
      const open = items.open({ kind: 'acquire.none-viable', message: 'needs eyes', jobId, data: { n: 1 } });
      const dismissed = items.open({ kind: 'other', message: 'gone', jobId });
      items.setStatus(dismissed.id, 'dismissed');
      items.open({ kind: 'other-job', message: 'elsewhere', jobId: 999 });
      const app = createApp(ctx);

      const detail: any = await (await app.request(`/api/jobs/${jobId}`)).json();
      expect(detail.attention).toHaveLength(1);
      expect(detail.attention[0]).toMatchObject({
        id: open.id,
        kind: 'acquire.none-viable',
        message: 'needs eyes',
        status: 'open',
        job_id: jobId,
      });
    });

    it("returns the job's own events with the detail", async () => {
      const ctx = makeCtx();
      const { id } = ctx.queue.enqueue({ pipeline: 'subtitle', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
      ctx.events.append({
        kind: 'subtitle.complete',
        jobId: id!,
        message: 'Nothing missing, every video already has subtitles for zh-Hans',
        data: { counts: { missing: 0, placed: 0 } },
      });
      // Proves the query is scoped: a job-less event must not leak into any job's detail.
      ctx.events.append({ kind: 'unrelated.thing', message: 'no job attached' });
      const app = createApp(ctx);

      const detail: any = await (await app.request(`/api/jobs/${id}`)).json();

      expect(detail.events).toHaveLength(1);
      expect(detail.events[0]).toMatchObject({ kind: 'subtitle.complete', job_id: id });
    });
  });

  describe('GET/PUT /api/config', () => {
    // Webhook (re-)registration is the one thing a config save fires at a real arr over the
    // network, so it's stubbed for every test here — and spying (rather than a `vi.mock`
    // factory) lets a test assert whether a given save asked for it at all. `restoreMocks`
    // in vitest.config.ts puts the real one back after each test.
    const stubRegistration = (): ReturnType<typeof vi.spyOn> =>
      vi.spyOn(register, 'registerWebhooksInBackground').mockImplementation(() => {});
    let registerSpy: ReturnType<typeof stubRegistration>;
    beforeEach(() => {
      registerSpy = stubRegistration();
      vi.spyOn(managedSync, 'syncManagedObjects').mockResolvedValue(undefined);
    });

    it('serves llm keys and arr apiKeys verbatim on GET, and a round-tripped PUT saves them back unchanged', async () => {
      const ctx = makeCtx({ config: configWithArrs('sonarr') });
      ctx.config.llm.keys.openrouter = 'sk-secret';
      const app = createApp(ctx);

      const getRes = await app.request('/api/config');
      // Verbatim secrets in the body mean no cache anywhere may keep the response.
      expect(getRes.headers.get('cache-control')).toBe('no-store');
      const got: any = await getRes.json();
      expect(got.llm.keys.openrouter).toBe('sk-secret');
      expect(got.arrs[0].apiKey).toBe('test-api-key');

      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(ctx.config.llm.keys.openrouter).toBe('sk-secret');
      expect(ctx.config.arrs[0].apiKey).toBe('test-api-key');
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
      expect(onDisk.arrs[0]?.apiKey).toBe('test-api-key'); // the secret was persisted too, not just held in memory
    });

    it.each([
      { scenario: 'a blank model id', model: { provider: 'openrouter', model: '' } },
      { scenario: 'a provider this build no longer supports', model: { provider: 'claude-code', model: 'opus' } },
    ])('rejects an unusable llm.model on PUT rather than silently saving it as unset: $scenario', async ({ model }) => {
      // Boot degrades this to unset (a server that won't start can't serve the UI that would
      // fix it); a PUT does not, because the operator is watching and a green toast over a dropped
      // model selection is worse than a 400 naming the field.
      const ctx = makeCtx();
      const app = createApp(ctx);
      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ ...ctx.config, llm: { keys: {}, model } }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect(ctx.config.llm.model).toBeUndefined();
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

    it('a PUT immediately updates ctx.config so a later GET sees it', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const got: any = await (await app.request('/api/config')).json();
      got.reconcileIntervalMinutes = 30;
      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });
      // Nothing is deferred to a restart, so the response says exactly one thing.
      expect(await res.json()).toEqual({ saved: true });

      const after: any = await (await app.request('/api/config')).json();
      expect(after.reconcileIntervalMinutes).toBe(30);
    });

    it('a PUT rebuilds ctx.clients from the saved arrs — a newly added instance is live immediately', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const got: any = await (await app.request('/api/config')).json();
      got.arrs.push({ name: 'radarr', kind: 'radarr', baseUrl: 'http://radarr:0', apiKey: 'radarr-key' });

      const res = await app.request('/api/config', {
        method: 'PUT',
        body: JSON.stringify(got),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);

      expect([...ctx.clients.keys()]).toEqual(['sonarr', 'radarr']);
      // Real clients, rebuilt from the saved config — not the fake the ctx started with.
      expect(ctx.clients.get('radarr')).toBeInstanceOf(ArrClient);
      expect(ctx.clients.get('sonarr')).toBeInstanceOf(ArrClient);

      // A brand-new instance needs its webhook registering.
      expect(registerSpy).toHaveBeenCalledTimes(1);
    });

    it('re-registers webhooks when publicUrl changes, and not when an unrelated field does', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
      const app = createApp(ctx);
      const put = async (body: unknown): Promise<Response> =>
        app.request('/api/config', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

      const got: any = await (await app.request('/api/config')).json();
      got.eventRetentionDays = 21;
      await put(got);
      expect(registerSpy).not.toHaveBeenCalled();

      got.server.publicUrl = 'http://warrden.local:9797';
      await put(got);
      expect(registerSpy).toHaveBeenCalledTimes(1);
    });

    it('webhook/acquire "known instance" is driven by ctx.clients, not config.arrs — an instance in config with no client wired up is still unknown', async () => {
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

    it('removing an arr from config revokes webhook access on save — ctx.clients is rebuilt from it, not left behind', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
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
      expect(await webhookRes.json()).toEqual({ handled: false, reason: 'unknown instance' });
    });

    // A PUT body is the whole truth: whatever it says about secrets IS the new config, with
    // no server-side merge against what was stored.
    describe('PUT body is the whole config', () => {
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
        return ctx;
      }

      it.each([
        {
          label: 'omitting llm.keys entirely on PUT deletes every stored secret',
          mutate: (body: any) => {
            delete body.llm.keys;
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys).toEqual({});
          },
        },
        {
          label: 'omitting the stored llm key deletes it without touching the arr keys',
          mutate: (body: any) => {
            delete body.llm.keys.openrouter;
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBeUndefined();
            expect(ctx.config.arrs.map((a) => a.apiKey)).toEqual(['sonarr-key', 'radarr-key']);
          },
        },
        {
          label: 'rotating the llm key leaves the arr keys alone',
          mutate: (body: any) => {
            body.llm.keys.openrouter = 'sk-or-rotated';
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBe('sk-or-rotated');
            expect(ctx.config.arrs.map((a) => a.apiKey)).toEqual(['sonarr-key', 'radarr-key']);
          },
        },
        {
          label: 'a stored key survives a verbatim round trip, so GET output is safe to PUT back',
          mutate: () => {
            /* no-op: PUT the GET response back verbatim */
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.llm.keys.openrouter).toBe('sk-or-secret');
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
          label: 'renaming an arr instance saves cleanly, carrying its key over under the new name',
          mutate: (body: any) => {
            body.arrs[0].name = 'sonarr-renamed';
          },
          expectedStatus: 200,
          verify: (ctx: AppContext) => {
            expect(ctx.config.arrs.find((a) => a.name === 'sonarr-renamed')?.apiKey).toBe('sonarr-key');
            expect(ctx.config.arrs.some((a) => a.name === 'sonarr')).toBe(false);
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

  describe('GET /api/health/arrs', () => {
    it('probes every configured instance and reports each one, whatever its own answer is', async () => {
      const sonarr = fakeArrClient();
      const radarr = fakeArrClient();
      // Wired so sonarr's probe can only settle once radarr's has started: a route that
      // awaited the instances one at a time would deadlock here instead of answering.
      let releaseSonarr!: () => void;
      sonarr.ping = vi.fn(() => new Promise<'unauthorized'>((resolve) => (releaseSonarr = () => resolve('unauthorized'))));
      radarr.ping = vi.fn(async () => {
        releaseSonarr();
        return 'unreachable' as const;
      });
      const ctx = makeCtx({
        config: configWithArrs('sonarr', 'radarr'),
        clients: new Map([
          ['sonarr', sonarr],
          ['radarr', radarr],
        ]),
      });

      const res = await createApp(ctx).request('/api/health/arrs');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        checks: [
          { name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:0', status: 'unauthorized', webhook: 'unknown' },
          { name: 'radarr', kind: 'radarr', baseUrl: 'http://radarr:0', status: 'unreachable', webhook: 'unknown' },
        ],
      });
      expect(sonarr.ping).toHaveBeenCalledTimes(1);
      expect(radarr.ping).toHaveBeenCalledTimes(1);
    });

    it('returns an empty checks array when no arr instance is configured', async () => {
      const res = await createApp(makeCtx()).request('/api/health/arrs');

      expect(await res.json()).toEqual({ checks: [] });
    });

    it('reports webhook ok when the live Warrden notification already points at us', async () => {
      const sonarr = fakeArrClient({
        notifications: [
          {
            id: 7,
            name: 'Warrden',
            onSeriesAdd: true,
            onDownload: true,
            onUpgrade: true,
            fields: [{ name: 'url', value: 'http://localhost:9797/webhooks/sonarr' }],
          },
        ],
      });
      const ctx = makeCtx({
        config: configWithArrs('sonarr'),
        clients: new Map([['sonarr', sonarr]]),
      });

      const res = await createApp(ctx).request('/api/health/arrs');

      expect(await res.json()).toEqual({
        checks: [{ name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:0', status: 'ok', webhook: 'ok' }],
      });
    });
  });

  describe('POST /api/webhooks/register', () => {
    it('force-updates an already-healthy Warrden notification and returns updated', async () => {
      const sonarr = fakeArrClient({
        notifications: [
          {
            id: 7,
            name: 'Warrden',
            onSeriesAdd: true,
            onDownload: true,
            onUpgrade: true,
            fields: [{ name: 'url', value: 'http://localhost:9797/webhooks/sonarr' }],
          },
        ],
      });
      const ctx = ctxWithClient('sonarr', sonarr, { config: configWithArrs('sonarr') });

      const res = await createApp(ctx).request('/api/webhooks/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [{ instance: 'sonarr', status: 'updated', url: 'http://localhost:9797/webhooks/sonarr' }],
      });
      expect(sonarr.updateNotification).toHaveBeenCalledTimes(1);
    });

    it('does not run on GET /api/health/arrs', async () => {
      const sonarr = fakeArrClient({
        notifications: [
          {
            id: 7,
            name: 'Warrden',
            onSeriesAdd: true,
            onDownload: true,
            onUpgrade: true,
            fields: [{ name: 'url', value: 'http://localhost:9797/webhooks/sonarr' }],
          },
        ],
      });
      const ctx = ctxWithClient('sonarr', sonarr, { config: configWithArrs('sonarr') });

      await createApp(ctx).request('/api/health/arrs');

      expect(sonarr.updateNotification).not.toHaveBeenCalled();
      expect(sonarr.createNotification).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/acquire', () => {
    it('enqueues a manual acquire job for a known arr instance', async () => {
      const ctx = ctxWithClient('sonarr', fakeArrClient(), { config: configWithArrs('sonarr') });
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
