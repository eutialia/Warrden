import type Database from 'better-sqlite3';
import type { ArrApi, TagResource } from '../../arr/types.js';
import { ManagedObjects } from '../../db/managedObjects.js';

// Exported so GC (`reconcile.ts`'s `gc()`) can apply the same "never delete something we
// didn't name" safety net to tags that it already applies to release profiles.
export const WARRDEN_TAG_PREFIX = 'warrden-';

// Exported so reconcile.ts's GC checks the exact same prefix pinReleaseGroup itself names
// its profiles with, rather than a second hardcoded copy of the string drifting out of sync.
export const WARRDEN_PROFILE_PREFIX = 'warrden: ';

/** Lowercases and collapses every run of non-alphanumeric characters into a single
 * dash, trimming leading/trailing dashes — e.g. "SubsPlease" -> "subsplease". */
function slugify(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface PinReleaseGroupInput {
  instanceName: string;
  seriesId: number;
  group: string;
}

/**
 * Pins a release group to a series: finds-or-creates a `warrden-<slug>` tag and a
 * `warrden: [<group>]` release profile requiring that group, attaches the tag to the
 * series (swapping out any previously-pinned warrden tag — a series is pinned to at most
 * one group at a time), and records both resources in `managed_objects` so GC (`reconcile.ts`'s `gc()`)
 * can find them later. Idempotent on the arr side: re-pinning the same group leaves
 * everything there as-is, including skipping the `updateSeries` call. It is NOT a pure
 * no-op on the registry, though — every call, including a same-group re-pin, re-registers
 * the tag and profile via `ManagedObjects.insert`'s upsert, which by design refreshes
 * `managed_objects.created_at`. That's the clock GC's grace period (`reconcile.ts`) reads,
 * and it has to restart on every re-pin, or a pin that's still actively in use could age
 * into GC-eligible just because nothing *new* happened to it recently. Release profiles
 * are shared across series and are never deleted here, even when swapping groups — GC
 * alone decides when a profile is orphaned.
 */
export async function pinReleaseGroup(
  deps: { client: ArrApi; db: Database.Database },
  p: PinReleaseGroupInput,
): Promise<void> {
  const { client, db } = deps;
  const managedObjects = new ManagedObjects(db);

  const tagLabel = `${WARRDEN_TAG_PREFIX}${slugify(p.group)}`;
  const profileName = `${WARRDEN_PROFILE_PREFIX}[${p.group}]`;

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
  // Both branches are gated on the profile already being warrden-named, though: a tag can
  // end up on a profile we don't own (a user manually tagged their own profile with it),
  // and adopting that profile would leave it enforcing nothing — nothing here would ever
  // touch a `required` list on a profile it doesn't already recognize as its own. A
  // not-warrden-named match is simply skipped; a fresh warrden-named profile is created
  // for it below instead, same as if nothing had matched at all.
  let profile = existingProfiles.find(
    (pr) => pr.name.startsWith(WARRDEN_PROFILE_PREFIX) && (pr.name === profileName || pr.tags.includes(tag.id)),
  );
  if (profile) {
    // A matched profile can still be stale in two independent ways: its tag list may be
    // missing the current tag id (e.g. GC deleted the old tag and this profile got
    // recreated/re-registered under a new one), and/or its `required` list may be missing
    // the group entirely (e.g. it was matched by tag membership rather than by name, or a
    // previous version of this function created/adopted it without setting `required`).
    // Leaving either stale would mean the profile silently enforces nothing for this
    // group, so both are folded in together, in a single update, whenever either is stale.
    const needsTag = !profile.tags.includes(tag.id);
    const needsRequired = !profile.required.includes(p.group);
    if (needsTag || needsRequired) {
      profile = await client.updateReleaseProfile({
        ...profile,
        tags: needsTag ? [...profile.tags, tag.id] : profile.tags,
        required: needsRequired ? [...profile.required, p.group] : profile.required,
      });
    }
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
