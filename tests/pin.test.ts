import { describe, it, expect } from 'vitest';
import { pinReleaseGroup } from '../src/pipelines/acquire/pin.js';
import { freshDb, fakeArrClient } from './helpers.js';

describe('pinReleaseGroup', () => {
  it('creates tag + profile, attaches tag, registers managed objects', async () => {
    const client = fakeArrClient({ series: [{ id: 42, title: 'Frieren', year: 2023, tvdbId: 1, tags: [], added: '' }] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    expect(client.tags.map((t) => t.label)).toContain('warrden-subsplease');
    expect(client.profiles[0]).toMatchObject({ name: 'warrden: [SubsPlease]', required: ['SubsPlease'] });
    expect(client.series[0].tags).toContain(client.tags[0].id);
    const rows = db.prepare('SELECT kind FROM managed_objects').all();
    expect(rows.map((r: any) => r.kind).sort()).toEqual(['release_profile', 'tag']);
  });
  it('is idempotent for the same group', async () => {
    const client = fakeArrClient({ series: [{ id: 42, title: 'F', year: 0, tvdbId: 1, tags: [], added: '' }] });
    const db = freshDb();
    const p = { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' };
    await pinReleaseGroup({ client, db }, p);
    await pinReleaseGroup({ client, db }, p);
    expect(client.tags).toHaveLength(1);
    expect(client.profiles).toHaveLength(1);
    // The real idempotence guarantee: the second pin doesn't touch the series at all.
    expect(client.updateSeries).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing profile already carrying the pinned tag even when the group string differs only in a way that slugifies the same (no duplicate, differently-named profile)', async () => {
    const client = fakeArrClient({ series: [{ id: 42, title: 'F', year: 0, tvdbId: 1, tags: [], added: '' }] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'subsplease' });
    expect(client.tags).toHaveLength(1); // same slug -> same tag, reused
    expect(client.profiles).toHaveLength(1); // reused by tag membership, not re-created under the new name
  });
  it('re-pinning a different group swaps the series tag', async () => {
    const client = fakeArrClient({ series: [{ id: 42, title: 'F', year: 0, tvdbId: 1, tags: [], added: '' }] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'GroupA' });
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'GroupB' });
    const labels = client.tags.filter((t) => client.series[0].tags.includes(t.id)).map((t) => t.label);
    expect(labels).toEqual(['warrden-groupb']);
  });
});
