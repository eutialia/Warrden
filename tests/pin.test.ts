import { describe, it, expect } from 'vitest';
import { pinReleaseGroup } from '../src/pipelines/acquire/pin.js';
import { freshDb, fakeArrClient, seriesResource } from './helpers.js';

describe('pinReleaseGroup', () => {
  it('creates tag + profile, attaches tag, registers managed objects', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'Frieren' })] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    expect(client.tags.map((t) => t.label)).toContain('warrden-subsplease');
    expect(client.profiles[0]).toMatchObject({ name: 'warrden: [SubsPlease]', required: ['SubsPlease'] });
    expect(client.series[0].tags).toContain(client.tags[0].id);
    const rows = db.prepare('SELECT kind FROM managed_objects').all();
    expect(rows.map((r: any) => r.kind).sort()).toEqual(['release_profile', 'tag']);
  });
  it('is idempotent for the same group', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
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
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'subsplease' });
    expect(client.tags).toHaveLength(1); // same slug -> same tag, reused
    expect(client.profiles).toHaveLength(1); // reused by tag membership, not re-created under the new name
  });
  it('reconciles a name-matched profile whose tags are stale (e.g. after its old tag was GC\'d) by adding the current tag id', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
    client.pushProfile({ name: 'warrden: [SubsPlease]', enabled: true, required: ['SubsPlease'], ignored: [], tags: [999], indexerId: 0 });
    const db = freshDb();

    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });

    const newTag = client.tags.find((t) => t.label === 'warrden-subsplease')!;
    expect(client.updateReleaseProfile).toHaveBeenCalledWith(expect.objectContaining({ tags: [999, newTag.id] }));
    expect(client.profiles).toHaveLength(1); // reconciled in place, not duplicated
    expect(client.profiles[0].tags).toEqual([999, newTag.id]);
  });

  it('never adopts a USER-owned profile by tag membership — a matching but non-warrden-named profile is left alone and a fresh warrden-named profile is created instead', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
    const tag = client.pushTag('warrden-subsplease');
    const userProfile = client.pushProfile({ name: 'My Custom Profile', enabled: true, required: [], ignored: [], tags: [tag.id], indexerId: 0 });
    const db = freshDb();

    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });

    // The user's profile is untouched — never adopted, never enforced anything for us.
    expect(client.updateReleaseProfile).not.toHaveBeenCalled();
    const stillThere = client.profiles.find((p) => p.id === userProfile.id)!;
    expect(stillThere).toMatchObject({ name: 'My Custom Profile', required: [] });
    // A brand-new, warrden-named profile was created instead, actually requiring the group.
    expect(client.profiles).toHaveLength(2);
    const ours = client.profiles.find((p) => p.id !== userProfile.id)!;
    expect(ours).toMatchObject({ name: 'warrden: [SubsPlease]', required: ['SubsPlease'] });
  });

  it('refreshes a warrden-named profile\'s stale `required` list to include the group, whether matched by name or by tag', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
    const tag = client.pushTag('warrden-subsplease');
    // Matched by name, but `required` never got the group (stale/legacy row).
    client.pushProfile({ name: 'warrden: [SubsPlease]', enabled: true, required: [], ignored: [], tags: [tag.id], indexerId: 0 });
    const db = freshDb();

    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'SubsPlease' });

    expect(client.updateReleaseProfile).toHaveBeenCalledWith(expect.objectContaining({ required: ['SubsPlease'] }));
    expect(client.profiles).toHaveLength(1);
    expect(client.profiles[0].required).toEqual(['SubsPlease']);
  });

  it('re-pinning a different group swaps the series tag', async () => {
    const client = fakeArrClient({ series: [seriesResource({ id: 42, title: 'F', year: 0 })] });
    const db = freshDb();
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'GroupA' });
    await pinReleaseGroup({ client, db }, { instanceName: 'sonarr', seriesId: 42, group: 'GroupB' });
    const labels = client.tags.filter((t) => client.series[0].tags.includes(t.id)).map((t) => t.label);
    expect(labels).toEqual(['warrden-groupb']);
  });
});
