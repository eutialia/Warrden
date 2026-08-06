import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { vi } from 'vitest';
import type {
  ArrApi,
  MovieResource,
  NotificationSummary,
  ReleaseCandidate,
  ReleaseProfileResource,
  SeriesResource,
  TagResource,
} from '../src/arr/types.js';
import type { AppContext } from '../src/context.js';
import type { ArrInstance, Config } from '../src/config/schema.js';
import { ConfigSchema } from '../src/config/schema.js';
import { openDb } from '../src/db/db.js';
import { EventLog } from '../src/events/log.js';
import { JobQueue } from '../src/jobs/queue.js';
import type { GenerateOpts, StructuredGenerator } from '../src/llm/generator.js';
import { BYTES_PER_GB } from '../src/util/bytes.js';

const createdDirs: string[] = [];
const openDbs: Database.Database[] = [];

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
 * event log, default config, and an empty arr clients map. Individual fields can be
 * swapped via `overrides` — notably `db`: if given, `queue`/`events` are built on
 * *that* db (not a second, orphaned one), so a caller providing its own db can still
 * see everything the queue/event log write.
 */
export function makeCtx(overrides?: Partial<AppContext>): AppContext {
  const db = overrides?.db ?? freshDb();
  return {
    db,
    config: ConfigSchema.parse({}),
    queue: new JobQueue(db),
    events: new EventLog(db),
    clients: new Map<string, ArrApi>(),
    llm: new FakeGenerator(),
    ...overrides,
  };
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
  private readonly validate: boolean;

  /**
   * `validate: false` (default `true`) skips parsing queued results through
   * `opts.schema`, returning them as-is — lets a test queue a schema-invalid
   * shape to exercise a pipeline's own handling of a malformed LLM response,
   * instead of every fixture being forced through zod first.
   */
  constructor(queue: unknown[] = [], opts?: { validate?: boolean }) {
    this.queue = [...queue];
    this.validate = opts?.validate ?? true;
  }

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    this.calls.push(opts as GenerateOpts<unknown>);
    if (this.queue.length === 0) {
      throw new Error(`FakeGenerator: no queued result for call #${this.calls.length} (callsite "${opts.callsite}")`);
    }
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return this.validate ? opts.schema.parse(next) : (next as T);
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
}

export interface FakeArrClient extends ArrApi {
  series: SeriesResource[];
  movies: MovieResource[];
  tags: TagResource[];
  profiles: ReleaseProfileResource[];
  releases: ReleaseCandidate[];
  notifications: NotificationSummary[];
  /** Every `grabRelease` call, recorded in order — the pipeline test's grab assertion. */
  grabbed: Array<{ guid: string; indexerId: number }>;
  /** Seeds a tag directly into the store, bypassing `createTag`'s auto id — for tests
   * that need a pre-existing tag with a specific id/label already in place. */
  pushTag(tag: TagResource): TagResource;
  /** Same as `pushTag`, for release profiles. */
  pushProfile(profile: ReleaseProfileResource): ReleaseProfileResource;
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
    grabbed: [],

    systemStatus: vi.fn(async (): Promise<unknown> => ({})),

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
      async (_params: { seriesId?: number; seasonNumber?: number; movieId?: number }): Promise<ReleaseCandidate[]> => [
        ...client.releases,
      ],
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
    deleteReleaseProfile: vi.fn(async (id: number): Promise<void> => {
      client.profiles = client.profiles.filter((p) => p.id !== id);
    }),
    async listNotifications(): Promise<NotificationSummary[]> {
      return [...client.notifications];
    },
    createNotification: vi.fn(async (body: object): Promise<NotificationSummary> => {
      const created: NotificationSummary = { id: nextNotificationId++, name: (body as { name: string }).name };
      client.notifications.push(created);
      return created;
    }),
    deleteNotification: vi.fn(async (id: number): Promise<void> => {
      client.notifications = client.notifications.filter((n) => n.id !== id);
    }),

    pushTag(tag: TagResource): TagResource {
      client.tags.push(tag);
      return tag;
    },
    pushProfile(profile: ReleaseProfileResource): ReleaseProfileResource {
      client.profiles.push(profile);
      return profile;
    },
  };

  return client;
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
