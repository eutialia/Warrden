import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/reconcile/reconcile.js';
import { makeCtx, fakeArrClient } from './helpers.js';

const series = (id: number, tags: number[] = []) => ({ id, title: `S${id}`, year: 2024, tvdbId: id, tags, added: '' });

describe('reconcile', () => {
  it('bootstrap: marks existing library seen without enqueueing', async () => {
    const ctx = makeCtx({ clients: new Map([['sonarr', fakeArrClient({ series: [series(1), series(2)] })]]) });
    await reconcile(ctx);
    expect(ctx.queue.claim()).toBeNull();
    await reconcile(ctx); // second run, nothing changed
    expect(ctx.queue.claim()).toBeNull();
  });
  it('enqueues acquire for series added after bootstrap', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    await reconcile(ctx);
    client.series.push(series(9));
    await reconcile(ctx);
    expect(ctx.queue.claim()).toMatchObject({ pipeline: 'acquire', target_id: 9 });
  });
  it('gc removes orphaned warrden tag + profile from arr and registry', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const tag = client.pushTag('warrden-deadgroup');
    const prof = client.pushProfile({ name: 'warrden: [DeadGroup]', enabled: true, required: ['DeadGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const now = Date.now();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"DeadGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"DeadGroup"}',?)`)
      .run(tag.id, tag.label, now, prof.id, prof.name, now);
    await reconcile(ctx);
    expect(client.tags).toHaveLength(0);
    expect(client.profiles).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 0 });
  });
  it('gc leaves in-use pins alone', async () => {
    const client = fakeArrClient({ series: [] });
    const tag = client.pushTag('warrden-livegroup');
    client.series.push(series(1, [tag.id]));
    const prof = client.pushProfile({ name: 'warrden: [LiveGroup]', enabled: true, required: ['LiveGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const now = Date.now();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"LiveGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"LiveGroup"}',?)`)
      .run(tag.id, tag.label, now, prof.id, prof.name, now);
    await reconcile(ctx);
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
  });
});
