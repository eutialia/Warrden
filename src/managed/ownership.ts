import type { ReleaseProfileResource } from '../arr/types.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX } from '../pipelines/acquire/pin.js';

/**
 * Shared "is this ours?" predicates for `warrden-` tags and `warrden: ` release profiles,
 * plus the specific check both `reconcile.ts`'s GC (`gcTagRow`) and `deleteObject.ts`'s
 * `deleteInArr` need before ever deleting a tag: whether some OTHER, non-warrden-owned
 * profile still carries it. Both call-sites destroy live arr state (a tag deletion cascades
 * into stripping that tag from every profile referencing it, and a profile left with an
 * empty `tags` list matches EVERY series in Sonarr), so this lives in one place rather than
 * two copies that could silently drift apart on exactly the check that keeps that
 * destruction from touching something Warrden doesn't own.
 */

/** Whether a release profile's name is one Warrden itself would have created. */
export function isWarrdenProfile(name: string): boolean {
  return name.startsWith(WARRDEN_PROFILE_PREFIX);
}

/** Group inside `warrden: [Trix]`, or undefined when the name isn't that shape. */
export function groupFromWarrdenProfileName(name: string): string | undefined {
  if (!isWarrdenProfile(name)) return undefined;
  const rest = name.slice(WARRDEN_PROFILE_PREFIX.length);
  if (rest.startsWith('[') && rest.endsWith(']') && rest.length >= 2) return rest.slice(1, -1);
  return undefined;
}

/** Whether a tag's label is one Warrden itself would have created. */
export function isWarrdenTag(label: string): boolean {
  return label.startsWith(WARRDEN_TAG_PREFIX);
}

/**
 * Every LIVE release profile that both (a) isn't warrden-named and (b) still carries
 * `tagId` — i.e. every profile a tag deletion's cascade would silently strip down to an
 * empty (so "matches every series") `tags` list, if that tag were deleted. Scans ALL live
 * profiles, not just one this registry happens to have a row for: a foreign profile that
 * independently picked up the tag (a user adopted it, or it was never registered in the
 * first place) is just as much at risk from the cascade as a registered one.
 */
export function foreignProfilesCarryingTag(liveProfiles: ReleaseProfileResource[], tagId: number): ReleaseProfileResource[] {
  return liveProfiles.filter((p) => !isWarrdenProfile(p.name) && p.tags.includes(tagId));
}
