import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ArrApi, ReleaseCandidate } from '../src/arr/types.js';
import type { AppContext } from '../src/context.js';
import type { ArrInstance, Config } from '../src/config/schema.js';
import { ConfigSchema } from '../src/config/schema.js';
import { openDb } from '../src/db/db.js';
import { EventLog } from '../src/events/log.js';
import { JobQueue } from '../src/jobs/queue.js';
import type { GenerateOpts, StructuredGenerator } from '../src/llm/generator.js';

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
    size: Math.round(1.4 * 1_073_741_824),
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
