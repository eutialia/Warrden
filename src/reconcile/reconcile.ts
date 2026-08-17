import type { ArrApi, MovieResource, ReleaseProfileResource, SeriesResource, TagResource } from '../arr/types.js';
import { instanceKind } from '../config/instances.js';
import type { AppContext } from '../context.js';
import { ManagedObjects, type ManagedObjectRow } from '../db/managedObjects.js';
import { SyncState } from '../db/syncState.js';
import type { TargetKind } from '../jobs/queue.js';
import { traceTrigger } from '../trace/tracer.js';
import { foreignProfilesCarryingTag, isWarrdenProfile, isWarrdenTag } from '../managed/ownership.js';
import { errorMessage } from '../util/errors.js';

const RECONCILE_SOURCE = 'reconcile';
const HISTORY_PAGE_SIZE = 100;

interface Resource {
  id: number;
  title: string;
  kind: TargetKind;
}

/**
 * Runs one reconciliation pass over every configured arr instance: catches up on
 * series/movies a webhook missed (arr was down, a webhook got dropped, etc.), catches up on
 * import history a webhook missed via `ingestBackstop`, and garbage collects `warrden-`
 * tags/profiles nothing needs anymore. Never throws — a failure against one instance is
 * reported as a `warn` event and does not stop the rest. The missed-adds and ingest-backstop
 * phases deliberately share one per-instance `try` — a failure in either surfaces as the same
 * `reconcile.failed` and only skips the rest of *that* instance's pass, never the others'. GC
 * is a fully independent phase after the loop, wrapped in its own try/catch too, so even a
 * failure building its own bookkeeping (not just a per-instance failure inside it) can't
 * escape and crash the caller (`scheduleReconcile`'s own net is strictly a last resort).
 *
 * The very first reconciliation for a given instance is a *bootstrap*, not a catch-up: an
 * instance's whole existing library would otherwise look "missed" and mass-enqueue every
 * series/movie it already has. So instead, the first run only records what's already there
 * (`sync_state['seen:<name>']`) and marks `sync_state['bootstrap:<name>']`, with nothing
 * enqueued. Every run after that treats new ids in the arr's list as genuinely new.
 */
export async function reconcile(ctx: AppContext): Promise<void> {
  const syncState = new SyncState(ctx.db);
  const seriesByInstance = new Map<string, SeriesResource[]>();

  for (const [name, client] of ctx.clients) {
    try {
      const { series, movies } = await fetchInstanceResources(ctx, name, client);
      seriesByInstance.set(name, series);
      reconcileInstance(ctx, syncState, name, toResources(series, movies));
      await ingestBackstop(ctx, syncState, name, client);
    } catch (err) {
      ctx.events.append({
        kind: 'reconcile.failed',
        level: 'warn',
        message: `Reconcile failed for "${name}": ${errorMessage(err)}`,
        data: { instance: name },
      });
    }
  }

  try {
    await gc(ctx, seriesByInstance);
  } catch (err) {
    ctx.events.append({
      kind: 'reconcile.gc-failed-global',
      level: 'warn',
      message: `GC pass crashed outright, before/beyond its own per-instance handling: ${errorMessage(err)}`,
    });
  }
}

/** Fetches the resource list(s) relevant to `name`'s configured kind: only series for a
 * `sonarr` instance, only movies for `radarr`, or both when the kind is unknown — safer
 * than guessing wrong and silently skipping an instance's actual library. Skipping the
 * irrelevant call for a known kind also avoids hitting an endpoint the real arr flavor
 * doesn't implement (Sonarr has no `/movie`, Radarr no `/series`) on every single pass. */
async function fetchInstanceResources(
  ctx: AppContext,
  name: string,
  client: ArrApi,
): Promise<{ series: SeriesResource[]; movies: MovieResource[] }> {
  const kind = instanceKind(ctx.config, name);
  const series = kind === 'radarr' ? [] : await client.listSeries();
  const movies = kind === 'sonarr' ? [] : await client.listMovies();
  return { series, movies };
}

function toResources(series: SeriesResource[], movies: MovieResource[]): Resource[] {
  return [
    ...series.map((s) => ({ id: s.id, title: s.title, kind: 'series' as const })),
    ...movies.map((m) => ({ id: m.id, title: m.title, kind: 'movie' as const })),
  ];
}

function reconcileInstance(ctx: AppContext, syncState: SyncState, name: string, resources: Resource[]): void {
  const bootstrapKey = `bootstrap:${name}`;
  const seenKey = `seen:${name}`;
  const currentIds = new Set(resources.map((r) => r.id));

  if (syncState.read<boolean>(bootstrapKey) !== true) {
    syncState.write(seenKey, [...currentIds]);
    syncState.write(bootstrapKey, true);
    ctx.events.append({
      kind: 'reconcile.bootstrapped',
      message: `Bootstrapped "${name}" with ${currentIds.size} existing item(s); nothing enqueued`,
      data: { instance: name, count: currentIds.size },
    });
    return;
  }

  const seenIds = new Set<number>(syncState.read<number[]>(seenKey) ?? []);
  const missed = resources.filter((r) => !seenIds.has(r.id));

  const enqueuedIds: number[] = [];
  let alreadyHandled = 0;

  for (const r of missed) {
    // `seen` is only ever written by reconcile itself, so a series/movie a webhook already
    // enqueued (and possibly already ran to completion) looks exactly like a genuine miss
    // the very first time reconcile sees it. Enqueuing again would duplicate the grab (and
    // the LLM spend behind it) once the webhook's own job runs — checking for ANY existing
    // job for this target (any status, not just pending/running) catches that case, and
    // this pass just catches `seen` up to match instead.
    if (ctx.queue.hasJobFor('acquire', name, r.kind, r.id)) {
      alreadyHandled++;
    } else {
      const result = ctx.queue.enqueue({
        pipeline: 'acquire',
        targetKind: r.kind,
        targetId: r.id,
        arrInstance: name,
        payload: { title: r.title, source: RECONCILE_SOURCE },
      });
      traceTrigger(ctx.trace, result, {
        kind: 'trigger.reconcile',
        summary: `reconcile scan (missed webhook add on "${name}")`,
        payload: () => ({ instance: name, kind: r.kind, targetId: r.id, title: r.title }),
      });
      enqueuedIds.push(r.id);
    }
    seenIds.add(r.id);
  }

  if (missed.length > 0) {
    ctx.events.append({
      kind: 'reconcile.missed-adds',
      message: `Enqueued ${enqueuedIds.length} item(s) on "${name}" missed by webhooks${
        alreadyHandled > 0 ? ` (${alreadyHandled} already had a job and needed no re-enqueue)` : ''
      }`,
      data: { instance: name, count: enqueuedIds.length, ids: enqueuedIds, alreadyHandled },
    });
  }

  // Ids no longer present in the arr's own list (deleted series/movies) drop out of `seen`
  // rather than lingering forever — otherwise a later re-add of the same id would be
  // silently treated as already-seen instead of enqueued again.
  syncState.write(
    seenKey,
    [...seenIds].filter((id) => currentIds.has(id)),
  );
}

/**
 * Backstop for the ingest webhook path: an arr's own `/history` (newest-first,
 * `downloadFolderImported` only) is the ground truth for what got imported, so a
 * per-instance cursor over its `id` catches anything a dropped/never-registered webhook
 * missed. Same bootstrap shape as `reconcileInstance`'s `seen:<name>` above, and for the
 * same reason: the very first pass has no prior cursor, so treating every existing history
 * record as "missed" would mass-enqueue an instance's whole import history. Instead it just
 * records the current max id and enqueues nothing; only ids above that cursor on later
 * passes are ever new.
 *
 * A record the webhook path already handled will still show up here once — the cursor
 * only suppresses ids at or below where it last stopped, not "already handled" — but
 * re-enqueuing costs nothing: ingest's provenance short-circuit makes a duplicate run a
 * no-op before it ever reaches the LLM. If more than `HISTORY_PAGE_SIZE` imports land
 * between passes the oldest overflow is missed; acceptable for a backstop whose primary
 * path is the webhook.
 */
async function ingestBackstop(ctx: AppContext, syncState: SyncState, name: string, client: ArrApi): Promise<void> {
  const cursorKey = `history:${name}`;
  const records = await client.listRecentImports(HISTORY_PAGE_SIZE);
  const maxId = records.reduce((m, r) => Math.max(m, r.id), 0);

  const cursor = syncState.read<number>(cursorKey);
  if (cursor === undefined || cursor === null) {
    syncState.write(cursorKey, maxId);
    ctx.events.append({
      kind: 'reconcile.history-bootstrapped',
      message: `Bootstrapped import-history cursor for "${name}" at ${maxId}; nothing enqueued`,
      data: { instance: name, cursor: maxId },
    });
    return;
  }

  // The arr's history ids can restart below the tracked cursor if its database was ever
  // rebuilt or restored from a backup taken before this cursor's value — a plain
  // `cursor` sitting above every live id would otherwise make EVERY record look
  // at-or-below it forever, silently killing the backstop for good. Only possible when
  // there's at least one live record (an empty page proves nothing about what the arr's
  // ids actually are right now). Treat it like a fresh bootstrap: reset to the new max and
  // enqueue nothing this pass — the next pass resumes normally from there.
  if (records.length > 0 && maxId < cursor) {
    syncState.write(cursorKey, maxId);
    ctx.events.append({
      kind: 'reconcile.history-cursor-reset',
      level: 'warn',
      message: `Import-history for "${name}" reports ids below the tracked cursor (arr database likely rebuilt/restored) — resetting cursor from ${cursor} to ${maxId}; nothing enqueued this pass`,
      data: { instance: name, cursor, maxId },
    });
    return;
  }

  const fresh = records.filter((r) => r.id > cursor);
  const enqueuedTargets: string[] = [];
  const seen = new Set<string>();
  // Deliberately does not consult ctx.queue.hasJobFor, unlike reconcileInstance's acquire-side
  // check above: ingest is a recurring per-target pipeline — the same series/movie
  // legitimately gets a fresh ingest job for every new import, not just once ever.
  // hasJobFor's any-status match would find that target's very first (possibly long-done)
  // ingest job and treat every later import as "already handled," permanently silencing this
  // backstop. The cursor above is the actual dedupe axis here, not job history.
  for (const r of fresh) {
    const target: { kind: TargetKind; id: number } | null =
      r.seriesId !== undefined ? { kind: 'series', id: r.seriesId } : r.movieId !== undefined ? { kind: 'movie', id: r.movieId } : null;
    if (target === null) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = ctx.queue.enqueue({
      pipeline: 'ingest',
      targetKind: target.kind,
      targetId: target.id,
      arrInstance: name,
      // No `downloadId` here — nothing reads it; ingest derives its own download ids
      // straight from the arr's live queue (`assessQueue`), not from the payload.
      payload: { source: RECONCILE_SOURCE },
    });
    traceTrigger(ctx.trace, result, {
      kind: 'trigger.reconcile',
      summary: `reconcile scan (missed import history on "${name}")`,
      payload: () => ({ instance: name, kind: target.kind, targetId: target.id, historyRecordId: r.id }),
    });
    enqueuedTargets.push(key);
  }

  if (maxId > cursor) syncState.write(cursorKey, maxId);
  if (enqueuedTargets.length > 0) {
    ctx.events.append({
      kind: 'reconcile.missed-imports',
      message: `Enqueued ${enqueuedTargets.length} ingest job(s) on "${name}" for imports missed by webhooks`,
      data: { instance: name, targets: enqueuedTargets },
    });
  }
}

/**
 * Deletes `warrden-` tags (and their release profiles) that nothing needs anymore: zero
 * current series carry the tag, and no *other* series needs the profile either (a profile
 * can end up carrying more than one tag id — see `pinReleaseGroup`'s reconciliation of a
 * name-matched profile — so checking only the one tag id under consideration isn't enough).
 * Only ever acts on rows already registered in `managed_objects`; nothing unregistered is
 * ever touched. Skipped entirely for an instance whose current series list couldn't be
 * fetched this pass (missing client, or `reconcile()`'s per-instance fetch above failed) —
 * GC without a fresh series list can't tell "orphaned" from "in use," so it's safer to
 * retry next pass than to guess.
 */
async function gc(ctx: AppContext, seriesByInstance: Map<string, SeriesResource[]>): Promise<void> {
  const managedObjects = new ManagedObjects(ctx.db);
  const tagRowsByInstance = new Map<string, ManagedObjectRow[]>();
  for (const row of managedObjects.list({ kind: 'tag' })) {
    const rows = tagRowsByInstance.get(row.arr_instance) ?? [];
    rows.push(row);
    tagRowsByInstance.set(row.arr_instance, rows);
  }

  for (const [name, tagRows] of tagRowsByInstance) {
    // Release-group tag pinning is series-only (pin.ts never runs for a movie job), so a
    // `radarr`-kind instance should never actually carry tag/profile registry rows. But if
    // one somehow does (a leftover from a config change, a bug elsewhere), GC-ing it here
    // would check it against `fetchInstanceResources`'s always-empty series list for a
    // radarr instance and mass-delete it as "orphaned" — skip radarr outright rather than
    // relying on that emptiness being the right answer.
    if (instanceKind(ctx.config, name) === 'radarr') continue;

    const client = ctx.clients.get(name);
    const series = seriesByInstance.get(name);
    if (!client || !series) continue;

    try {
      await gcInstance(ctx, managedObjects, name, client, series, tagRows);
    } catch (err) {
      // A failure fetching this instance's live tags/profiles (network blip, arr down)
      // must not stop GC for every instance after it in this `Map` — each instance's GC is
      // independent, same as `reconcile()`'s own per-instance isolation above.
      ctx.events.append({
        kind: 'reconcile.gc-failed',
        level: 'warn',
        message: `GC failed for "${name}": ${errorMessage(err)}`,
        data: { instance: name },
      });
    }
  }
}

async function gcInstance(
  ctx: AppContext,
  managedObjects: ManagedObjects,
  name: string,
  client: ArrApi,
  series: SeriesResource[],
  tagRows: ManagedObjectRow[],
): Promise<void> {
  const profileRows = managedObjects.list({ arrInstance: name, kind: 'release_profile' });
  const [liveProfiles, liveTags] = await Promise.all([client.listReleaseProfiles(), client.listTags()]);
  // A registry row younger than one full reconcile interval might reflect a pin that just
  // landed *after* the `series` snapshot above was taken (e.g. an acquire job's `pinReleaseGroup`
  // interleaving with this very pass) — comparing that stale snapshot against a freshly
  // registered tag/profile would misjudge it as orphaned and destroy a pin nothing had a
  // chance to show as "in use" yet. Give every row one interval's grace before GC considers
  // it a candidate at all.
  const cutoff = Date.now() - ctx.config.reconcileIntervalMinutes * 60_000;

  for (const tagRow of tagRows) {
    try {
      await gcTagRow(ctx, managedObjects, name, client, series, profileRows, liveProfiles, liveTags, cutoff, tagRow);
    } catch (err) {
      ctx.events.append({
        kind: 'reconcile.gc-row-failed',
        level: 'warn',
        message: `GC failed for tag id ${tagRow.external_id} on "${name}": ${errorMessage(err)}`,
        data: { instance: name, tagId: tagRow.external_id },
      });
    }
  }
}

async function gcTagRow(
  ctx: AppContext,
  managedObjects: ManagedObjects,
  name: string,
  client: ArrApi,
  series: SeriesResource[],
  profileRows: ManagedObjectRow[],
  liveProfiles: ReleaseProfileResource[],
  liveTags: TagResource[],
  cutoff: number,
  tagRow: ManagedObjectRow,
): Promise<void> {
  if (tagRow.created_at > cutoff) return; // too young to trust the series snapshot against — see gcInstance
  if (series.some((s) => s.tags.includes(tagRow.external_id))) return; // still pinned to a series

  const group = (tagRow.data as { group?: string }).group;
  const profileRow = profileRows.find((p) => (p.data as { group?: string }).group === group);
  const liveProfile = profileRow ? liveProfiles.find((p) => p.id === profileRow.external_id) : undefined;
  // A profile not carrying this exact tag id isn't necessarily orphaned by *this* tag's
  // orphan-ness alone — check every tag id it currently carries, not just this one.
  const profileTagIds = liveProfile?.tags ?? [tagRow.external_id];
  if (series.some((s) => s.tags.some((t) => profileTagIds.includes(t)))) return; // profile still serves another series

  let profileDeleted = false;
  // Set when the profile is skipped for not being warrden-owned: Sonarr cascades a tag
  // deletion into stripping that tag from every entity referencing it, including this
  // profile — a release profile left with an empty `tags` list matches *every* series, so
  // deleting the tag out from under a user's profile would silently make it apply
  // everywhere. Once this fires, the tag has to survive in the arr too, regardless of what
  // its own label says.
  let skipTagArrDeletion = false;

  if (profileRow) {
    if (liveProfile) {
      if (isWarrdenProfile(liveProfile.name)) {
        // Order matters: deleting the tag first would leave a warrden-owned profile
        // pinned to a now-dead tag id in the arr — a silently inert pin. `profileRow`'s
        // registered id is the same one `liveProfile` was matched on, so it's used here
        // directly rather than asserting `liveProfile.id` (typed optional) non-null.
        await client.deleteReleaseProfile(profileRow.external_id);
        profileDeleted = true;
      } else {
        // pinReleaseGroup can adopt a *user's* profile by tag membership rather than by
        // name (see its comment on matching by tag). Never delete something we didn't
        // name — drop only our registry's claim on it and say so.
        skipTagArrDeletion = true;
        ctx.events.append({
          kind: 'reconcile.gc-skip-profile',
          level: 'warn',
          message: `Skipped deleting non-warrden-named release profile "${liveProfile.name}" (id ${liveProfile.id}) on "${name}" — removed registry entries for the profile and its tag, but left both live in the arr (deleting the tag would cascade into stripping it from this profile too, leaving it with no tags — which Sonarr treats as matching every series)`,
          data: { instance: name, profileId: liveProfile.id, group },
        });
      }
    }
    // liveProfile === undefined means it's already gone from the arr (deleted out-of-band,
    // or a previous GC pass got the profile but crashed before this registry delete) — the
    // registry row is just stale bookkeeping at that point, dropped either way.
    managedObjects.delete(name, 'release_profile', profileRow.external_id);
  }

  // Widen the guard beyond the ONE group-matched profile above: Sonarr's tag-delete cascade
  // strips the tag from EVERY profile referencing it, so any OTHER live profile — not just
  // the one this registry happens to have a row for — that isn't warrden-named and still
  // carries this tag id must block the arr-side delete the same way, or it silently ends up
  // with an empty `tags` list (which Sonarr treats as matching every series). Matches the
  // same all-live-profiles scan `deleteObject.ts`'s `deleteInArr` does for a manual delete.
  const foreignCarriers = foreignProfilesCarryingTag(liveProfiles, tagRow.external_id);
  if (!skipTagArrDeletion && foreignCarriers.length > 0) {
    skipTagArrDeletion = true;
    ctx.events.append({
      kind: 'reconcile.gc-skip-tag-foreign-profile',
      level: 'warn',
      message: `Skipped deleting tag id ${tagRow.external_id} for group "${group}" on "${name}" — still carried by non-warrden release profile(s) (${foreignCarriers.map((p) => p.name).join(', ')}); deleting it would cascade into stripping it from them, leaving them with no tags (which Sonarr treats as matching every series)`,
      data: { instance: name, tagId: tagRow.external_id, group, foreignProfileIds: foreignCarriers.map((p) => p.id) },
    });
  }

  let tagDeleted = false;
  const liveTag = liveTags.find((t) => t.id === tagRow.external_id);
  if (liveTag && !skipTagArrDeletion) {
    if (isWarrdenTag(liveTag.label)) {
      await client.deleteTag(tagRow.external_id);
      tagDeleted = true;
    } else {
      // Same safety net as the profile above: pinReleaseGroup only ever registers tags it
      // created itself, so this shouldn't happen — but never delete an arr object we didn't
      // name, on the off chance the registry ever disagrees with reality.
      ctx.events.append({
        kind: 'reconcile.gc-skip-tag',
        level: 'warn',
        message: `Skipped deleting non-warrden-named tag "${liveTag.label}" (id ${liveTag.id}) on "${name}" — removed registry entry only`,
        data: { instance: name, tagId: liveTag.id, group },
      });
    }
  }
  // Not deleted from the arr here either because it's already gone (out-of-band delete, or
  // a crash between a previous pass's arr-side delete and this registry delete) or because
  // `skipTagArrDeletion` vetoed it above — either way the registry row is stale bookkeeping
  // at this point, dropped regardless.
  managedObjects.delete(name, 'tag', tagRow.external_id);

  const deleted = profileDeleted || tagDeleted;
  ctx.events.append({
    kind: 'reconcile.gc',
    message: deleted
      ? `GC'd orphaned warrden tag/profile for group "${group}" on "${name}"`
      : `Cleaned up stale managed_objects registry entries for group "${group}" on "${name}" — nothing live was actually deleted (already gone, or protected by a safety net)`,
    data: { instance: name, tagId: tagRow.external_id, group, deleted, profileDeleted, tagDeleted },
  });
}
