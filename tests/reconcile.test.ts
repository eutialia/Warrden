import { describe, it, expect, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { ManagedObjects } from '../src/db/managedObjects.js';
import { SyncState } from '../src/db/syncState.js';
import { pinReleaseGroup } from '../src/pipelines/acquire/pin.js';
import { reconcile } from '../src/reconcile/reconcile.js';
import {
  arrInstance,
  configWithArrs,
  makeCtx,
  fakeArrClient,
  historyRecord,
  seedManagedPin,
  seriesResource,
  movieResource,
  ctxWithClient,
  findEvent,
  hasEvent,
} from './helpers.js';

const series = (id: number, tags: number[] = []) => seriesResource({ id, title: `S${id}`, year: 2024, tvdbId: id, tags });
const movie = (id: number) => movieResource({ id, title: `M${id}`, year: 2024, tmdbId: id, hasFile: true });

describe('reconcile', () => {
  it('a sonarr-kind instance only fetches series, never movies (Sonarr has no /movie endpoint)', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await reconcile(ctx);

    expect(client.listMovies).not.toHaveBeenCalled();
  });

  it('skips an instance the current config no longer knows (renamed or removed by a save mid-pass) instead of failing its whole pass', async () => {
    // `ctx.clients` is the Map this pass started with; `ctx.config` is what a save left
    // behind. Without the skip, the unknown kind makes fetchInstanceResources probe BOTH list
    // endpoints, and the 404 from the one this arr doesn't implement takes the instance's
    // entire pass down as reconcile.failed.
    const stale = fakeArrClient({ series: [series(1)] });
    stale.listMovies = vi.fn(async () => {
      throw new Error('404 Radarr has no /movie on a Sonarr');
    });
    const live = fakeArrClient({ series: [series(2)] });
    const ctx = makeCtx({
      config: configWithArrs('sonarr'),
      clients: new Map([
        ['sonarr-old', stale],
        ['sonarr', live],
      ]),
    });

    await reconcile(ctx);

    expect(stale.listMovies).not.toHaveBeenCalled();
    expect(hasEvent(ctx.events.list(), 'reconcile.failed')).toBe(false);
    // The instance still in the config bootstrapped normally; the vanished one recorded
    // nothing at all, so a later pass under its new name starts clean.
    expect(new SyncState(ctx.db).read('bootstrap:sonarr')).toBe(true);
    expect(new SyncState(ctx.db).read('bootstrap:sonarr-old')).toBeUndefined();
  });

  it('bootstrap: marks existing library seen without enqueueing', async () => {
    const ctx = ctxWithClient('sonarr', fakeArrClient({ series: [series(1), series(2)] }), { config: configWithArrs('sonarr') });
    await reconcile(ctx);
    expect(ctx.queue.claim()).toBeNull();
    await reconcile(ctx); // second run, nothing changed
    expect(ctx.queue.claim()).toBeNull();
  });
  it('enqueues acquire for series added after bootstrap', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    await reconcile(ctx);
    client.series.push(series(9));
    await reconcile(ctx);
    expect(ctx.queue.claim()).toMatchObject({ pipeline: 'acquire', target_id: 9 });
  });
  it('does not double-enqueue a target that already has an acquire job (e.g. a webhook already ran it) before reconcile ever saw it — just catches `seen` up; a genuinely new target still enqueues', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    await reconcile(ctx); // bootstrap: series(1) already seen

    // A webhook adds series(2) and its acquire job runs to completion — all before
    // reconcile's next pass, so `seen:sonarr` doesn't know about id 2 yet.
    client.series.push(series(2));
    ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 2, arrInstance: 'sonarr', payload: { title: 'S2' } });
    ctx.queue.complete(ctx.queue.claim()!.id);

    // A genuinely new series with no job at all.
    client.series.push(series(3));

    await reconcile(ctx);

    // series(2) was not re-enqueued — the only claimable job is series(3)'s.
    expect(ctx.queue.claim()).toMatchObject({ target_id: 3 });
    expect(ctx.queue.claim()).toBeNull();

    const event = findEvent(ctx.events.list(), 'reconcile.missed-adds')!;
    expect(event.data).toMatchObject({ count: 1, ids: [3], alreadyHandled: 1 });
  });

  it('a gc() failure that escapes its own per-instance handling is caught as reconcile.gc-failed-global, and reconcile() still resolves', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const listSpy = vi.spyOn(ManagedObjects.prototype, 'list').mockImplementation(() => {
      throw new Error('managed_objects table is gone');
    });

    await expect(reconcile(ctx)).resolves.toBeUndefined();

    const failedEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-failed-global');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ level: 'warn' });
    expect(failedEvents[0]!.message).toContain('managed_objects table is gone');

    // The missed-adds phase, independent of GC, still ran normally.
    expect(hasEvent(ctx.events.list(), 'reconcile.bootstrapped')).toBe(true);

    listSpy.mockRestore();
  });

  // GC gives every registry row one full reconcile interval of "grace" before it's even a
  // deletion candidate (see the TOCTOU test below) — these fixtures backdate `created_at`
  // past that window (default interval 15 minutes) so they exercise deletion itself, not
  // the grace period.
  const wellPastGrace = () => Date.now() - 20 * 60_000;

  it('gc removes orphaned warrden tag + profile from arr and registry', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const tag = client.pushTag('warrden-deadgroup');
    const prof = client.pushProfile({ name: 'warrden: [DeadGroup]', enabled: true, required: ['DeadGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'DeadGroup', createdAt: wellPastGrace(), tag, profile: prof });
    await reconcile(ctx);
    expect(client.tags).toHaveLength(0);
    expect(client.profiles).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 0 });
    const gcEvent = findEvent(ctx.events.list(), 'reconcile.gc');
    expect(gcEvent!.data).toMatchObject({ deleted: true, profileDeleted: true, tagDeleted: true });
  });
  it('gc leaves in-use pins alone', async () => {
    const client = fakeArrClient({ series: [] });
    const tag = client.pushTag('warrden-livegroup');
    client.series.push(series(1, [tag.id]));
    const prof = client.pushProfile({ name: 'warrden: [LiveGroup]', enabled: true, required: ['LiveGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'LiveGroup', createdAt: wellPastGrace(), tag, profile: prof });
    await reconcile(ctx);
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
  });

  it('gc cleans a registry row whose tag/profile are already gone from the arr, without throwing, and still processes other rows', async () => {
    const client = fakeArrClient({ series: [series(1)] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const created = wellPastGrace();

    // "DeadGroup": registered in managed_objects, but nothing in the arr's live tag/profile
    // lists matches — e.g. deleted directly from Sonarr's UI, or a previous GC pass crashed
    // between the arr-side delete and this registry cleanup.
    seedManagedPin(ctx.db, {
      arrInstance: 'sonarr',
      group: 'DeadGroup',
      createdAt: created,
      tag: { id: 9001, label: 'warrden-deadgroup' },
      profile: { id: 9002, name: 'warrden: [DeadGroup]' },
    });

    // "OtherGroup": a real, still-orphaned pair — proves the stale row above didn't abort
    // the rest of this instance's GC.
    const tag = client.pushTag('warrden-othergroup');
    const prof = client.pushProfile({ name: 'warrden: [OtherGroup]', enabled: true, required: ['OtherGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'OtherGroup', createdAt: created, tag, profile: prof });

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
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const tag = client.pushTag('warrden-freshgroup');
    const prof = client.pushProfile({ name: 'warrden: [FreshGroup]', enabled: true, required: ['FreshGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    // freshly "registered" — well within the grace window
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'FreshGroup', createdAt: Date.now(), tag, profile: prof });

    await reconcile(ctx);

    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 2 });
  });

  it('gc never deletes a profile whose live name is not warrden-owned, and leaves its tag alone too (deleting it would cascade into the profile)', async () => {
    const client = fakeArrClient({ series: [series(1)] }); // untagged, so the tag looks orphaned
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const tag = client.pushTag('warrden-adopted');
    // Simulates pinReleaseGroup adopting a *user's* profile by tag membership (see its
    // matching comment) — its name was never "warrden: ...".
    const prof = client.pushProfile({ name: 'My Custom Profile', enabled: true, required: [], ignored: [], tags: [tag.id], indexerId: 0 });
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'Adopted', createdAt: wellPastGrace(), tag, profile: prof });

    await reconcile(ctx);

    expect(client.profiles).toHaveLength(1); // the user's profile survives in the arr
    expect(client.profiles[0]!.name).toBe('My Custom Profile');
    // The tag also survives — even though it *is* warrden-owned and would otherwise be
    // fair game — because Sonarr cascades a tag delete into stripping it from every
    // entity that references it, including this profile, which would leave the profile
    // with an empty tags list (matching every series in Sonarr) rather than none.
    expect(client.tags).toHaveLength(1);
    expect(client.tags[0]!.label).toBe('warrden-adopted');
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM managed_objects`).get()).toMatchObject({ n: 0 }); // both registry claims dropped
    const skipEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-skip-profile');
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]!.level).toBe('warn');
    // No tag-specific skip event fires here — the profile-skip event already covers why,
    // and the tag was never even considered for its own label check.
    expect(hasEvent(ctx.events.list(), 'reconcile.gc-skip-tag')).toBe(false);
    const gcEvent = findEvent(ctx.events.list(), 'reconcile.gc');
    expect(gcEvent!.data).toMatchObject({ deleted: false, profileDeleted: false, tagDeleted: false });
  });

  it('gc widens the tag-deletion guard beyond the one group-matched profile: a foreign profile carrying the tag but NOT group-matched still blocks the arr-side tag delete', async () => {
    const client = fakeArrClient({ series: [series(1)] }); // untagged, so the pin looks orphaned
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    const tag = client.pushTag('warrden-realgroup');
    const ownProfile = client.pushProfile({
      name: 'warrden: [RealGroup]',
      enabled: true,
      required: ['RealGroup'],
      ignored: [],
      tags: [tag.id],
      indexerId: 0,
    });
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'RealGroup', createdAt: wellPastGrace(), tag, profile: ownProfile });

    // A user's OWN profile — never registered by Warrden, and not the group-matched
    // registry profile above — that independently carries this exact tag id (e.g. added by
    // hand in Sonarr's own UI). The old guard only ever checked the ONE group-matched
    // profile's live name, so this foreign carrier slipped past it entirely.
    const foreignProfile = client.pushProfile({
      name: 'My Custom Profile',
      enabled: true,
      required: [],
      ignored: [],
      tags: [tag.id],
      indexerId: 0,
    });

    await reconcile(ctx);

    // The warrden-owned, group-matched profile is still deleted as usual.
    expect(client.profiles.some((p) => p.id === ownProfile.id)).toBe(false);
    // But the tag itself survives — deleting it would cascade into stripping it from the
    // foreign profile too, leaving it with an empty tags list (matching every series).
    expect(client.tags).toHaveLength(1);
    expect(client.tags[0]!.id).toBe(tag.id);
    expect(client.profiles.some((p) => p.id === foreignProfile.id)).toBe(true);

    const skipEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-skip-tag-foreign-profile');
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]!.level).toBe('warn');
    expect(skipEvents[0]!.data).toMatchObject({ foreignProfileIds: [foreignProfile.id] });
  });

  it('gc never deletes a tag from the arr whose live label is not warrden-owned — drops the registry row only, with a warn event', async () => {
    const client = fakeArrClient({ series: [series(1)] }); // untagged, so the registered tag looks unused
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    const tag = client.pushTag('user-tag'); // not warrden-owned, but somehow ended up registered
    seedManagedPin(ctx.db, { arrInstance: 'sonarr', group: 'Mystery', createdAt: wellPastGrace(), tag });

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
    const ctx = ctxWithClient('radarr', client, { config: configWithArrs('radarr') });
    const tag = client.pushTag('warrden-somegroup');
    const prof = client.pushProfile({ name: 'warrden: [SomeGroup]', enabled: true, required: ['SomeGroup'], ignored: [], tags: [tag.id], indexerId: 0 });
    seedManagedPin(ctx.db, { arrInstance: 'radarr', group: 'SomeGroup', createdAt: wellPastGrace(), tag, profile: prof });

    await reconcile(ctx);

    // Without the guard, an always-empty radarr series snapshot would make this look
    // orphaned and delete it — the guard means it's never even considered.
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 2 });
  });

  it('one instance failing during gc does not stop gc for other instances, and reconcile() still resolves', async () => {
    const created = wellPastGrace();

    const brokenClient = fakeArrClient({ series: [series(1)] });
    brokenClient.listReleaseProfiles = async () => {
      throw new Error('sonarr is down');
    };
    const brokenTag = brokenClient.pushTag('warrden-brokengroup');
    const brokenProf = brokenClient.pushProfile({
      name: 'warrden: [BrokenGroup]',
      enabled: true,
      required: ['BrokenGroup'],
      ignored: [],
      tags: [brokenTag.id],
      indexerId: 0,
    });

    const healthyClient = fakeArrClient({ series: [series(2)] });
    const healthyTag = healthyClient.pushTag('warrden-healthygroup');
    const healthyProf = healthyClient.pushProfile({
      name: 'warrden: [HealthyGroup]',
      enabled: true,
      required: ['HealthyGroup'],
      ignored: [],
      tags: [healthyTag.id],
      indexerId: 0,
    });

    const ctx = makeCtx({
      config: ConfigSchema.parse({
        arrs: [
          arrInstance({ name: 'broken', kind: 'sonarr', baseUrl: 'http://broken:0' }),
          arrInstance({ name: 'healthy', kind: 'sonarr', baseUrl: 'http://healthy:0' }),
        ],
      }),
      clients: new Map([
        ['broken', brokenClient],
        ['healthy', healthyClient],
      ]),
    });
    seedManagedPin(ctx.db, { arrInstance: 'broken', group: 'BrokenGroup', createdAt: created, tag: brokenTag, profile: brokenProf });
    seedManagedPin(ctx.db, { arrInstance: 'healthy', group: 'HealthyGroup', createdAt: created, tag: healthyTag, profile: healthyProf });

    await expect(reconcile(ctx)).resolves.toBeUndefined();

    const failedEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.gc-failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ level: 'warn', data: { instance: 'broken' } });
    expect(failedEvents[0]!.message).toContain('sonarr is down');

    // The broken instance's registry rows are untouched — GC never got past the fetch.
    expect(brokenClient.tags).toHaveLength(1);
    expect(brokenClient.profiles).toHaveLength(1);

    // The healthy instance's real orphan was still GC'd normally.
    expect(healthyClient.tags).toHaveLength(0);
    expect(healthyClient.profiles).toHaveLength(0);
  });

  it('re-pinning an old registry row refreshes created_at, so a stale-snapshot race does not gc it out from under a fresh pin', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 2024 })] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await pinReleaseGroup({ client, db: ctx.db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    // Backdate as if this pin were 3 days old — well past grace, and normally gc-eligible.
    ctx.db.prepare(`UPDATE managed_objects SET created_at = ?`).run(Date.now() - 3 * 24 * 60 * 60_000);

    // Re-pin: pinReleaseGroup re-attaches the tag to the series *and* re-registers it,
    // refreshing created_at via ManagedObjects' upsert. Strip the tag back off the series
    // afterward to simulate reconcile's series snapshot having been taken a moment before
    // this concurrent re-pin's attach actually landed — the exact TOCTOU race the grace
    // period exists to guard against.
    await pinReleaseGroup({ client, db: ctx.db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    client.series[0]!.tags = [];

    await reconcile(ctx);

    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM managed_objects').get()).toMatchObject({ n: 2 });
  });

  describe('ingestBackstop (missed import webhooks)', () => {
    it('a listRecentImports failure isolates to that instance via reconcile.failed; another instance still bootstraps, and GC still runs', async () => {
      const brokenClient = fakeArrClient({ series: [series(1)] });
      brokenClient.listRecentImports = async () => {
        throw new Error('sonarr history endpoint is down');
      };
      const healthyClient = fakeArrClient({ series: [series(2)] });
      const ctx = makeCtx({
        config: ConfigSchema.parse({
          arrs: [
            arrInstance({ name: 'broken', kind: 'sonarr', baseUrl: 'http://broken:0' }),
            arrInstance({ name: 'healthy', kind: 'sonarr', baseUrl: 'http://healthy:0' }),
          ],
        }),
        clients: new Map([
          ['broken', brokenClient],
          ['healthy', healthyClient],
        ]),
      });
      // Not mocked, just spied — asserting it was called is proof GC's per-instance loop
      // actually ran, independent of the per-instance loop above that "broken" failed in.
      const listSpy = vi.spyOn(ManagedObjects.prototype, 'list');

      await expect(reconcile(ctx)).resolves.toBeUndefined();

      const failedEvents = ctx.events.list().filter((e) => e.kind === 'reconcile.failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({ level: 'warn', data: { instance: 'broken' } });
      expect(failedEvents[0]!.message).toContain('sonarr history endpoint is down');

      // reconcileInstance's own missed-adds bootstrap ran fine before the throw (it's the
      // step immediately before ingestBackstop, in the same try) — only ingestBackstop's own
      // cursor write never happened, since it throws on its very first await.
      expect(new SyncState(ctx.db).read('bootstrap:broken')).toBe(true);
      expect(new SyncState(ctx.db).read('history:broken')).toBeUndefined();

      // The healthy instance, unaffected, still bootstrapped normally on both axes — proving
      // "broken"'s failure is isolated to its own instance, not the whole reconcile() loop.
      expect(ctx.events.list().some((e) => e.kind === 'reconcile.bootstrapped' && e.data?.instance === 'healthy')).toBe(true);
      expect(new SyncState(ctx.db).read('history:healthy')).toBeDefined();

      expect(listSpy).toHaveBeenCalled();
      listSpy.mockRestore();
    });

    it('bootstrap: records the history cursor at the current max id without enqueueing', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      client.listRecentImports = async () => [historyRecord({ id: 9, seriesId: 1 }), historyRecord({ id: 5, seriesId: 1 })];
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

      await reconcile(ctx);

      expect(ctx.queue.claim()).toBeNull(); // bootstrap enqueues nothing, on either axis
      expect(new SyncState(ctx.db).read('history:sonarr')).toBe(9);
      const event = findEvent(ctx.events.list(), 'reconcile.history-bootstrapped');
      expect(event).toBeDefined();
      expect(event!.data).toMatchObject({ instance: 'sonarr', cursor: 9 });
    });

    it.each([
      { kind: 'series' as const, field: 'seriesId' as const, arrName: 'sonarr' as const, seed: (c: ReturnType<typeof fakeArrClient>) => c.series.push(series(1), series(2)) },
      { kind: 'movie' as const, field: 'movieId' as const, arrName: 'radarr' as const, seed: (c: ReturnType<typeof fakeArrClient>) => c.movies.push(movie(1), movie(2)) },
    ])(
      'a later pass enqueues one ingest job per $kind import above the cursor and advances it to the new max, ignoring records at or below the old cursor',
      async ({ kind, field, arrName, seed }) => {
        const client = fakeArrClient();
        seed(client);
        const ctx = ctxWithClient(arrName, client, { config: configWithArrs(arrName) });
        client.listRecentImports = async () => [historyRecord({ id: 3, [field]: 1 })];
        await reconcile(ctx); // bootstrap: cursor -> 3

        client.listRecentImports = async () => [
          historyRecord({ id: 6, [field]: 2 }), // newest-first, per the real /history contract
          historyRecord({ id: 4, [field]: 1 }),
          historyRecord({ id: 3, [field]: 1 }), // at old cursor — ignored
        ];
        await reconcile(ctx);

        const jobs = ctx.queue.list().filter((j) => j.pipeline === 'ingest');
        expect(jobs).toHaveLength(2);
        expect(jobs.map((j) => j.target_id).sort()).toEqual([1, 2]);
        const target1Job = jobs.find((j) => j.target_id === 1)!;
        expect(target1Job).toMatchObject({
          arr_instance: arrName,
          target_kind: kind,
          payload: { source: 'reconcile' },
        });

        expect(new SyncState(ctx.db).read(`history:${arrName}`)).toBe(6);
        const event = findEvent(ctx.events.list(), 'reconcile.missed-imports');
        expect(event!.data).toMatchObject({ instance: arrName, targets: [`${kind}:2`, `${kind}:1`] });
        expect(event!.message).toContain('2');
      },
    );

    it('multiple new records for the same target collapse into a single enqueue', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      client.listRecentImports = async () => [historyRecord({ id: 1, seriesId: 1 })];
      await reconcile(ctx); // bootstrap: cursor -> 1

      client.listRecentImports = async () => [
        historyRecord({ id: 3, seriesId: 1 }),
        historyRecord({ id: 2, seriesId: 1 }),
      ];
      await reconcile(ctx);

      const jobs = ctx.queue.list().filter((j) => j.pipeline === 'ingest');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ target_kind: 'series', target_id: 1, payload: { source: 'reconcile' } });
    });

    it('a record with neither seriesId nor movieId is skipped', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      client.listRecentImports = async () => [historyRecord({ id: 1, seriesId: 1 })];
      await reconcile(ctx); // bootstrap: cursor -> 1

      client.listRecentImports = async () => [historyRecord({ id: 2 })]; // no seriesId/movieId
      await reconcile(ctx);

      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(0);
      expect(new SyncState(ctx.db).read('history:sonarr')).toBe(2); // cursor still advances past the skipped record
      expect(hasEvent(ctx.events.list(), 'reconcile.missed-imports')).toBe(false);
    });

    it('no records above the cursor leaves it unchanged and appends no missed-imports event', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      client.listRecentImports = async () => [historyRecord({ id: 3, seriesId: 1 })];
      await reconcile(ctx); // bootstrap: cursor -> 3

      await reconcile(ctx); // same records again — nothing new

      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(0);
      expect(hasEvent(ctx.events.list(), 'reconcile.missed-imports')).toBe(false);
      expect(new SyncState(ctx.db).read('history:sonarr')).toBe(3);
    });

    it('an empty history page never resets the cursor — a temporary empty response (arr restarting, a blip) must not be read the same as a real regression', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      client.listRecentImports = async () => [historyRecord({ id: 50, seriesId: 1 })];
      await reconcile(ctx); // bootstrap: cursor -> 50

      // An empty page proves nothing about the arr's real ids — maxId reduces to 0 here,
      // which is BELOW the tracked cursor (50), but that must never be read as a regression
      // (see ingestBackstop's own doc: "only possible when there's at least one live record").
      client.listRecentImports = async () => [];
      await reconcile(ctx);

      expect(new SyncState(ctx.db).read('history:sonarr')).toBe(50); // unchanged
      expect(hasEvent(ctx.events.list(), 'reconcile.history-cursor-reset')).toBe(false);
      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(0);
    });

    it('cursor regression (arr history ids restarted, e.g. its database was rebuilt/restored from an old backup): resets the cursor to the new max, warns, and enqueues nothing that pass — then resumes normally', async () => {
      const client = fakeArrClient({ series: [series(1)] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
      client.listRecentImports = async () => [historyRecord({ id: 50, seriesId: 1 })];
      await reconcile(ctx); // bootstrap: cursor -> 50

      // Every id the arr reports now is lower than the tracked cursor — impossible under
      // normal operation (ids only grow), the signature of a rebuilt/restored history table.
      client.listRecentImports = async () => [historyRecord({ id: 2, seriesId: 1 })];
      await reconcile(ctx);

      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(0);
      expect(new SyncState(ctx.db).read('history:sonarr')).toBe(2);
      const event = findEvent(ctx.events.list(), 'reconcile.history-cursor-reset');
      expect(event).toBeDefined();
      expect(event!.level).toBe('warn');
      expect(event!.data).toMatchObject({ instance: 'sonarr', cursor: 50, maxId: 2 });
      expect(hasEvent(ctx.events.list(), 'reconcile.missed-imports')).toBe(false);

      // Next pass resumes normally from the reset cursor: the id at it is ignored, a genuinely
      // new one above it enqueues.
      client.listRecentImports = async () => [
        historyRecord({ id: 3, seriesId: 1 }),
        historyRecord({ id: 2, seriesId: 1 }),
      ];
      await reconcile(ctx);
      const jobs = ctx.queue.list().filter((j) => j.pipeline === 'ingest');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ target_id: 1, payload: { source: 'reconcile' } });
    });
  });
});
