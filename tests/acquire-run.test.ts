import { describe, it, expect } from 'vitest';
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
    expect(rec).toMatchObject({ status: 'grabbed', picked_guid: 'g1', release_group: 'SubsPlease' });
    expect(rec.reasoning).toContain('CHS');
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
});
