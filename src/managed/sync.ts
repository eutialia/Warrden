import type { ArrApi, NotificationSummary, ReleaseProfileResource, TagResource } from '../arr/types.js';
import type { AppContext } from '../context.js';
import { ManagedObjects, type ManagedObjectKind } from '../db/managedObjects.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX, slugify } from '../pipelines/acquire/pin.js';
import { errorMessage } from '../util/errors.js';
import { groupFromWarrdenProfileName, isWarrdenProfile, isWarrdenTag } from './ownership.js';

type SyncCtx = Pick<AppContext, 'db' | 'config' | 'clients' | 'events'>;

const NOTIFICATION_NAME = 'Warrden';

/**
 * Makes `managed_objects` the owner of Warrden's arr-side tags, release profiles, and
 * webhook notification: adopt live `warrden-` / `warrden: ` / `Warrden` objects this db
 * has never seen, recreate registry rows the arr no longer has (looked up by name, never
 * duplicated), rebind stale external ids. Never deletes on the arr — only the Arr objects
 * tab Delete button does that.
 */
let draining = false;
const syncJobs: Array<{ ctx: SyncCtx; resolve: () => void }> = [];

/** One in-flight pass. Two overlapping lists would both see a missing name and create
 * duplicate `warrden: [Group]` profiles (Sonarr allows that). */
export function syncManagedObjects(ctx: SyncCtx): Promise<void> {
  return new Promise((resolve) => {
    syncJobs.push({ ctx, resolve });
    if (draining) return;
    draining = true;
    void drainSync();
  });
}

async function drainSync(): Promise<void> {
  try {
    while (syncJobs.length > 0) {
      const job = syncJobs.shift();
      if (!job) break;
      try {
        await runSync(job.ctx);
      } catch (err) {
        job.ctx.events.append({
          kind: 'managed.sync-failed',
          level: 'warn',
          message: `Managed-object sync threw unexpectedly: ${errorMessage(err)}`,
        });
      }
      job.resolve();
    }
  } finally {
    draining = false;
  }
}

async function runSync(ctx: SyncCtx): Promise<void> {
  const managed = new ManagedObjects(ctx.db);
  for (const arr of ctx.config.arrs) {
    const client = ctx.clients.get(arr.name);
    if (!client) continue;
    try {
      await syncInstance(managed, client, arr.name);
    } catch (err) {
      ctx.events.append({
        kind: 'managed.sync-failed',
        level: 'warn',
        message: `Could not sync managed objects on "${arr.name}": ${errorMessage(err)}`,
        data: { instance: arr.name },
      });
    }
  }
}

async function syncInstance(managed: ManagedObjects, client: ArrApi, instance: string): Promise<void> {
  const [liveTags, liveProfiles, liveNotifications] = await Promise.all([
    client.listTags(),
    client.listReleaseProfiles(),
    client.listNotifications(),
  ]);

  adoptLive(managed, instance, liveTags, liveProfiles, liveNotifications);
  await ensureTags(managed, client, instance, liveTags);
  await ensureProfiles(managed, client, instance, liveTags, liveProfiles);
  await attachMissingProfileTags(client, liveTags, liveProfiles);
  rebindNotification(managed, instance, liveNotifications);
}

function adoptLive(
  managed: ManagedObjects,
  instance: string,
  liveTags: TagResource[],
  liveProfiles: ReleaseProfileResource[],
  liveNotifications: NotificationSummary[],
): void {
  const wProfiles = liveProfiles.filter((p) => p.id !== undefined && isWarrdenProfile(p.name));
  for (const profile of wProfiles) {
    const group = groupFromWarrdenProfileName(profile.name);
    if (group === undefined || profile.id === undefined) continue;
    record(managed, {
      arrInstance: instance,
      kind: 'release_profile',
      externalId: profile.id,
      name: profile.name,
      data: { group },
    });
  }

  for (const tag of liveTags) {
    if (!isWarrdenTag(tag.label)) continue;
    const owner = wProfiles.find((p) => p.tags.includes(tag.id));
    if (!owner) continue;
    const group = groupFromWarrdenProfileName(owner.name);
    record(managed, {
      arrInstance: instance,
      kind: 'tag',
      externalId: tag.id,
      name: tag.label,
      data: group !== undefined ? { group } : {},
    });
  }

  const webhook = liveNotifications.find((n) => n.name === NOTIFICATION_NAME);
  if (webhook) {
    record(managed, { arrInstance: instance, kind: 'notification', externalId: webhook.id, name: NOTIFICATION_NAME });
  }
}

async function ensureTags(managed: ManagedObjects, client: ArrApi, instance: string, liveTags: TagResource[]): Promise<void> {
  for (const row of managed.list({ arrInstance: instance, kind: 'tag' })) {
    if (row.name && !isWarrdenTag(row.name)) continue;
    const group = typeof row.data.group === 'string' ? row.data.group : undefined;
    const label = row.name ?? (group !== undefined ? `${WARRDEN_TAG_PREFIX}${slugify(group)}` : undefined);
    if (!label || !isWarrdenTag(label)) continue;

    const byName = liveTags.find((t) => t.label === label);
    const byId = liveTags.find((t) => t.id === row.external_id);
    const live = byName ?? byId;
    if (live) {
      if (live.id !== row.external_id) rebind(managed, row.arr_instance, 'tag', row.external_id, live.id, label, row.data);
      continue;
    }

    const created = await client.createTag(label);
    liveTags.push(created);
    rebind(managed, row.arr_instance, 'tag', row.external_id, created.id, created.label, row.data);
  }
}

async function ensureProfiles(
  managed: ManagedObjects,
  client: ArrApi,
  instance: string,
  liveTags: TagResource[],
  liveProfiles: ReleaseProfileResource[],
): Promise<void> {
  for (const row of managed.list({ arrInstance: instance, kind: 'release_profile' })) {
    const group = (typeof row.data.group === 'string' ? row.data.group : undefined) ?? (row.name ? groupFromWarrdenProfileName(row.name) : undefined);
    const name = row.name ?? (group !== undefined ? `${WARRDEN_PROFILE_PREFIX}[${group}]` : undefined);
    if (!name || !isWarrdenProfile(name) || group === undefined) continue;

    const byName = liveProfiles.find((p) => p.name === name);
    const byId = liveProfiles.find((p) => p.id === row.external_id);
    const live = byName ?? byId;
    if (live && live.id !== undefined) {
      if (live.id !== row.external_id) rebind(managed, row.arr_instance, 'release_profile', row.external_id, live.id, live.name, { group });
      continue;
    }

    const tagLabel = `${WARRDEN_TAG_PREFIX}${slugify(group)}`;
    let tag = liveTags.find((t) => t.label === tagLabel);
    if (!tag) {
      tag = await client.createTag(tagLabel);
      liveTags.push(tag);
      if (!managed.getByExternal(instance, 'tag', tag.id)) {
        record(managed, { arrInstance: instance, kind: 'tag', externalId: tag.id, name: tag.label, data: { group } });
      }
    }

    const created = await client.createReleaseProfile({
      name,
      enabled: true,
      required: [group],
      ignored: [],
      indexerId: 0,
      tags: [tag.id],
    });
    if (created.id === undefined) continue;
    liveProfiles.push(created);
    rebind(managed, row.arr_instance, 'release_profile', row.external_id, created.id, created.name, { group });
  }
}

async function attachMissingProfileTags(
  client: ArrApi,
  liveTags: TagResource[],
  liveProfiles: ReleaseProfileResource[],
): Promise<void> {
  for (let i = 0; i < liveProfiles.length; i++) {
    const profile = liveProfiles[i]!;
    if (profile.id === undefined || !isWarrdenProfile(profile.name)) continue;
    const group = groupFromWarrdenProfileName(profile.name);
    if (group === undefined) continue;
    const tag = liveTags.find((t) => t.label === `${WARRDEN_TAG_PREFIX}${slugify(group)}`);
    if (!tag || profile.tags.includes(tag.id)) continue;
    const updated = await client.updateReleaseProfile({ ...profile, tags: [...profile.tags, tag.id] });
    liveProfiles[i] = updated;
  }
}

function rebindNotification(managed: ManagedObjects, instance: string, liveNotifications: NotificationSummary[]): void {
  const webhook = liveNotifications.find((n) => n.name === NOTIFICATION_NAME);
  if (!webhook) return;
  for (const row of managed.list({ arrInstance: instance, kind: 'notification' })) {
    if (row.external_id !== webhook.id) managed.delete(instance, 'notification', row.external_id);
  }
  record(managed, { arrInstance: instance, kind: 'notification', externalId: webhook.id, name: NOTIFICATION_NAME });
}

function record(
  managed: ManagedObjects,
  input: { arrInstance: string; kind: ManagedObjectKind; externalId: number; name?: string; data?: object },
): void {
  if (managed.getByExternal(input.arrInstance, input.kind, input.externalId)) return;
  managed.insert(input);
}

function rebind(
  managed: ManagedObjects,
  instance: string,
  kind: ManagedObjectKind,
  fromId: number,
  toId: number,
  name: string,
  data: object,
): void {
  if (fromId === toId) return;
  managed.delete(instance, kind, fromId);
  record(managed, { arrInstance: instance, kind, externalId: toId, name, data });
}
