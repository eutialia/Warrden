import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { vi } from 'vitest';
import type {
  ArrApi,
  EpisodeFileResource,
  EpisodeResource,
  HistoryRecord,
  ManualImportFile,
  ManualImportItem,
  MovieFileResource,
  MovieResource,
  NotificationSummary,
  QueueRecord,
  ReleaseCandidate,
  ReleaseProfileResource,
  SeriesResource,
  TagResource,
} from '../src/arr/types.js';
import type { AppContext } from '../src/context.js';
import type { ArrInstance, Config } from '../src/config/schema.js';
import { ConfigSchema } from '../src/config/schema.js';
import { openDb } from '../src/db/db.js';
import { EventLog, type EventRow } from '../src/events/log.js';
import { JobQueue, type EnqueueInput, type JobRow, type TargetKind } from '../src/jobs/queue.js';
import type { GenerateOpts, StructuredGenerator } from '../src/llm/generator.js';
import { BYTES_PER_GB } from '../src/util/bytes.js';

const createdDirs: string[] = [];
const openDbs: Database.Database[] = [];

/**
 * Runs `fn` under `vi.useFakeTimers()`, restoring real timers afterward even if `fn`
 * throws — the `vi.useFakeTimers(); try { ... } finally { vi.useRealTimers(); }` wrapper
 * every test needing `vi.setSystemTime` inside a single test body repeats. Returns
 * whatever `fn` returns, so a test can still assert on it directly. Async-aware: an `fn`
 * that returns a `Promise` keeps fake timers active until that promise settles (real
 * timers restored via `.finally`) rather than switching back the instant `fn()` itself
 * returns — a plain synchronous `finally` would restore real time before an `await`ed
 * body actually finished running.
 */
export function withFakeTime<T>(fn: () => T): T {
  vi.useFakeTimers();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    vi.useRealTimers();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => vi.useRealTimers()) as T;
  }
  vi.useRealTimers();
  return result;
}

/** Creates a fresh temp directory for a test, e.g. as a data dir for config/db files. */
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warrden-'));
  createdDirs.push(dir);
  return dir;
}

/** Opens a fresh SQLite db in a new temp dir. Closed and cleaned up via cleanupTmpDirs(). */
export function freshDb(): Database.Database {
  const db = openDb(tmpDir());
  openDbs.push(db);
  return db;
}

/**
 * Builds a real `AppContext` backed by a fresh temp db, wired with a real queue and
 * event log, default config, its own fresh temp `dataDir` (for `PUT /api/config` to
 * `saveConfig` into), and an empty arr clients map. Individual fields can be
 * swapped via `overrides` — notably `db`: if given, `queue`/`events` are built on
 * *that* db (not a second, orphaned one), so a caller providing its own db can still
 * see everything the queue/event log write.
 */
export function makeCtx(overrides?: Partial<AppContext>): AppContext {
  const db = overrides?.db ?? freshDb();
  return {
    db,
    config: ConfigSchema.parse({}),
    dataDir: tmpDir(),
    queue: new JobQueue(db),
    events: new EventLog(db),
    clients: new Map<string, ArrApi>(),
    llm: new FakeGenerator(),
    ...overrides,
  };
}

/** The first event of `kind` in `events` (`ctx.events.list()`'s result, or a subset of
 * it) — replaces the repeated `events.find((e) => e.kind === 'x')`. */
export function findEvent(events: EventRow[], kind: string): EventRow | undefined {
  return events.find((e) => e.kind === kind);
}

/** Whether any event of `kind` is present in `events` — replaces the repeated
 * `events.some((e) => e.kind === 'x')`. */
export function hasEvent(events: EventRow[], kind: string): boolean {
  return events.some((e) => e.kind === kind);
}

/**
 * `makeCtx` wired with one `ArrApi` under `name` — the single-instance shape the vast
 * majority of tests need, instead of hand-building `clients: new Map([[name, client]])`
 * every time. Deliberately does NOT also wire `config.arrs` for `name` (unlike
 * `ingestFixture`, which needs both to agree) — several tests rely on `ctx.clients` and
 * `ctx.config.arrs` disagreeing (or `config.arrs` being empty) to exercise the drift
 * between them (see e.g. `webhooks.ts`'s and `reconcile.ts`'s own comments on why they
 * check `ctx.clients`, not `config.arrs`); pass `{ config: configWithArrs(name) }` via
 * `overrides` for a test that wants both to agree.
 */
export function ctxWithClient(name: string, client: ArrApi, overrides?: Partial<AppContext>): AppContext {
  return makeCtx({ clients: new Map([[name, client]]), ...overrides });
}

/**
 * Enqueues `input` on `ctx.queue` and immediately claims it — the `enqueue()` → `claim()`
 * pair nearly every acquire pipeline test repeats to get a claimed `JobRow` to hand
 * `runAcquireJob`. Never returns `null`: nothing else could have claimed it first in a
 * single-threaded test, so a `null` here means the test's own setup is broken, not a race
 * to paper over.
 */
export function enqueueAndClaim(ctx: AppContext, input: EnqueueInput): JobRow {
  ctx.queue.enqueue(input);
  const job = ctx.queue.claim();
  if (!job) throw new Error('enqueueAndClaim: claim() unexpectedly returned null right after enqueue()');
  return job;
}

/** A default `Config` (schema defaults only) for tests that build their own `llm.profiles` entries. */
export function baseConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Fake `StructuredGenerator` for pipeline tests: queue up results (or `Error`s to throw) via
 * the constructor, consumed one per `generate()` call in order. Every call's `opts` is recorded
 * in `calls` so tests can assert on prompts/schemas/callsites without a real LLM. Queued results
 * are parsed through `opts.schema`, same as the real generator would validate an LLM response,
 * so a fixture shaped wrong for the callsite under test fails loudly instead of masking a bug.
 */
export class FakeGenerator implements StructuredGenerator {
  calls: GenerateOpts<unknown>[] = [];
  private readonly queue: unknown[];

  constructor(queue: unknown[] = []) {
    this.queue = [...queue];
  }

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    this.calls.push(opts as GenerateOpts<unknown>);
    if (this.queue.length === 0) {
      throw new Error(`FakeGenerator: no queued result for call #${this.calls.length} (callsite "${opts.callsite}")`);
    }
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return opts.schema.parse(next);
  }
}

/**
 * Directly seeds a `managed_objects` row for a `warrden-` tag and/or its release profile,
 * bypassing `pinReleaseGroup` — for reconcile/GC tests that need a registry row already in
 * place (at a specific `createdAt`, often backdated past GC's grace window) without caring
 * how it got there. Pass only `tag` or only `profile` for a test that seeds one without the
 * other (e.g. a tag registered without ever getting a matching profile row).
 */
export function seedManagedPin(
  db: Database.Database,
  opts: {
    arrInstance: string;
    group: string;
    createdAt: number;
    tag?: { id: number; label: string };
    // `id` is optional here only to accept a `pushProfile()` return value as-is (its type
    // is the general `ReleaseProfileResource`, whose `id` is optional for the create-body
    // case) — `pushProfile` itself always assigns one, so this asserts that rather than
    // widening every caller to handle a case that can't actually happen in a test.
    profile?: { id?: number; name: string };
  },
): void {
  const data = JSON.stringify({ group: opts.group });
  const insert = db.prepare(
    `INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (opts.tag) {
    insert.run(opts.arrInstance, 'tag', opts.tag.id, opts.tag.label, data, opts.createdAt);
  }
  if (opts.profile) {
    if (opts.profile.id === undefined) throw new Error('seedManagedPin: profile.id is required');
    insert.run(opts.arrInstance, 'release_profile', opts.profile.id, opts.profile.name, data, opts.createdAt);
  }
}

/** A valid `ArrInstance` config entry, defaulting to a `sonarr` instance named "sonarr". */
export function arrInstance(overrides?: Partial<ArrInstance>): ArrInstance {
  return {
    name: 'sonarr',
    kind: 'sonarr',
    baseUrl: 'http://localhost:8989',
    apiKey: 'test-api-key',
    ...overrides,
  };
}

/** Default config with the given arr instances configured (by name, `sonarr`/`radarr` shorthand). */
export function configWithArrs(...names: Array<'sonarr' | 'radarr'>): Config {
  return ConfigSchema.parse({
    arrs: names.map((name) => arrInstance({ name, kind: name, baseUrl: `http://${name}:0` })),
  });
}

export interface FakeArrClientSeed {
  series?: SeriesResource[];
  movies?: MovieResource[];
  tags?: TagResource[];
  profiles?: ReleaseProfileResource[];
  releases?: ReleaseCandidate[];
  notifications?: NotificationSummary[];
  queue?: QueueRecord[];
  seriesHistory?: HistoryRecord[];
  movieHistory?: HistoryRecord[];
  episodes?: EpisodeResource[];
  episodeFiles?: EpisodeFileResource[];
  movieFiles?: MovieFileResource[];
  /** Seeds `listManualImport`'s per-scope responses — see `FakeArrClient.manualImportByScope`. */
  manualImportByScope?: Record<string, ManualImportItem[]>;
}

export interface FakeArrClient extends ArrApi {
  series: SeriesResource[];
  movies: MovieResource[];
  tags: TagResource[];
  profiles: ReleaseProfileResource[];
  releases: ReleaseCandidate[];
  notifications: NotificationSummary[];
  // Ingest pipeline reads — plain mutable arrays (not vi.fn-wrapped) since ingest tests
  // seed and re-read them directly rather than asserting on call args.
  queue: QueueRecord[];
  seriesHistory: HistoryRecord[];
  movieHistory: HistoryRecord[];
  episodes: EpisodeResource[];
  episodeFiles: EpisodeFileResource[];
  movieFiles: MovieFileResource[];
  /** Every `grabRelease` call, recorded in order — the pipeline test's grab assertion. */
  grabbed: Array<{ guid: string; indexerId: number }>;
  /** `listManualImport`'s canned responses, keyed by `` `downloadId:${id}` `` or
   * `` `folder:${path}` `` (whichever the call under test is scoped by) — a test seeds
   * this directly (`client.manualImportByScope['downloadId:dl-1'] = [...]`) rather than
   * the fake replicating the arr's own manual-import query semantics. An unseeded scope
   * returns `[]`, same as "nothing left to import". */
  manualImportByScope: Record<string, ManualImportItem[]>;
  /** Seeds a tag directly into the store, auto-assigning an id the same way `createTag`
   * would — for tests that need a pre-existing tag without going through `pinReleaseGroup`. */
  pushTag(label: string): TagResource;
  /** Same as `pushTag`, for release profiles: auto-assigns an id like `createReleaseProfile` would. */
  pushProfile(profile: Omit<ReleaseProfileResource, 'id'>): ReleaseProfileResource;
}

/**
 * In-memory `ArrApi` stand-in for pipeline tests (pin, acquire run, webhook
 * registration): mutable arrays (`series`/`tags`/`profiles`/`releases`/`notifications`)
 * double as both seed data and the live store the mutating methods read/write, so a test
 * can seed state up front and read it straight back after exercising the pipeline (e.g.
 * `client.series[0].tags` after a pin, `client.grabbed` after a grab). Mutating methods
 * (create/update/delete/grab) are `vi.fn`-wrapped so a test can also assert exact call
 * args (`toHaveBeenCalledWith`) instead of only inspecting the resulting state.
 */
export function fakeArrClient(seed?: FakeArrClientSeed): FakeArrClient {
  let nextTagId = 1;
  let nextProfileId = 1;
  let nextNotificationId = 1;

  const client: FakeArrClient = {
    series: (seed?.series ?? []).map((s) => ({ ...s, tags: [...s.tags] })),
    movies: seed?.movies ? [...seed.movies] : [],
    tags: seed?.tags ? [...seed.tags] : [],
    profiles: seed?.profiles ? [...seed.profiles] : [],
    releases: seed?.releases ? [...seed.releases] : [],
    notifications: seed?.notifications ? [...seed.notifications] : [],
    queue: seed?.queue ? [...seed.queue] : [],
    seriesHistory: seed?.seriesHistory ? [...seed.seriesHistory] : [],
    movieHistory: seed?.movieHistory ? [...seed.movieHistory] : [],
    episodes: seed?.episodes ? [...seed.episodes] : [],
    episodeFiles: seed?.episodeFiles ? [...seed.episodeFiles] : [],
    movieFiles: seed?.movieFiles ? [...seed.movieFiles] : [],
    grabbed: [],
    manualImportByScope: seed?.manualImportByScope ? { ...seed.manualImportByScope } : {},

    async listSeries(): Promise<SeriesResource[]> {
      return client.series.map((s) => ({ ...s, tags: [...s.tags] }));
    },
    listMovies: vi.fn(async (): Promise<MovieResource[]> => [...client.movies]),
    async getSeries(id: number): Promise<SeriesResource> {
      const s = client.series.find((x) => x.id === id);
      if (!s) throw new Error(`fakeArrClient: no series with id ${id}`);
      return { ...s, tags: [...s.tags] };
    },
    updateSeries: vi.fn(async (s: SeriesResource): Promise<SeriesResource> => {
      const idx = client.series.findIndex((x) => x.id === s.id);
      if (idx === -1) throw new Error(`fakeArrClient: no series with id ${s.id}`);
      client.series[idx] = { ...s, tags: [...s.tags] };
      return client.series[idx];
    }),
    searchReleases: vi.fn(
      async (params: { seriesId?: number; seasonNumber?: number; movieId?: number }): Promise<ReleaseCandidate[]> => {
        // Mirrors Sonarr's actual `ReleaseController`: a `seriesId` search without a
        // `seasonNumber` falls through to `GetRss()` (the full RSS feed) server-side —
        // unrelated candidates, wrong-series grabs. A real caller must always pass both
        // together for a series search; this throws instead of silently returning
        // `client.releases` so a regression back to `{seriesId}`-only search fails loudly.
        if (params.seriesId !== undefined && params.seasonNumber === undefined) {
          throw new Error(
            'fakeArrClient.searchReleases: seriesId given without seasonNumber — this would hit Sonarr\'s GetRss() fallback in the real API, not a per-series search',
          );
        }
        return [...client.releases];
      },
    ),
    grabRelease: vi.fn(async (guid: string, indexerId: number): Promise<void> => {
      client.grabbed.push({ guid, indexerId });
    }),
    async listTags(): Promise<TagResource[]> {
      return [...client.tags];
    },
    createTag: vi.fn(async (label: string): Promise<TagResource> => {
      const tag: TagResource = { id: nextTagId++, label };
      client.tags.push(tag);
      return tag;
    }),
    deleteTag: vi.fn(async (id: number): Promise<void> => {
      client.tags = client.tags.filter((t) => t.id !== id);
    }),
    async listReleaseProfiles(): Promise<ReleaseProfileResource[]> {
      return [...client.profiles];
    },
    createReleaseProfile: vi.fn(async (p: ReleaseProfileResource): Promise<ReleaseProfileResource> => {
      const profile: ReleaseProfileResource = { ...p, id: nextProfileId++ };
      client.profiles.push(profile);
      return profile;
    }),
    updateReleaseProfile: vi.fn(async (p: ReleaseProfileResource): Promise<ReleaseProfileResource> => {
      const idx = client.profiles.findIndex((x) => x.id === p.id);
      if (idx === -1) throw new Error(`fakeArrClient: no release profile with id ${p.id}`);
      client.profiles[idx] = { ...p };
      return client.profiles[idx];
    }),
    deleteReleaseProfile: vi.fn(async (id: number): Promise<void> => {
      client.profiles = client.profiles.filter((p) => p.id !== id);
    }),
    async listNotifications(): Promise<NotificationSummary[]> {
      return [...client.notifications];
    },
    createNotification: vi.fn(async (body: object): Promise<NotificationSummary> => {
      const b = body as { name: string; onDownload?: boolean; onUpgrade?: boolean };
      const created: NotificationSummary = {
        id: nextNotificationId++,
        name: b.name,
        onDownload: b.onDownload,
        onUpgrade: b.onUpgrade,
      };
      client.notifications.push(created);
      return created;
    }),

    listQueue: async (): Promise<QueueRecord[]> => [...client.queue],
    listSeriesHistory: async (): Promise<HistoryRecord[]> => [...client.seriesHistory],
    listMovieHistory: async (): Promise<HistoryRecord[]> => [...client.movieHistory],
    listRecentImports: async (): Promise<HistoryRecord[]> => [],
    listEpisodes: async (): Promise<EpisodeResource[]> => [...client.episodes],
    listEpisodeFiles: async (): Promise<EpisodeFileResource[]> => [...client.episodeFiles],
    listMovieFiles: async (): Promise<MovieFileResource[]> => [...client.movieFiles],
    listManualImport: vi.fn(
      async (p: {
        folder?: string;
        downloadId?: string;
        seriesId?: number;
        movieId?: number;
        filterExistingFiles?: boolean;
      }): Promise<ManualImportItem[]> => {
        // Real Sonarr/Radarr manual-import scopes are exclusive (a `downloadId` lookup
        // vs. a `folder` lookup) — mirrored here rather than merging both, so a caller
        // accidentally passing both would silently only hit the `downloadId` branch, same
        // as it would against a real arr.
        if (p.downloadId !== undefined) return [...(client.manualImportByScope[`downloadId:${p.downloadId}`] ?? [])];
        if (p.folder !== undefined) return [...(client.manualImportByScope[`folder:${p.folder}`] ?? [])];
        return [];
      },
    ),
    executeManualImport: vi.fn(async (): Promise<void> => {}),
    deleteNotification: vi.fn(async (id: number): Promise<void> => {
      client.notifications = client.notifications.filter((n) => n.id !== id);
    }),

    pushTag(label: string): TagResource {
      const tag: TagResource = { id: nextTagId++, label };
      client.tags.push(tag);
      return tag;
    },
    pushProfile(profile: Omit<ReleaseProfileResource, 'id'>): ReleaseProfileResource {
      const created: ReleaseProfileResource = { ...profile, id: nextProfileId++ };
      client.profiles.push(created);
      return created;
    },
  };

  return client;
}

/**
 * A `SeriesResource` fixture with sane defaults (one monitored season, `#1`) — override
 * any field, most commonly `seasons`, for a test exercising per-season search (see
 * `runAcquireJob`'s series branch in `src/pipelines/acquire/run.ts`).
 */
export function seriesResource(overrides?: Partial<SeriesResource>): SeriesResource {
  return {
    id: 42,
    title: 'Frieren',
    year: 2023,
    tvdbId: 1,
    tags: [],
    added: '',
    seasons: [{ seasonNumber: 1, monitored: true }],
    ...overrides,
  };
}

/**
 * A `MovieResource` fixture with sane defaults (id 7, unfiled) — override `hasFile` for a
 * test exercising the movie occupied-slot guards (ingest's rescueMovie, acquire's
 * double-grab guard).
 */
export function movieResource(overrides?: Partial<MovieResource>): MovieResource {
  return {
    id: 7,
    title: 'Perfect Blue',
    year: 1997,
    tmdbId: 573,
    added: '',
    hasFile: false,
    ...overrides,
  };
}

/**
 * An `EpisodeResource` fixture with sane defaults (series #42, S01E01, has a file on
 * disk) — override any field, most commonly `seasonNumber`/`episodeNumber`/
 * `absoluteEpisodeNumber`, for a test exercising sidecar matching (see
 * `matchSidecarDeterministic` in `src/pipelines/ingest/sidecars.ts`).
 */
export function episodeResource(overrides?: Partial<EpisodeResource>): EpisodeResource {
  return {
    id: 1,
    seriesId: 42,
    seasonNumber: 1,
    episodeNumber: 1,
    title: '',
    episodeFileId: 1,
    hasFile: true,
    ...overrides,
  };
}

export interface IngestFixture {
  ctx: AppContext;
  client: FakeArrClient;
  arrInstance: string;
  targetKind: TargetKind;
  targetId: number;
  downloadsDir: string;
  torrentDir: string;
  libraryDir: string;
  /** The already-imported video sitting in `libraryDir`, matching `episodeFiles[0]`/`movieFiles[0]`. */
  videoPath: string;
  /** The `downloadFolderImported` history record's `droppedPath`, pointing into `torrentDir`. */
  droppedPath: string;
}

/**
 * Builds the filesystem + arr-client fixture every `runIngestJob` test needs: a temp
 * "downloads" dir containing one torrent folder, a temp "library" dir holding the
 * already-imported video, and a `fakeArrClient` wired so `listEpisodes`/`listEpisodeFiles`/
 * `listSeriesHistory` (or the movie equivalents) agree with that layout — one
 * `downloadFolderImported` history record whose `droppedPath` points into the torrent
 * folder, which is what `resolveSourceDirs` needs to find it. `pathMappings` are identity
 * (`from === to`) so a test exercises ingest's own logic without also exercising
 * `mapArrPath`'s translation. Doesn't enqueue or claim a job itself — call
 * `enqueueAndClaim(ctx, { pipeline: 'ingest', targetKind, targetId, arrInstance, ... })`
 * for that, same as the acquire pipeline's tests do.
 */
export function ingestFixture(opts?: {
  targetKind?: TargetKind;
  targetId?: number;
  seriesTitle?: string;
  torrentName?: string;
  videoFileName?: string;
  episodes?: EpisodeResource[];
  episodeFiles?: EpisodeFileResource[];
  movieFiles?: MovieFileResource[];
  mountMarkers?: string[];
}): IngestFixture {
  const targetKind = opts?.targetKind ?? 'series';
  const targetId = opts?.targetId ?? 42;
  const seriesTitle = opts?.seriesTitle ?? 'Frieren';
  const torrentName = opts?.torrentName ?? 'Show Torrent';
  const videoFileName = opts?.videoFileName ?? 'Show - S01E05.mkv';
  const arrInstanceName = targetKind === 'movie' ? 'radarr' : 'sonarr';

  const downloadsDir = tmpDir();
  const libraryDir = tmpDir();
  const torrentDir = join(downloadsDir, torrentName);
  mkdirSync(torrentDir, { recursive: true });

  const videoPath = join(libraryDir, videoFileName);
  writeFileSync(videoPath, 'video');
  // Doesn't need to exist on disk itself — resolveSourceDirs only parses the string to
  // locate the torrent's own root folder under downloadsDir.
  const droppedPath = join(torrentDir, videoFileName);

  const episodes = opts?.episodes ?? [
    episodeResource({ id: 1, seriesId: targetId, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
  ];
  const episodeFiles = opts?.episodeFiles ?? [{ id: 100, seriesId: targetId, seasonNumber: 1, relativePath: videoFileName, path: videoPath }];
  const movieFiles = opts?.movieFiles ?? [{ id: 200, movieId: targetId, relativePath: videoFileName, path: videoPath }];

  const history: HistoryRecord[] = [
    {
      id: 1,
      seriesId: targetKind === 'series' ? targetId : undefined,
      movieId: targetKind === 'movie' ? targetId : undefined,
      eventType: 'downloadFolderImported',
      date: new Date().toISOString(),
      sourceTitle: torrentName,
      data: { droppedPath },
    },
  ];

  const client = fakeArrClient({
    series: targetKind === 'series' ? [seriesResource({ id: targetId, title: seriesTitle })] : [],
    movies: targetKind === 'movie' ? [movieResource({ id: targetId, title: seriesTitle, year: 2024, tmdbId: 1, hasFile: true })] : [],
    seriesHistory: targetKind === 'series' ? history : [],
    movieHistory: targetKind === 'movie' ? history : [],
    episodes: targetKind === 'series' ? episodes : [],
    episodeFiles: targetKind === 'series' ? episodeFiles : [],
    movieFiles: targetKind === 'movie' ? movieFiles : [],
  });

  const ctx = makeCtx({
    clients: new Map([[arrInstanceName, client]]),
    config: ConfigSchema.parse({
      pathMappings: [
        { from: downloadsDir, to: downloadsDir },
        { from: libraryDir, to: libraryDir },
      ],
      ingest: { mountMarkers: opts?.mountMarkers ?? [], downloadRoots: [downloadsDir] },
    }),
  });

  return { ctx, client, arrInstance: arrInstanceName, targetKind, targetId, downloadsDir, torrentDir, libraryDir, videoPath, droppedPath };
}

/**
 * A `ManualImportItem` fixture with sane defaults (an unresolved video file with no
 * episode guess and no rejections) — override `episodes`/`rejections` to exercise the
 * arr-already-resolved path, or `path`/`size` for filename-matching/prompt-rendering
 * tests. Used by `planBundleImport` tests (`src/pipelines/ingest/bundle.ts`).
 */
export function manualImportItem(overrides?: Partial<ManualImportItem>): ManualImportItem {
  return {
    path: '/downloads/Show/Show - S01E01.mkv',
    folderName: 'Show',
    size: Math.round(1.4 * BYTES_PER_GB),
    quality: { quality: { id: 1, name: 'Bluray-1080p' } },
    languages: [{ id: 1, name: 'Japanese' }],
    episodes: [],
    releaseGroup: 'Group',
    rejections: [],
    ...overrides,
  };
}

/**
 * The raw shape `pickRelease` (`src/pipelines/acquire/pick.ts`) expects an LLM to answer
 * with — a `FakeGenerator` queue entry, not `PickResult` (`pickRelease`'s own resolved
 * output, which carries a `guid` instead of a candidate number and has no `candidate`
 * field at all). Defaults to a straightforward "pick candidate #1" answer; override
 * `decision: 'none'` along with `candidate`/`releaseGroup`/`confidence` (all `null` for a
 * `'none'` decision, per `LlmPickResponseSchema`) for the no-viable-candidate case.
 */
export function pickResponse(
  overrides?: Partial<{
    decision: 'pick' | 'none';
    candidate: number | null;
    releaseGroup: string | null;
    confidence: 'high' | 'medium' | 'low' | null;
    reasoning: string;
  }>,
): Record<string, unknown> {
  return {
    decision: 'pick',
    candidate: 1,
    releaseGroup: 'SubsPlease',
    confidence: 'high',
    reasoning: 'ok',
    ...overrides,
  };
}

/**
 * The raw shape `planBundleImport` (`src/pipelines/ingest/bundle.ts`) expects an LLM to
 * answer with — a `FakeGenerator` queue entry for the `bundle-map` callsite. Defaults to
 * one file mapped to no episode (the "not an episode" signal); override `mappings` for a
 * real file-to-episode(s) mapping.
 */
export function bundleResponse(
  overrides?: Partial<{
    mappings: { file: number; episodeIds: number[] }[];
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  }>,
): Record<string, unknown> {
  return {
    mappings: [{ file: 1, episodeIds: [] }],
    confidence: 'high',
    reasoning: 'ok',
    ...overrides,
  };
}

/**
 * A `ReleaseCandidate` fixture with sane defaults (a realistic 1080p dual-audio-style
 * anime release, ~1.4 GB, 25 seeders, not rejected) — override any field for the case
 * under test. Used by acquire pipeline tests (prefilter, pick) so each test only spells
 * out the fields it cares about.
 */
export function candidate(overrides?: Partial<ReleaseCandidate>): ReleaseCandidate {
  return {
    guid: 'release-guid-1',
    indexerId: 1,
    indexer: 'Nyaa',
    title: 'Sousou no Frieren - S01E01 [1080p][Dual Audio][HEVC 10bit]',
    size: Math.round(1.4 * BYTES_PER_GB),
    seeders: 25,
    leechers: 2,
    rejected: false,
    rejections: [],
    publishDate: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Closes every db opened via freshDb() and removes every directory created via
 * tmpDir() so far, in this test file's module instance. Called from tests/setup.ts —
 * `process.on('exit')` doesn't fire reliably under Vitest's worker pool, so cleanup
 * has to be a Vitest lifecycle hook instead.
 */
export function cleanupTmpDirs(): void {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
