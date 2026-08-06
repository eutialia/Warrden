import { describe, it, expect, vi } from 'vitest';
import { ManagedObjects } from '../src/db/managedObjects.js';
import { freshDb } from './helpers.js';

describe('ManagedObjects', () => {
  it('inserts and lists rows, filtered by arrInstance/kind', () => {
    const objs = new ManagedObjects(freshDb());
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });
    objs.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 2, name: 'warrden-group', data: { group: 'Group' } });
    objs.insert({ arrInstance: 'radarr', kind: 'notification', externalId: 3, name: 'Warrden' });

    expect(objs.list().map((r) => r.external_id)).toEqual([1, 2, 3]);
    expect(objs.list({ arrInstance: 'sonarr' }).map((r) => r.external_id)).toEqual([1, 2]);
    expect(objs.list({ kind: 'notification' }).map((r) => r.external_id)).toEqual([1, 3]);
    expect(objs.list({ arrInstance: 'sonarr', kind: 'tag' })[0]).toMatchObject({ data: { group: 'Group' } });
  });

  it('re-registering an existing (arrInstance, kind, externalId) triple does not create a duplicate row', () => {
    const objs = new ManagedObjects(freshDb());
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });

    expect(objs.list()).toHaveLength(1);
  });

  it('re-registering an existing triple refreshes created_at instead of leaving it stale (GC uses it as a grace-period clock)', () => {
    vi.useFakeTimers();
    try {
      const objs = new ManagedObjects(freshDb());
      vi.setSystemTime(1_000);
      objs.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 1, name: 'warrden-group' });
      expect(objs.list()[0]!.created_at).toBe(1_000);

      vi.setSystemTime(2_000);
      objs.insert({ arrInstance: 'sonarr', kind: 'tag', externalId: 1, name: 'warrden-group' });
      expect(objs.list()).toHaveLength(1); // still no duplicate row
      expect(objs.list()[0]!.created_at).toBe(2_000); // but its clock restarted
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a row by (arrInstance, kind, externalId)', () => {
    const objs = new ManagedObjects(freshDb());
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });

    objs.delete('sonarr', 'notification', 1);

    expect(objs.list()).toHaveLength(0);
  });
});
