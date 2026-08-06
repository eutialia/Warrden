import type Database from 'better-sqlite3';
import type { ArrApi, MovieResource, SeriesResource } from '../arr/types.js';
import type { AppContext } from '../context.js';
import { ManagedObjects, type ManagedObjectRow } from '../db/managedObjects.js';
import type { TargetKind } from '../jobs/queue.js';

const RECONCILE_SOURCE = 'reconcile';
const WARRDEN_PROFILE_PREFIX = 'warrden: ';

interface Resource {
  id: number;
  title: string;
  kind: TargetKind;
}

/**
 * Runs one reconciliation pass over every configured arr instance: catches up on
 * series/movies a webhook missed (arr was down, a webhook got dropped, etc.), and garbage
 * collects `warrden-` tags/profiles nothing needs anymore. Never throws — a failure
 * against one instance is reported as a `warn` event and does not stop the rest, and the
 * two phases (missed-adds, then GC) are independent so a GC bug can't block missed-add
 * detection or vice versa.
 *
 * The very first reconciliation for a given instance is a *bootstrap*, not a catch-up: an
 * instance's whole existing library would otherwise look "missed" and mass-enqueue every
 * series/movie it already has. So instead, the first run only records what's already there
 * (`sync_state['seen:<name>']`) and marks `sync_state['bootstrap:<name>']`, with nothing
 * enqueued. Every run after that treats new ids in the arr's list as genuinely new.
 */
export async function reconcile(ctx: AppContext): Promise<void> {
  const seriesByInstance = new Map<string, SeriesResource[]>();

  for (const [name, client] of ctx.clients) {
    try {
      const { series, movies } = await fetchInstanceResources(ctx, name, client);
      seriesByInstance.set(name, series);
      reconcileInstance(ctx, name, toResources(series, movies));
    } catch (err) {
      ctx.events.append({
        kind: 'reconcile.failed',
        level: 'warn',
        message: `Reconcile failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        data: { instance: name },
      });
    }
  }

  await gc(ctx, seriesByInstance);
}

/** Fetches the resource list(s) relevant to `name`'s configured kind: only series for a
 * `sonarr` instance, only movies for `radarr`, or both when the instance isn't in
 * `ctx.config.arrs` at all (an `ArrApi` registered without matching config) — safer than
 * guessing wrong and silently skipping an instance's actual library. Skipping the
 * irrelevant call for a known kind also avoids hitting an endpoint the real arr flavor
 * doesn't implement (Sonarr has no `/movie`, Radarr no `/series`) on every single pass. */
async function fetchInstanceResources(
  ctx: AppContext,
  name: string,
  client: ArrApi,
): Promise<{ series: SeriesResource[]; movies: MovieResource[] }> {
  const kind = ctx.config.arrs.find((a) => a.name === name)?.kind;
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

function reconcileInstance(ctx: AppContext, name: string, resources: Resource[]): void {
  const bootstrapKey = `bootstrap:${name}`;
  const seenKey = `seen:${name}`;
  const currentIds = new Set(resources.map((r) => r.id));

  if (readState<boolean>(ctx.db, bootstrapKey) !== true) {
    writeState(ctx.db, seenKey, [...currentIds]);
    writeState(ctx.db, bootstrapKey, true);
    ctx.events.append({
      kind: 'reconcile.bootstrapped',
      message: `Bootstrapped "${name}" with ${currentIds.size} existing item(s); nothing enqueued`,
      data: { instance: name, count: currentIds.size },
    });
    return;
  }

  const seenIds = new Set<number>(readState<number[]>(ctx.db, seenKey) ?? []);
  const missed = resources.filter((r) => !seenIds.has(r.id));

  for (const r of missed) {
    ctx.queue.enqueue({
      pipeline: 'acquire',
      targetKind: r.kind,
      targetId: r.id,
      arrInstance: name,
      payload: { title: r.title, source: RECONCILE_SOURCE },
    });
    seenIds.add(r.id);
  }

  if (missed.length > 0) {
    ctx.events.append({
      kind: 'reconcile.missed-adds',
      message: `Enqueued ${missed.length} item(s) on "${name}" missed by webhooks`,
      data: { instance: name, count: missed.length, ids: missed.map((r) => r.id) },
    });
  }

  // Ids no longer present in the arr's own list (deleted series/movies) drop out of `seen`
  // rather than lingering forever — otherwise a later re-add of the same id would be
  // silently treated as already-seen instead of enqueued again.
  writeState(
    ctx.db,
    seenKey,
    [...seenIds].filter((id) => currentIds.has(id)),
  );
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
    const client = ctx.clients.get(name);
    const series = seriesByInstance.get(name);
    if (!client || !series) continue;

    try {
      await gcInstance(ctx, managedObjects, name, client, series, tagRows);
    } catch (err) {
      ctx.events.append({
        kind: 'reconcile.gc-failed',
        level: 'warn',
        message: `GC failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
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
  const liveProfiles = await client.listReleaseProfiles();

  for (const tagRow of tagRows) {
    if (series.some((s) => s.tags.includes(tagRow.external_id))) continue; // still pinned to a series

    const group = (tagRow.data as { group?: string }).group;
    const profileRow = profileRows.find((p) => (p.data as { group?: string }).group === group);
    const liveProfile = profileRow ? liveProfiles.find((p) => p.id === profileRow.external_id) : undefined;
    // A profile not carrying this exact tag id isn't necessarily orphaned by *this* tag's
    // orphan-ness alone — check every tag id it currently carries, not just this one.
    const profileTagIds = liveProfile?.tags ?? [tagRow.external_id];
    if (series.some((s) => s.tags.some((t) => profileTagIds.includes(t)))) continue; // profile still serves another series

    if (profileRow) {
      if (liveProfile) {
        if (liveProfile.name.startsWith(WARRDEN_PROFILE_PREFIX)) {
          // Order matters: deleting the tag first would leave a warrden-owned profile
          // pinned to a now-dead tag id in the arr — a silently inert pin.
          await client.deleteReleaseProfile(liveProfile.id!);
        } else {
          // pinReleaseGroup can adopt a *user's* profile by tag membership rather than by
          // name (see its comment on matching by tag). Never delete something we didn't
          // name — drop only our registry's claim on it and say so.
          ctx.events.append({
            kind: 'reconcile.gc-skip-profile',
            level: 'warn',
            message: `Skipped deleting non-warrden-named release profile "${liveProfile.name}" (id ${liveProfile.id}) on "${name}" — removed registry entry only`,
            data: { instance: name, profileId: liveProfile.id, group },
          });
        }
      }
      managedObjects.delete(name, 'release_profile', profileRow.external_id);
    }

    await client.deleteTag(tagRow.external_id);
    managedObjects.delete(name, 'tag', tagRow.external_id);

    ctx.events.append({
      kind: 'reconcile.gc',
      message: `GC'd orphaned warrden tag/profile for group "${group}" on "${name}"`,
      data: { instance: name, tagId: tagRow.external_id, group },
    });
  }
}

function readState<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.value) as T);
}

function writeState(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}
