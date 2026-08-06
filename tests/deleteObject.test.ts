import { describe, it, expect } from 'vitest';
import { deleteManagedObject } from '../src/managed/deleteObject.js';
import { ManagedObjects, type ManagedObjectKind } from '../src/db/managedObjects.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX } from '../src/pipelines/acquire/pin.js';
import { makeCtx, fakeArrClient } from './helpers.js';

/** Seeds a `managed_objects` row via the real `ManagedObjects.insert` (so it round-trips
 * through the same upsert path production code uses) and reads it straight back — the
 * `ManagedObjectRow` `deleteManagedObject` actually takes as input. */
function seedRow(managedObjects: ManagedObjects, opts: { arrInstance: string; kind: ManagedObjectKind; externalId: number; name?: string }) {
  managedObjects.insert({ arrInstance: opts.arrInstance, kind: opts.kind, externalId: opts.externalId, name: opts.name });
  const row = managedObjects.list({ arrInstance: opts.arrInstance, kind: opts.kind }).find((r) => r.external_id === opts.externalId);
  if (!row) throw new Error('seedRow: row did not round-trip');
  return row;
}

describe('deleteManagedObject', () => {
  it('deletes the registry row and appends a managed.deleted info event, regardless of the arr-side outcome', async () => {
    const ctx = makeCtx({ clients: new Map([['sonarr', fakeArrClient()]]) });
    const managedObjects = new ManagedObjects(ctx.db);
    const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'notification', externalId: 5, name: 'warrden-webhook' });

    await deleteManagedObject(ctx, row);

    expect(managedObjects.list()).toHaveLength(0);
    const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
    expect(deletedEvent).toMatchObject({ data: { instance: 'sonarr', kind: 'notification', externalId: 5 } });
  });

  describe('notification', () => {
    it('deletes it in the arr and marks deletedInArr true', async () => {
      const client = fakeArrClient({ notifications: [{ id: 5, name: 'warrden-webhook' }] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'notification', externalId: 5, name: 'warrden-webhook' });

      await deleteManagedObject(ctx, row);

      expect(client.deleteNotification).toHaveBeenCalledWith(5);
      const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
      expect(deletedEvent!.data).toMatchObject({ deletedInArr: true });
    });

    it('treats a 404 from deleteNotification as already-gone, not a failure — deletedInArr false, no warn', async () => {
      const client = fakeArrClient();
      const { ArrApiError } = await import('../src/arr/client.js');
      client.deleteNotification = (async () => {
        throw new ArrApiError('DELETE', '/notification/5', 404, 'gone');
      }) as typeof client.deleteNotification;
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'notification', externalId: 5, name: 'warrden-webhook' });

      await deleteManagedObject(ctx, row);

      expect(managedObjects.list()).toHaveLength(0);
      expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
      const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
      expect(deletedEvent!.data).toMatchObject({ deletedInArr: false });
    });

    it('propagates a non-404 ArrApiError rather than swallowing it', async () => {
      const client = fakeArrClient();
      const { ArrApiError } = await import('../src/arr/client.js');
      client.deleteNotification = (async () => {
        throw new ArrApiError('DELETE', '/notification/5', 500, 'boom');
      }) as typeof client.deleteNotification;
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'notification', externalId: 5, name: 'warrden-webhook' });

      await expect(deleteManagedObject(ctx, row)).rejects.toThrow('boom');
      // The registry row must not have been dropped on a genuine failure.
      expect(managedObjects.list()).toHaveLength(1);
    });
  });

  describe('release_profile', () => {
    it('deletes a live warrden-named profile in the arr', async () => {
      const client = fakeArrClient({ profiles: [{ id: 9, name: `${WARRDEN_PROFILE_PREFIX}[Group]`, enabled: true, required: ['Group'], ignored: [], tags: [1], indexerId: 0 }] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'release_profile', externalId: 9, name: `${WARRDEN_PROFILE_PREFIX}[Group]` });

      await deleteManagedObject(ctx, row);

      expect(client.deleteReleaseProfile).toHaveBeenCalledWith(9);
      expect(managedObjects.list()).toHaveLength(0);
      const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
      expect(deletedEvent!.data).toMatchObject({ deletedInArr: true });
    });

    it('never deletes a foreign-named live profile — registry-only, plus a warn event', async () => {
      const client = fakeArrClient({ profiles: [{ id: 9, name: 'Some User Profile', enabled: true, required: [], ignored: [], tags: [1], indexerId: 0 }] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'release_profile', externalId: 9, name: 'Some User Profile' });

      await deleteManagedObject(ctx, row);

      expect(client.deleteReleaseProfile).not.toHaveBeenCalled();
      expect(managedObjects.list()).toHaveLength(0);
      const warnEvent = ctx.events.list({ level: 'warn' }).find((e) => e.kind === 'managed.delete-skipped');
      expect(warnEvent).toBeDefined();
      const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
      expect(deletedEvent!.data).toMatchObject({ deletedInArr: false });
    });

    it('an already-absent live profile is dropped from the registry with no arr call and no warn', async () => {
      const client = fakeArrClient({ profiles: [] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'release_profile', externalId: 9, name: `${WARRDEN_PROFILE_PREFIX}[Group]` });

      await deleteManagedObject(ctx, row);

      expect(client.deleteReleaseProfile).not.toHaveBeenCalled();
      expect(managedObjects.list()).toHaveLength(0);
      expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
    });
  });

  describe('tag', () => {
    it('deletes a live warrden-named tag when no foreign profile carries it', async () => {
      const client = fakeArrClient({ tags: [{ id: 3, label: `${WARRDEN_TAG_PREFIX}group` }], profiles: [] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });

      await deleteManagedObject(ctx, row);

      expect(client.deleteTag).toHaveBeenCalledWith(3);
      expect(managedObjects.list()).toHaveLength(0);
      const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
      expect(deletedEvent!.data).toMatchObject({ deletedInArr: true });
    });

    it('never deletes a foreign-labeled live tag — registry-only, plus a warn event', async () => {
      const client = fakeArrClient({ tags: [{ id: 3, label: 'user-tag' }], profiles: [] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: 'user-tag' });

      await deleteManagedObject(ctx, row);

      expect(client.deleteTag).not.toHaveBeenCalled();
      expect(managedObjects.list()).toHaveLength(0);
      const warnEvent = ctx.events.list({ level: 'warn' }).find((e) => e.kind === 'managed.delete-skipped');
      expect(warnEvent).toBeDefined();
    });

    it('never deletes a tag still carried by a non-warrden release profile, even when the tag itself is warrden-labeled (Sonarr cascade safety net)', async () => {
      const client = fakeArrClient({
        tags: [{ id: 3, label: `${WARRDEN_TAG_PREFIX}group` }],
        profiles: [{ id: 9, name: 'Some User Profile', enabled: true, required: [], ignored: [], tags: [3], indexerId: 0 }],
      });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });

      await deleteManagedObject(ctx, row);

      expect(client.deleteTag).not.toHaveBeenCalled();
      expect(managedObjects.list()).toHaveLength(0);
      const warnEvent = ctx.events.list({ level: 'warn' }).find((e) => e.kind === 'managed.delete-skipped');
      expect(warnEvent).toBeDefined();
    });

    it('an already-absent live tag is dropped from the registry with no arr call and no warn', async () => {
      const client = fakeArrClient({ tags: [], profiles: [] });
      const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
      const managedObjects = new ManagedObjects(ctx.db);
      const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });

      await deleteManagedObject(ctx, row);

      expect(client.deleteTag).not.toHaveBeenCalled();
      expect(managedObjects.list()).toHaveLength(0);
      expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
    });
  });

  it('no live client for the instance: registry-only, plus a managed.delete-skipped warn — regardless of kind', async () => {
    const ctx = makeCtx({ clients: new Map() });
    const managedObjects = new ManagedObjects(ctx.db);
    const row = seedRow(managedObjects, { arrInstance: 'sonarr', kind: 'tag', externalId: 3, name: `${WARRDEN_TAG_PREFIX}group` });

    await deleteManagedObject(ctx, row);

    expect(managedObjects.list()).toHaveLength(0);
    const warnEvent = ctx.events.list({ level: 'warn' }).find((e) => e.kind === 'managed.delete-skipped');
    expect(warnEvent).toBeDefined();
    const deletedEvent = ctx.events.list().find((e) => e.kind === 'managed.deleted');
    expect(deletedEvent!.data).toMatchObject({ deletedInArr: false });
  });
});
