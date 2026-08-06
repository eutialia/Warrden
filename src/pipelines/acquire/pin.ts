import type Database from 'better-sqlite3';
import type { ArrApi, TagResource } from '../../arr/types.js';
import { ManagedObjects } from '../../db/managedObjects.js';

// Exported so GC (Task 12, reconcile.ts) can apply the same "never delete something we
// didn't name" safety net to tags that it already applies to release profiles.
export const WARRDEN_TAG_PREFIX = 'warrden-';

/** Lowercases and collapses every run of non-alphanumeric characters into a single
 * dash, trimming leading/trailing dashes — e.g. "SubsPlease" -> "subsplease". */
function slugify(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface PinReleaseGroupInput {
  instanceName: string;
  seriesId: number;
  group: string;
}

/**
 * Pins a release group to a series: finds-or-creates a `warrden-<slug>` tag and a
 * `warrden: [<group>]` release profile requiring that group, attaches the tag to the
 * series (swapping out any previously-pinned warrden tag — a series is pinned to at most
 * one group at a time), and records both resources in `managed_objects` so GC (Task 12)
 * can find them later. Idempotent: re-pinning the same group leaves everything as-is,
 * including skipping the `updateSeries` call. Release profiles are shared across series
 * and are never deleted here, even when swapping groups — GC alone decides when a
 * profile is orphaned.
 */
export async function pinReleaseGroup(
  deps: { client: ArrApi; db: Database.Database },
  p: PinReleaseGroupInput,
): Promise<void> {
  const { client, db } = deps;
  const managedObjects = new ManagedObjects(db);

  const tagLabel = `${WARRDEN_TAG_PREFIX}${slugify(p.group)}`;
  const profileName = `warrden: [${p.group}]`;

  const existingTags = await client.listTags();
  const tag = existingTags.find((t) => t.label === tagLabel) ?? (await client.createTag(tagLabel));
  managedObjects.insert({
    arrInstance: p.instanceName,
    kind: 'tag',
    externalId: tag.id,
    name: tagLabel,
    data: { group: p.group },
  });

  const existingProfiles = await client.listReleaseProfiles();
  // Matching on name alone misses a profile that's already pinned to this exact tag but
  // under a differently-formatted group string that happens to slugify to the same tag
  // (e.g. "SubsPlease" vs "subsplease") — name comparison and tag comparison would each
  // pick a different "existing" profile, so neither alone is reliable. Matching on
  // *either* means whichever one already carries the tag wins, and nothing new is created.
  let profile = existingProfiles.find((pr) => pr.name === profileName || pr.tags.includes(tag.id));
  if (profile && !profile.tags.includes(tag.id)) {
    // Matched by name only, and its tag list doesn't include the current tag id — e.g. GC
    // (Task 12) deleted the old tag and this profile got recreated/re-registered under a
    // new one. Leaving the mismatch in place would pin a real profile to a dead tag id, a
    // silently inert pin, so fold the current tag in rather than leaving it stale.
    profile = await client.updateReleaseProfile({ ...profile, tags: [...profile.tags, tag.id] });
  }
  profile ??= await client.createReleaseProfile({
    name: profileName,
    enabled: true,
    required: [p.group],
    ignored: [],
    indexerId: 0,
    tags: [tag.id],
  });
  if (profile.id === undefined) {
    throw new Error(`pinReleaseGroup: release profile "${profileName}" was created/found without an id`);
  }
  managedObjects.insert({
    arrInstance: p.instanceName,
    kind: 'release_profile',
    externalId: profile.id,
    name: profile.name,
    data: { group: p.group },
  });

  await attachTag(client, existingTags, p.seriesId, tag.id);
}

/**
 * Attaches `tagId` to the series, removing any other `warrden-` tag already on it — a
 * series is pinned to at most one group, so swapping groups swaps the tag rather than
 * accumulating them. No-op (no `updateSeries` call at all) when the series is already in
 * exactly that state.
 */
async function attachTag(client: ArrApi, knownTags: TagResource[], seriesId: number, tagId: number): Promise<void> {
  const series = await client.getSeries(seriesId);
  const current = new Set(series.tags);

  const staleWarrdenTagIds = knownTags
    .filter((t) => t.label.startsWith(WARRDEN_TAG_PREFIX) && t.id !== tagId && current.has(t.id))
    .map((t) => t.id);

  if (current.has(tagId) && staleWarrdenTagIds.length === 0) {
    return;
  }

  const nextTags = series.tags.filter((id) => !staleWarrdenTagIds.includes(id));
  if (!nextTags.includes(tagId)) nextTags.push(tagId);
  await client.updateSeries({ ...series, tags: nextTags });
}
