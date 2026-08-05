import { describe, it, expect } from 'vitest';
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

  it('insert is a no-op for an existing (arrInstance, kind, externalId) triple', () => {
    const objs = new ManagedObjects(freshDb());
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });

    expect(objs.list()).toHaveLength(1);
  });

  it('deletes a row by (arrInstance, kind, externalId)', () => {
    const objs = new ManagedObjects(freshDb());
    objs.insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 1, name: 'Warrden' });

    objs.delete('sonarr', 'notification', 1);

    expect(objs.list()).toHaveLength(0);
  });
});
