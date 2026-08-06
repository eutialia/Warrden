import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/reconcile/reconcile.js';
import { configWithArrs, makeCtx, fakeArrClient } from './helpers.js';

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
  // GC gives every registry row one full reconcile interval of "grace" before it's even a
  // deletion candidate (see the TOCTOU test below) — these fixtures backdate `created_at`
  // past that window (default interval 15 minutes) so they exercise deletion itself, not
  // the grace period.
  const wellPastGrace = () => Date.now() - 20 * 60_000;

  it('gc removes orphaned warrden tag + profile from arr and registry', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const tag = client.pushTag('warrden-deadgroup');
    const prof = client.pushProfile({ name: 'warrden: [DeadGroup]', enabled: true, required: ['DeadGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const created = wellPastGrace();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"DeadGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"DeadGroup"}',?)`)
      .run(tag.id, tag.label, created, prof.id, prof.name, created);
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
    const created = wellPastGrace();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"LiveGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"LiveGroup"}',?)`)
      .run(tag.id, tag.label, created, prof.id, prof.name, created);
    await reconcile(ctx);
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
  });

  it('gc cleans a registry row whose tag/profile are already gone from the arr, without throwing, and still processes other rows', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const created = wellPastGrace();

    // "DeadGroup": registered in managed_objects, but nothing in the arr's live tag/profile
    // lists matches — e.g. deleted directly from Sonarr's UI, or a previous GC pass crashed
    // between the arr-side delete and this registry cleanup.
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',9001,'warrden-deadgroup','{"group":"DeadGroup"}',?),
      ('sonarr','release_profile',9002,'warrden: [DeadGroup]','{"group":"DeadGroup"}',?)`).run(created, created);

    // "OtherGroup": a real, still-orphaned pair — proves the stale row above didn't abort
    // the rest of this instance's GC.
    const tag = client.pushTag('warrden-othergroup');
    const prof = client.pushProfile({ name: 'warrden: [OtherGroup]', enabled: true, required: ['OtherGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"OtherGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"OtherGroup"}',?)`)
      .run(tag.id, tag.label, created, prof.id, prof.name, created);

    await expect(reconcile(ctx)).resolves.toBeUndefined();

    expect(client.tags).toHaveLength(0); // OtherGroup's real tag was actually deleted
    expect(client.profiles).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 0 }); // both registry rows cleaned
    expect(ctx.events.list().some((e) => e.level === 'warn' && e.kind === 'reconcile.gc-row-failed')).toBe(false);
  });

  it('gc gives a freshly-registered pin one reconcile interval of grace before considering it for deletion', async () => {
    // series(1) carries no tags, so this pin would look orphaned against this snapshot —
    // exactly what a concurrent acquire job's pin landing mid-pass would look like too.
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const tag = client.pushTag('warrden-freshgroup');
    const prof = client.pushProfile({ name: 'warrden: [FreshGroup]', enabled: true, required: ['FreshGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const now = Date.now(); // freshly "registered" — well within the grace window
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"FreshGroup"}',?), ('sonarr','release_profile',?,?,'{"group":"FreshGroup"}',?)`)
      .run(tag.id, tag.label, now, prof.id, prof.name, now);

    await reconcile(ctx);

    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 2 });
  });

  it('gc never deletes a profile whose live name is not warrden-owned — drops the registry row only, with a warn event', async () => {
    const client = fakeArrClient({ series: [series(1)] }); // untagged, so the tag looks orphaned
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const tag = client.pushTag('warrden-adopted');
    // Simulates pinReleaseGroup adopting a *user's* profile by tag membership (see its
    // matching comment) — its name was never "warrden: ...".
    const prof = client.pushProfile({ name: 'My Custom Profile', enabled: true, required: [], ignored: [], tags: [tag.id], indexerId: 0 });
    const created = wellPastGrace();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('sonarr','tag',?,?,'{"group":"Adopted"}',?), ('sonarr','release_profile',?,?,'{"group":"Adopted"}',?)`)
      .run(tag.id, tag.label, created, prof.id, prof.name, created);

    await reconcile(ctx);

    expect(client.profiles).toHaveLength(1); // the user's profile survives in the arr
    expect(client.profiles[0]!.name).toBe('My Custom Profile');
    expect(client.tags).toHaveLength(0); // the warrden-owned tag itself is still safe to remove
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM managed_objects`).get()).toMatchObject({ n: 0 }); // both registry claims dropped
    const skipEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-skip-profile');
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]!.level).toBe('warn');
  });

  it('gc never deletes a tag from the arr whose live label is not warrden-owned — drops the registry row only, with a warn event', async () => {
    const client = fakeArrClient({ series: [series(1)] }); // untagged, so the registered tag looks unused
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const tag = client.pushTag('user-tag'); // not warrden-owned, but somehow ended up registered
    const created = wellPastGrace();
    ctx.db
      .prepare(
        `INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES ('sonarr','tag',?,?,'{"group":"Mystery"}',?)`,
      )
      .run(tag.id, tag.label, created);

    await reconcile(ctx);

    expect(client.tags).toHaveLength(1); // the tag survives in the arr
    expect(client.tags[0]!.label).toBe('user-tag');
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM managed_objects`).get()).toMatchObject({ n: 0 }); // registry claim dropped
    const skipEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-skip-tag');
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]!.level).toBe('warn');
  });

  it('skips tag/profile gc entirely for a radarr-kind instance (pinning is series-only, so its series snapshot is always empty)', async () => {
    const client = fakeArrClient({ movies: [] });
    const ctx = makeCtx({ config: configWithArrs('radarr'), clients: new Map([['radarr', client]]) });
    const tag = client.pushTag('warrden-somegroup');
    const prof = client.pushProfile({ name: 'warrden: [SomeGroup]', enabled: true, required: ['SomeGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const created = wellPastGrace();
    ctx.db.prepare(`INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES
      ('radarr','tag',?,?,'{"group":"SomeGroup"}',?), ('radarr','release_profile',?,?,'{"group":"SomeGroup"}',?)`)
      .run(tag.id, tag.label, created, prof.id, prof.name, created);

    await reconcile(ctx);

    // Without the guard, an always-empty radarr series snapshot would make this look
    // orphaned and delete it — the guard means it's never even considered.
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 2 });
  });
});
