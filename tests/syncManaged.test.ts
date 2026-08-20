import { describe, it, expect, vi } from 'vitest';
import { syncManagedObjects } from '../src/managed/sync.js';
import { ManagedObjects } from '../src/db/managedObjects.js';
import { configWithArrs, ctxWithClient, fakeArrClient, makeCtx, seedManagedPin } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';

function rows(ctx: ReturnType<typeof makeCtx>) {
  return new ManagedObjects(ctx.db).list().map((r) => ({
    arr: r.arr_instance,
    kind: r.kind,
    id: r.external_id,
    name: r.name,
    group: (r.data as { group?: string }).group,
  }));
}

describe('syncManagedObjects', () => {
  it('adopts live warrden tags and profiles that this db has never seen', async () => {
    const client = fakeArrClient();
    const tag = client.pushTag('warrden-trix');
    const profile = client.pushProfile({
      name: 'warrden: [Trix]',
      enabled: true,
      required: ['Trix'],
      ignored: [],
      indexerId: 0,
      tags: [tag.id],
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await syncManagedObjects(ctx);

    expect(client.createTag).not.toHaveBeenCalled();
    expect(client.createReleaseProfile).not.toHaveBeenCalled();
    expect(rows(ctx)).toEqual(
      expect.arrayContaining([
        { arr: 'sonarr', kind: 'tag', id: tag.id, name: 'warrden-trix', group: 'Trix' },
        { arr: 'sonarr', kind: 'release_profile', id: profile.id, name: 'warrden: [Trix]', group: 'Trix' },
      ]),
    );
    expect(rows(ctx)).toHaveLength(2);
  });

  it('recreates a registry profile the arr no longer has, and rebinds the row to the new id', async () => {
    const client = fakeArrClient();
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    seedManagedPin(ctx.db, {
      arrInstance: 'sonarr',
      group: 'Trix',
      createdAt: 1,
      tag: { id: 9, label: 'warrden-trix' },
      profile: { id: 99, name: 'warrden: [Trix]' },
    });

    await syncManagedObjects(ctx);

    expect(client.createTag).toHaveBeenCalledWith('warrden-trix');
    expect(client.createReleaseProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'warrden: [Trix]',
        required: ['Trix'],
        tags: [expect.any(Number)],
      }),
    );
    const created = client.profiles[0]!;
    expect(rows(ctx)).toEqual(
      expect.arrayContaining([
        { arr: 'sonarr', kind: 'tag', id: client.tags[0]!.id, name: 'warrden-trix', group: 'Trix' },
        { arr: 'sonarr', kind: 'release_profile', id: created.id, name: 'warrden: [Trix]', group: 'Trix' },
      ]),
    );
    expect(rows(ctx)).toHaveLength(2);
    expect(created.id).not.toBe(99);
  });

  it('rebinds a stale webhook row to the live Warrden notification without creating another', async () => {
    const client = fakeArrClient({
      notifications: [{ id: 4, name: 'Warrden', onDownload: true, onUpgrade: true, onSeriesAdd: true }],
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 2, name: 'Warrden' });

    await syncManagedObjects(ctx);

    expect(client.createNotification).not.toHaveBeenCalled();
    expect(rows(ctx)).toEqual([{ arr: 'sonarr', kind: 'notification', id: 4, name: 'Warrden', group: undefined }]);
  });

  it('leaves a non-warrden release profile on the arr out of the registry', async () => {
    const client = fakeArrClient();
    client.pushProfile({
      name: 'My quality profile',
      enabled: true,
      required: ['x'],
      ignored: [],
      indexerId: 0,
      tags: [],
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await syncManagedObjects(ctx);

    expect(rows(ctx)).toEqual([]);
    expect(client.createReleaseProfile).not.toHaveBeenCalled();
  });

  it('does not delete live arr objects, and continues when one instance throws', async () => {
    const broken = fakeArrClient();
    broken.listTags = async () => {
      throw new Error('ECONNREFUSED');
    };
    const healthy = fakeArrClient();
    const tag = healthy.pushTag('warrden-lolihouse');
    healthy.pushProfile({
      name: 'warrden: [LoliHouse]',
      enabled: true,
      required: ['LoliHouse'],
      ignored: [],
      indexerId: 0,
      tags: [tag.id],
    });
    const ctx = makeCtx({
      config: configWithArrs('sonarr', 'radarr'),
      clients: new Map<string, ArrApi>([
        ['sonarr', broken],
        ['radarr', healthy],
      ]),
    });

    await syncManagedObjects(ctx);

    expect(broken.deleteTag).not.toHaveBeenCalled();
    expect(broken.deleteReleaseProfile).not.toHaveBeenCalled();
    expect(healthy.deleteTag).not.toHaveBeenCalled();
    expect(rows(ctx).some((r) => r.arr === 'radarr' && r.kind === 'release_profile')).toBe(true);
    expect(ctx.events.list({ level: 'warn' }).some((e) => e.kind === 'managed.sync-failed')).toBe(true);
  });

  it('re-attaches a recreated tag onto the live warrden profile that lost it', async () => {
    const client = fakeArrClient();
    const profile = client.pushProfile({
      name: 'warrden: [Trix]',
      enabled: true,
      required: ['Trix'],
      ignored: [],
      indexerId: 0,
      tags: [],
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    seedManagedPin(ctx.db, {
      arrInstance: 'sonarr',
      group: 'Trix',
      createdAt: 1,
      tag: { id: 9, label: 'warrden-trix' },
      profile: { id: profile.id, name: 'warrden: [Trix]' },
    });

    await syncManagedObjects(ctx);

    const live = client.profiles.find((p) => p.id === profile.id)!;
    expect(live.tags).toHaveLength(1);
    expect(client.tags.some((t) => t.id === live.tags[0] && t.label === 'warrden-trix')).toBe(true);
  });

  it('serializes overlapping passes so two lists cannot both create the same profile', async () => {
    const client = fakeArrClient();
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    seedManagedPin(ctx.db, {
      arrInstance: 'sonarr',
      group: 'Trix',
      createdAt: 1,
      tag: { id: 9, label: 'warrden-trix' },
      profile: { id: 99, name: 'warrden: [Trix]' },
    });
    let listed = 0;
    let release: (() => void) | undefined;
    const originalList = client.listReleaseProfiles.bind(client);
    client.listReleaseProfiles = async () => {
      listed++;
      if (listed === 1) await new Promise<void>((resolve) => (release = resolve));
      return originalList();
    };

    const first = syncManagedObjects(ctx);
    await vi.waitFor(() => expect(listed).toBe(1));
    const second = syncManagedObjects(ctx);
    expect(listed).toBe(1);
    release!();
    await Promise.all([first, second]);
    expect(client.createReleaseProfile).toHaveBeenCalledTimes(1);
  });

  it('does not refresh created_at for a row that already matches the live id', async () => {
    const client = fakeArrClient();
    const tag = client.pushTag('warrden-trix');
    const profile = client.pushProfile({
      name: 'warrden: [Trix]',
      enabled: true,
      required: ['Trix'],
      ignored: [],
      indexerId: 0,
      tags: [tag.id],
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    seedManagedPin(ctx.db, {
      arrInstance: 'sonarr',
      group: 'Trix',
      createdAt: 1_000,
      tag: { id: tag.id, label: 'warrden-trix' },
      profile: { id: profile.id, name: 'warrden: [Trix]' },
    });

    await syncManagedObjects(ctx);

    const managed = new ManagedObjects(ctx.db).list();
    expect(managed.every((r) => r.created_at === 1_000)).toBe(true);
  });
});
