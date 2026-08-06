import { describe, it, expect, vi } from 'vitest';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { runAcquireJob } from '../src/pipelines/acquire/run.js';
import { makeCtx, candidate, FakeGenerator, fakeArrClient } from './helpers.js';

function setup(pick: object, cands = [candidate({ guid: 'g1', title: '[SubsPlease] Frieren S01 1080p' })]) {
  const client = fakeArrClient({
    series: [{ id: 42, title: 'Frieren', year: 2023, tvdbId: 1, tags: [], added: '' }],
    releases: cands,
  });
  const ctx = makeCtx({ llm: new FakeGenerator([pick]), clients: new Map([['sonarr', client]]) });
  ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr', payload: { title: 'Frieren' } });
  return { ctx, client, job: ctx.queue.claim()! };
}

describe('runAcquireJob', () => {
  it('happy path: grabs, pins, records reasoning', async () => {
    const { ctx, client, job } = setup({ decision: 'pick', guid: 'g1', releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'matches CHS policy' });
    await runAcquireJob(ctx, job);
    expect(client.grabbed).toEqual([{ guid: 'g1', indexerId: candidate({}).indexerId }]);
    expect(client.profiles[0].required).toEqual(['SubsPlease']);
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec).toMatchObject({ status: 'grabbed', picked_guid: 'g1', release_group: 'SubsPlease', source: 'webhook' });
    expect(rec.reasoning).toContain('CHS');
  });
  it('records the source from job.payload.source when the enqueuer set one, instead of the "webhook" default', async () => {
    const { ctx, job } = setup({ decision: 'pick', guid: 'g1', releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' });
    job.payload.source = 'reconcile';
    await runAcquireJob(ctx, job);
    const rec: any = ctx.db.prepare('SELECT * FROM acquire_records').get();
    expect(rec.source).toBe('reconcile');
  });
  it('none-viable: no grab, attention event, record kept', async () => {
    const { ctx, client, job } = setup({ decision: 'none', reasoning: 'no CHS release yet' });
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
      guid: 'g1',
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
      guid: 'g1',
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
  it.each([
    { targetKind: 'series' as const, targetId: 42, expectedParams: { seriesId: 42 } },
    { targetKind: 'movie' as const, targetId: 7, expectedParams: { movieId: 7 } },
  ])('searches with $expectedParams for a $targetKind job, and only pins for series', async ({ targetKind, targetId, expectedParams }) => {
    const client = fakeArrClient({
      series: targetKind === 'series' ? [{ id: targetId, title: 'Frieren', year: 2023, tvdbId: 1, tags: [], added: '' }] : [],
      movies: targetKind === 'movie' ? [{ id: targetId, title: 'A Movie', year: 2023, tmdbId: 1, added: '', hasFile: false }] : [],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = makeCtx({
      llm: new FakeGenerator([{ decision: 'pick', guid: 'g1', releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'ok' }]),
      clients: new Map([['sonarr', client]]),
    });
    ctx.queue.enqueue({ pipeline: 'acquire', targetKind, targetId, arrInstance: 'sonarr', payload: { title: 'X' } });
    const job = ctx.queue.claim()!;

    await runAcquireJob(ctx, job);

    expect(client.searchReleases).toHaveBeenCalledWith(expectedParams);
    expect(client.grabbed).toHaveLength(1);
    expect(client.tags).toHaveLength(targetKind === 'series' ? 1 : 0);
  });

  it('falls back to a listMovies() lookup for the title when the job was enqueued without one', async () => {
    const client = fakeArrClient({
      movies: [{ id: 7, title: 'Looked Up Title', year: 2023, tmdbId: 1, added: '', hasFile: false }],
      releases: [candidate({ guid: 'g1' })],
    });
    const ctx = makeCtx({
      llm: new FakeGenerator([{ decision: 'none', reasoning: 'n/a' }]),
      clients: new Map([['sonarr', client]]),
    });
    ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'movie', targetId: 7, arrInstance: 'sonarr', payload: {} });
    const job = ctx.queue.claim()!;

    await runAcquireJob(ctx, job);

    expect(client.listMovies).toHaveBeenCalled();
    expect(ctx.events.list({ level: 'attention' })[0]!.message).toContain('Looked Up Title');
  });
});
