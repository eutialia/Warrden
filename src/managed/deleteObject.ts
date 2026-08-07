import { ArrApiError } from '../arr/client.js';
import type { ArrApi } from '../arr/types.js';
import { instanceKind } from '../config/instances.js';
import type { AppContext } from '../context.js';
import { ManagedObjects, type ManagedObjectRow } from '../db/managedObjects.js';
import { WARRDEN_PROFILE_PREFIX, WARRDEN_TAG_PREFIX } from '../pipelines/acquire/pin.js';
import { errorMessage } from '../util/errors.js';

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
 *
 * If the arr call itself fails unexpectedly (anything other than the notification 404
 * special-case below), the failure is logged as a `managed.delete-failed` warn event and
 * then rethrown — the route above turns that into a 500. The registry row is deliberately
 * left in place when that happens: it's the retry pointer for a future delete attempt, and
 * dropping it here would silently forget that the arr-side resource was never actually
 * removed.
 */
export async function deleteManagedObject(
  ctx: Pick<AppContext, 'db' | 'clients' | 'events' | 'config'>,
  row: ManagedObjectRow,
): Promise<{ deletedInArr: boolean }> {
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

  // The caller (the DELETE route) needs this to tell the operator apart "the live
  // Sonarr/Radarr object is gone too" from "only the registry bookkeeping was removed" —
  // the event above already carries it, but a route response shouldn't require re-parsing
  // the event log to answer its own request.
  return { deletedInArr };
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

async function deleteInArr(ctx: Pick<AppContext, 'events' | 'config'>, arr: ArrApi, row: ManagedObjectRow): Promise<boolean> {
  try {
    if (row.kind === 'notification') {
      try {
        await arr.deleteNotification(row.external_id);
        return true;
      } catch (err) {
        if (err instanceof ArrApiError && err.status === 404) return false; // already gone
        throw err;
      }
    }

    // Release-group tag pinning (`pin.ts`) is series-only — it never runs for a movie job
    // — so a `radarr`-kind instance should never actually carry tag/profile registry rows.
    // But if one somehow does (a leftover from a config change, a bug elsewhere), querying
    // `listReleaseProfiles`/`listTags` against it is pointless at best and, against a real
    // Radarr, could hit an endpoint it doesn't meaningfully use for this. Skip the live
    // checks entirely and fall back to registry-only, same guard `reconcile.ts`'s GC
    // (`gc()`) applies for the identical reason.
    if ((row.kind === 'release_profile' || row.kind === 'tag') && instanceKind(ctx.config, row.arr_instance) === 'radarr') {
      return false;
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
  } catch (err) {
    ctx.events.append({
      kind: 'managed.delete-failed',
      level: 'warn',
      message: `Failed to delete ${row.kind} ${row.external_id} on "${row.arr_instance}" in the arr: ${errorMessage(err)}`,
      data: { instance: row.arr_instance, kind: row.kind, externalId: row.external_id },
    });
    throw err;
  }
}
