import { ArrApiError } from '../arr/client.js';
import type { ArrApi } from '../arr/types.js';
import type { AppContext } from '../context.js';
import { ManagedObjects, type ManagedObjectRow } from '../db/managedObjects.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX } from '../pipelines/acquire/pin.js';

/**
 * Deletes one `managed_objects` row: the registry row is always removed, but the
 * corresponding arr-side resource (a webhook notification, a `warrden-` tag, or a
 * `warrden: ` release profile) is only deleted when there's a live client for the
 * instance AND — for tags/profiles — the live object is still actually named the way
 * Warrden itself would have named it. That second check mirrors the safety net
 * `reconcile.ts`'s GC (`gcTagRow`) already applies to its own orphan cleanup: nothing
 * here ever deletes an arr-side object it can't verify it created, on the chance the
 * registry and the arr have drifted apart (a user renamed it, adopted it, etc.).
 *
 * Deliberately standalone rather than sharing code with `gcTagRow` — GC's orphan logic
 * (still-pinned-to-a-series checks, grace periods) is interleaved with these same-shape
 * safety checks in a way that extracting a shared helper would only obscure. The two
 * pieces that *do* need to agree — the `warrden-`/`warrden: ` prefixes a live object must
 * carry to be considered "ours" — both import the same constants from `pin.ts`.
 */
export async function deleteManagedObject(
  ctx: Pick<AppContext, 'db' | 'clients' | 'events'>,
  row: ManagedObjectRow,
): Promise<void> {
  const managedObjects = new ManagedObjects(ctx.db);
  const client = ctx.clients.get(row.arr_instance);

  const deletedInArr = client ? await deleteInArr(ctx, client, row) : skippedNoClient(ctx, row);

  // Only reached once the arr-side decision above has fully resolved (including any
  // real failure, which throws out of `deleteInArr` before this line) — the registry
  // row must not disappear out from under a delete that never actually happened.
  managedObjects.delete(row.arr_instance, row.kind, row.external_id);

  ctx.events.append({
    kind: 'managed.deleted',
    message: `Deleted ${row.kind} ${row.external_id} on "${row.arr_instance}" from the registry${deletedInArr ? ' and the arr' : ''}`,
    data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id, deletedInArr },
  });
}

function skippedNoClient(ctx: Pick<AppContext, 'events'>, row: ManagedObjectRow): false {
  ctx.events.append({
    kind: 'managed.delete-skipped',
    level: 'warn',
    message: `No arr client configured for "${row.arr_instance}" — removed the registry entry for ${row.kind} ${row.external_id} only`,
    data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id },
  });
  return false;
}

async function deleteInArr(ctx: Pick<AppContext, 'events'>, arr: ArrApi, row: ManagedObjectRow): Promise<boolean> {
  if (row.kind === 'notification') {
    try {
      await arr.deleteNotification(row.external_id);
      return true;
    } catch (err) {
      if (err instanceof ArrApiError && err.status === 404) return false; // already gone
      throw err;
    }
  }

  if (row.kind === 'release_profile') {
    const liveProfiles = await arr.listReleaseProfiles();
    const liveProfile = liveProfiles.find((p) => p.id === row.external_id);
    if (!liveProfile) return false; // already gone

    if (!liveProfile.name.startsWith(WARRDEN_PROFILE_PREFIX)) {
      ctx.events.append({
        kind: 'managed.delete-skipped',
        level: 'warn',
        message: `Skipped deleting non-warrden-named release profile "${liveProfile.name}" (id ${row.external_id}) on "${row.arr_instance}" — removed the registry entry only`,
        data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id },
      });
      return false;
    }

    await arr.deleteReleaseProfile(row.external_id);
    return true;
  }

  // kind === 'tag'
  const [liveTags, liveProfiles] = await Promise.all([arr.listTags(), arr.listReleaseProfiles()]);

  // Sonarr cascades a tag deletion into stripping that tag from every profile
  // referencing it — a foreign (non-warrden) profile left with an empty `tags` list
  // matches EVERY series, so the tag must survive in the arr even if its own label
  // looks like ours, as long as such a profile still carries it.
  const carriedByForeignProfile = liveProfiles.some((p) => !p.name.startsWith(WARRDEN_PROFILE_PREFIX) && p.tags.includes(row.external_id));
  if (carriedByForeignProfile) {
    ctx.events.append({
      kind: 'managed.delete-skipped',
      level: 'warn',
      message: `Skipped deleting tag id ${row.external_id} on "${row.arr_instance}" — still carried by a non-warrden release profile (deleting it would cascade into stripping it from that profile, leaving it with no tags, which Sonarr treats as matching every series); removed the registry entry only`,
      data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id },
    });
    return false;
  }

  const liveTag = liveTags.find((t) => t.id === row.external_id);
  if (!liveTag) return false; // already gone

  if (!liveTag.label.startsWith(WARRDEN_TAG_PREFIX)) {
    ctx.events.append({
      kind: 'managed.delete-skipped',
      level: 'warn',
      message: `Skipped deleting non-warrden-named tag "${liveTag.label}" (id ${row.external_id}) on "${row.arr_instance}" — removed the registry entry only`,
      data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id },
    });
    return false;
  }

  await arr.deleteTag(row.external_id);
  return true;
}
