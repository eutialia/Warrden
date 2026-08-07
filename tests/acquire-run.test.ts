import { describe, it, expect, vi } from 'vitest';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { runAcquireJob } from '../src/pipelines/acquire/run.js';
import { makeCtx, candidate, seriesResource, movieResource, FakeGenerator, fakeArrClient, enqueueAndClaim, ctxWithClient } from './helpers.js';

function setup(pick: object, cands = [candidate({ guid: 'g1', title: '[SubsPlease] Frieren S01 1080p' })]) {
  const client = fakeArrClient({
    series: [seriesResource({ id: 42, title: 'Frieren' })],
    releases: cands,
  });
  const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([pick]) });
  const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });
  return { ctx, client, job };
}

describe('runAcquireJob — single-season series (the common case)', () => {
  it('happy path: grabs, pins, records reasoning', async () => {
    const { ctx, client, job } = setup({ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'matches CHS policy' });
    await runAcquireJob(ctx, job);
    expect(client.grabbed).toEqual([{ guid: 'g1', indexerId: candidate({}).indexerId }]);
    expect(client.profiles[0].required).toEqual(['SubsPlease']);
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec).toMatchObject({ status: 'grabbed', picked_guid: 'g1', release_group: 'SubsPlease', source: 'webhook' });
    expect(rec.reasoning).toContain('CHS');
  });
  it('records the source from job.payload.source when the enqueuer set one, instead of the "webhook" default', async () => {
    const { ctx, job } = setup({ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' });
    job.payload.source = 'reconcile';
    await runAcquireJob(ctx, job);
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec.source).toBe('reconcile');
  });
  it('forwards job.payload.hint into the pick prompt when it is a non-empty string', async () => {
    const { ctx, job } = setup({ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' });
    job.payload.hint = 'prefer the 10bit encode this time';
    await runAcquireJob(ctx, job);
    const llm = ctx.llm as FakeGenerator;
    expect(llm.calls[0]!.prompt).toContain('prefer the 10bit encode this time');
  });
  it.each([
    { name: 'absent', hint: undefined },
    { name: 'empty string', hint: '' },
    { name: 'non-string', hint: 42 },
  ])('does not forward job.payload.hint when it is $name', async ({ hint }) => {
    const { ctx, job } = setup({ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' });
    job.payload.hint = hint;
    await runAcquireJob(ctx, job);
    const llm = ctx.llm as FakeGenerator;
    expect(llm.calls[0]!.prompt).not.toContain('Operator hint');
  });
  it('none-viable: no grab, attention event, record kept', async () => {
    const { ctx, client, job } = setup({ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'no CHS release yet' });
    await runAcquireJob(ctx, job);
    expect(client.grabbed).toHaveLength(0);
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(1);
    expect((ctx.db.prepare('SELECT status FROM acquire_records').get() as any).status).toBe('none-viable');
  });
  it('all candidates prefiltered: attention without llm call', async () => {
    const llm = new FakeGenerator([]);
    const { ctx, client, job } = setup({}, [candidate({ guid: 'g1', rejected: true, rejections: ['bad'] })]);
    ctx.llm = llm;
    await runAcquireJob(ctx, job);
    expect(llm.calls).toHaveLength(0);
    expect(client.grabbed).toHaveLength(0);
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(1);
  });

  it('a pin failure after a successful grab does not fail the job — it warns and still records "grabbed"', async () => {
    const { ctx, client, job } = setup({
      decision: 'pick',
      candidate: 1,
      releaseGroup: 'SubsPlease',
      confidence: 'high',
      reasoning: 'matches CHS policy',
    });
    client.createTag = vi.fn(async () => {
      throw new Error('arr is down');
    });

    await expect(runAcquireJob(ctx, job)).resolves.toBeUndefined();

    // The grab already happened — that's the part that must never be lost.
    expect(client.grabbed).toEqual([{ guid: 'g1', indexerId: candidate({}).indexerId }]);
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec.status).toBe('grabbed');
    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]!.message).toContain('arr is down');
  });

  it('a failure recording the outcome after a successful grab does not fail the job — it warns instead', async () => {
    const { ctx, client, job } = setup({
      decision: 'pick',
      candidate: 1,
      releaseGroup: 'SubsPlease',
      confidence: 'high',
      reasoning: 'matches CHS policy',
    });
    const insertSpy = vi.spyOn(AcquireRecords.prototype, 'insert').mockImplementation(() => {
      throw new Error('db is down');
    });

    await expect(runAcquireJob(ctx, job)).resolves.toBeUndefined();

    // The grab already happened — that's the part that must never be lost.
    expect(client.grabbed).toEqual([{ guid: 'g1', indexerId: candidate({}).indexerId }]);
    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]).toMatchObject({ kind: 'acquire.record-failed' });
    expect(warnEvents[0]!.message).toContain('db is down');

    insertSpy.mockRestore();
  });
});

describe('runAcquireJob — search params and pinning by target kind', () => {
  it('searches a series per monitored season ({seriesId, seasonNumber}), not the whole series at once', async () => {
    const client = fakeArrClient({
      series: [seriesResource({ id: 42, title: 'Frieren' })],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([{ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' }]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    expect(client.searchReleases).toHaveBeenCalledWith({ seriesId: 42, seasonNumber: 1 });
    expect(client.grabbed).toHaveLength(1);
    expect(client.tags).toHaveLength(1);
  });

  it('searches a movie with {movieId} and never pins', async () => {
    const client = fakeArrClient({
      movies: [movieResource({ title: 'A Movie', year: 2023 })],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([{ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' }]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'movie', targetId: 7, arrInstance: 'sonarr', payload: { title: 'X' } });

    await runAcquireJob(ctx, job);

    expect(client.searchReleases).toHaveBeenCalledWith({ movieId: 7 });
    expect(client.grabbed).toHaveLength(1);
    expect(client.tags).toHaveLength(0);
  });

  it('falls back to a listMovies() lookup for the title when the job was enqueued without one', async () => {
    const client = fakeArrClient({
      movies: [movieResource({ title: 'Looked Up Title', year: 2023 })],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([{ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'n/a' }]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'movie', targetId: 7, arrInstance: 'sonarr', payload: {} });

    await runAcquireJob(ctx, job);

    expect(client.listMovies).toHaveBeenCalled();
    expect(ctx.events.list({ level: 'attention' })[0]!.message).toContain('Looked Up Title');
  });

  it('falls back to a fresh getSeries() title when the job was enqueued without one', async () => {
    const client = fakeArrClient({
      series: [seriesResource({ id: 42, title: 'Looked Up Series' })],
      releases: [],
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: {} });

    await runAcquireJob(ctx, job);

    expect(ctx.events.list({ level: 'attention' })[0]!.message).toContain('Looked Up Series');
  });
});

describe('runAcquireJob — per-season series acquisition (C1)', () => {
  it('searches, picks, and grabs each monitored season independently, pinning the group only once (from the first successful pick)', async () => {
    const client = fakeArrClient({
      series: [
        seriesResource({
          id: 42,
          title: 'Frieren',
          seasons: [
            { seasonNumber: 0, monitored: true }, // specials — never acquired
            { seasonNumber: 1, monitored: true },
            { seasonNumber: 2, monitored: true },
            { seasonNumber: 3, monitored: false }, // unmonitored — skipped
          ],
        }),
      ],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([
        { decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'season 1 ok' },
        { decision: 'pick', candidate: 1, releaseGroup: 'OtherGroup', confidence: 'high', reasoning: 'season 2 ok' },
      ]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    expect(client.searchReleases).toHaveBeenCalledTimes(2);
    expect(client.searchReleases).toHaveBeenCalledWith({ seriesId: 42, seasonNumber: 1 });
    expect(client.searchReleases).toHaveBeenCalledWith({ seriesId: 42, seasonNumber: 2 });
    expect(client.searchReleases).not.toHaveBeenCalledWith({ seriesId: 42, seasonNumber: 0 });
    expect(client.searchReleases).not.toHaveBeenCalledWith({ seriesId: 42, seasonNumber: 3 });
    expect(client.grabbed).toHaveLength(2);

    // Pinned once, using the FIRST successful pick's group — not re-pinned for season 2's
    // different group.
    expect(client.createReleaseProfile).toHaveBeenCalledTimes(1);
    expect(client.profiles[0].required).toEqual(['SubsPlease']);

    // One acquire_records row per season, each tagged with its own season number.
    const records: any[] = ctx.db.prepare('SELECT * FROM acquire_records ORDER BY id').all();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.status === 'grabbed')).toBe(true);
    expect(records.map((r) => JSON.parse(r.candidates_json).seasonNumber)).toEqual([1, 2]);
  });

  it('records a per-season attention event naming the season for no-candidates/none-viable, and still processes the other seasons', async () => {
    const client = fakeArrClient({
      series: [
        seriesResource({
          id: 42,
          title: 'Frieren',
          seasons: [
            { seasonNumber: 1, monitored: true }, // no candidates
            { seasonNumber: 2, monitored: true }, // none viable
          ],
        }),
      ],
      releases: [candidate({ guid: 'g1' })],
    });
    // Season 1's search returns nothing (rejected by the arr); season 2's the default candidate.
    client.searchReleases = vi.fn(async (params: { seasonNumber?: number }) => {
      if (params.seasonNumber === 1) return [];
      return [candidate({ guid: 'g1' })];
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([{ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'nothing matches policy' }]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(2);
    expect(attentionEvents.some((e) => e.kind === 'acquire.no-candidates' && e.message.includes('Season 1'))).toBe(true);
    expect(attentionEvents.some((e) => e.kind === 'acquire.none-viable' && e.message.includes('Season 2'))).toBe(true);
    expect(client.grabbed).toHaveLength(0);

    const records: any[] = ctx.db.prepare('SELECT * FROM acquire_records ORDER BY id').all();
    expect(records.map((r) => r.status)).toEqual(['no-candidates', 'none-viable']);

    // outcomeForJob aggregates: no season grabbed, but a none-viable exists, so that wins
    // over the plainer no-candidates.
    expect(new AcquireRecords(ctx.db).outcomeForJob('sonarr', 'series', 42, job.created_at)).toBe('none-viable');
  });

  it('outcomeForJob reports "grabbed" for the job as soon as ANY season grabbed, even if a later season in the same run did not', async () => {
    const client = fakeArrClient({
      series: [
        seriesResource({
          id: 42,
          title: 'Frieren',
          seasons: [
            { seasonNumber: 1, monitored: true }, // grabbed
            { seasonNumber: 2, monitored: true }, // none viable — processed AFTER season 1
          ],
        }),
      ],
    });
    client.searchReleases = vi.fn(async (params: { seasonNumber?: number }) => {
      if (params.seasonNumber === 1) return [candidate({ guid: 'g1' })];
      return [candidate({ guid: 'g2' })];
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([
        { decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'season 1' },
        { decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'season 2 has nothing good' },
      ]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    // The LATEST row by itself (season 2's) is 'none-viable' — outcomeForJob must not stop there.
    const latest: any = ctx.db.prepare('SELECT status FROM acquire_records ORDER BY id DESC LIMIT 1').get();
    expect(latest.status).toBe('none-viable');
    expect(new AcquireRecords(ctx.db).outcomeForJob('sonarr', 'series', 42, job.created_at)).toBe('grabbed');
  });

  it('records no-candidates and an attention event when a series has no monitored seasons at all', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'Frieren', seasons: [{ seasonNumber: 1, monitored: false }] })] });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    expect(client.searchReleases).not.toHaveBeenCalled();
    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]!.message).toContain('No monitored seasons');
  });
});

describe('runAcquireJob — ctx.config.picking actually reaches prefilter (I6b)', () => {
  it('drops a candidate below the configured seederFloor (not arr-rejected) — the config threshold, not just an arr rejection, is what drives prefilter', async () => {
    const client = fakeArrClient({
      series: [seriesResource({ id: 42, title: 'Frieren' })],
      releases: [candidate({ guid: 'g1', seeders: 5, rejected: false })],
    });
    const llm = new FakeGenerator([]);
    const ctx = ctxWithClient('sonarr', client, { llm });
    ctx.config.picking.seederFloor = 100; // well above the candidate's 5 seeders
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    expect(llm.calls).toHaveLength(0); // dropped before ever reaching the LLM
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec.status).toBe('no-candidates');
    const dropped = JSON.parse(rec.candidates_json).dropped;
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain('seeders 5 below floor 100');
  });
});

describe('runAcquireJob — candidate cap (I11)', () => {
  it('caps the candidate list sent to the LLM (and persisted) to the top 30 by seeders, dropping the rest with a warn event', async () => {
    // Seeders start well above the default seederFloor (3) so every one of the 35 survives
    // prefilter — only the cap itself should be responsible for the drop this test checks.
    const many = Array.from({ length: 35 }, (_, i) => candidate({ guid: `g${i}`, seeders: 100 - i }));
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'Frieren' })], releases: many });
    const llm = new FakeGenerator([{ decision: 'pick', candidate: 1, releaseGroup: null, confidence: 'high', reasoning: 'top seeded' }]);
    const ctx = ctxWithClient('sonarr', client, { llm });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    await runAcquireJob(ctx, job);

    expect(llm.calls[0]!.prompt).not.toContain('#31');
    expect(client.grabbed).toEqual([{ guid: 'g0', indexerId: candidate({}).indexerId }]); // highest-seeded candidate

    const rec: any = ctx.db.prepare('SELECT candidates_json FROM acquire_records').get();
    const stored = JSON.parse(rec.candidates_json);
    expect(stored.kept).toHaveLength(30);
    expect(stored.dropped.filter((d: any) => d.reason.startsWith('capped:'))).toHaveLength(5);

    const capEvents = ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'acquire.candidates-capped');
    expect(capEvents).toHaveLength(1);
    expect(capEvents[0]!.message).toContain('dropped 5');
  });
});

describe('runAcquireJob — double-grab guard (I10)', () => {
  it('movie: skips the grab and completes cleanly when a crashed re-run already grabbed a release for this job', async () => {
    const client = fakeArrClient({
      movies: [movieResource({ title: 'A Movie', year: 2023 })],
      releases: [candidate({ guid: 'g1' })],
    });
    const llm = new FakeGenerator([]);
    const ctx = ctxWithClient('sonarr', client, { llm });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'movie', targetId: 7, arrInstance: 'sonarr', payload: { title: 'A Movie' } }); // status now 'running'; simulate a crash after grabbing but before completing

    new AcquireRecords(ctx.db).insert({
      arrInstance: 'sonarr',
      targetKind: 'movie',
      targetId: 7,
      status: 'grabbed',
      pickedGuid: 'g1',
      candidates: { kept: [], dropped: [] },
    });
    // Force the record's created_at strictly after the job's — a same-millisecond
    // Date.now() collision would otherwise make this test flaky.
    ctx.db.prepare('UPDATE acquire_records SET created_at = ?').run(job.created_at + 1000);
    ctx.queue.reclaimAbandoned(); // process "restarts"; job goes back to pending
    const reclaimedJob = ctx.queue.claim()!;

    await runAcquireJob(ctx, reclaimedJob);

    expect(client.grabbed).toHaveLength(0); // never re-grabbed
    expect(llm.calls).toHaveLength(0); // didn't even search/pick again
    const skipEvents = ctx.events.list().filter((e) => e.kind === 'acquire.skip-already-grabbed');
    expect(skipEvents).toHaveLength(1);
  });

  it('series: skips only the season(s) a crashed re-run already grabbed, and still runs the rest', async () => {
    const client = fakeArrClient({
      series: [
        seriesResource({
          id: 42,
          title: 'Frieren',
          seasons: [
            { seasonNumber: 1, monitored: true }, // already grabbed by the crashed run
            { seasonNumber: 2, monitored: true }, // still needs a pick
          ],
        }),
      ],
    });
    client.searchReleases = vi.fn(async (params: { seasonNumber?: number }) => {
      if (params.seasonNumber === 1) throw new Error('season 1 should never be searched again');
      return [candidate({ guid: 'g2' })];
    });
    const ctx = ctxWithClient('sonarr', client, { llm: new FakeGenerator([{ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'season 2' }]) });
    const job = enqueueAndClaim(ctx, { pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });

    new AcquireRecords(ctx.db).insert({
      arrInstance: 'sonarr',
      targetKind: 'series',
      targetId: 42,
      status: 'grabbed',
      pickedGuid: 'g1',
      candidates: { seasonNumber: 1, kept: [], dropped: [] },
    });
    ctx.db.prepare('UPDATE acquire_records SET created_at = ?').run(job.created_at + 1000);
    ctx.queue.reclaimAbandoned();
    const reclaimedJob = ctx.queue.claim()!;

    await runAcquireJob(ctx, reclaimedJob);

    expect(client.grabbed).toEqual([{ guid: 'g2', indexerId: candidate({}).indexerId }]); // only season 2
    const skipEvents = ctx.events.list().filter((e) => e.kind === 'acquire.skip-already-grabbed');
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]!.message).toContain('Season 1');
  });
});
