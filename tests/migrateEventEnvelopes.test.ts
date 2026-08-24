import type Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATABLE_KINDS, migrateEventEnvelopes, parseComposedMessage } from '../src/db/migrateEventEnvelopes.js';
import { ensureEnvelope, readEnvelope } from '../src/events/envelope.js';
import { freshDb } from './helpers.js';

/**
 * Every fixture below is a REAL row, copied out of the dev database (`GET /api/jobs/45`,
 * `/46`, `/81`) before the migration ran — messages truncated where they were pages long,
 * `data` kept verbatim. Inventing tidier legacy shapes would test the fixture, not the
 * migration.
 */

interface Legacy {
  kind: string;
  message: string;
  data: Record<string, unknown>;
}

const FIXTURES: Legacy[] = [
  {
    kind: 'subtitle.transcript',
    message: '[subhd.tv] download: Downloading the Alicization WoU full-season pack. (https://dl.subhd.me/x.rar)',
    data: {
      instance: 'Sonarr',
      targetKind: 'series',
      targetId: 143,
      site: 'subhd.tv',
      entry: { ts: 1787363994912, tier: 'chromium', action: 'download', detail: 'Downloading the Alicization WoU full-season pack. (https://dl.subhd.me/x.rar)' },
    },
  },
  {
    kind: 'agent.stop',
    message: '[subhd.tv] round 1/3 (chromium): downloaded',
    data: { instance: 'Sonarr', targetKind: 'series', targetId: 143, site: 'subhd.tv', round: 1, maxRounds: 3, tier: 'chromium', steps: 4, stop: { kind: 'done' } },
  },
  {
    kind: 'acquire.grabbed',
    message: 'Grabbed "Sword Art Online S4 [1080P][Bluray][-TARDiS]" for "Sword Art Online Season 4"',
    data: { instance: 'Sonarr', targetKind: 'series', targetId: 143, seasonNumber: 4, guid: 'magnet:?xt=urn:btih:c69', releaseGroup: 'TARDiS' },
  },
  {
    kind: 'job.failed',
    message: "Job #66 (subtitle) failed: EACCES: permission denied, copyfile '/data/x.ass'",
    data: { pipeline: 'subtitle', retried: false, permanent: false },
  },
  {
    kind: 'job.rescheduled',
    message: 'Job #54 (ingest) rescheduled in 120s: arr still importing this target',
    data: { pipeline: 'ingest', delayMs: 120_000 },
  },
  {
    kind: 'webhook.received',
    message: 'Download for "Sword Art Online" (Sonarr)',
    data: { instance: 'Sonarr', eventType: 'Download', targetId: 143, outcome: 'coalesced', isUpgrade: false },
  },
  {
    kind: 'subtitle.unresolved',
    message: 'Sword Art Online: 2 episode(s) still without zh-Hans, zh-Hant (S2E21-E22)',
    data: {
      instance: 'Sonarr',
      targetKind: 'series',
      targetId: 143,
      dedupeKey: 'unresolved',
      episodes: [
        { episodeId: 6153, seasonNumber: 2, episodeNumber: 21, missingLanguages: ['zh-Hans', 'zh-Hant'], quarantined: 0 },
        { episodeId: 6154, seasonNumber: 2, episodeNumber: 22, missingLanguages: ['zh-Hans'], quarantined: 0 },
      ],
    },
  },
  {
    kind: 'subtitle.placed',
    message: 'Placed "SAO - S01E23.ja.ass" beside "SAO - S01E23.mkv"',
    data: { instance: 'Sonarr', targetKind: 'series', targetId: 143, sourcePath: '/cache/x.ass', placedPath: '/library/SAO - S01E23.ja.ass' },
  },
  {
    kind: 'subtitle.site-unusable',
    message: 'subhd.tv looks unusable: the download page blocked every request',
    data: {
      instance: 'subtitle-site',
      targetKind: 'site',
      targetId: 'subhd.tv',
      dedupeKey: 'subhd.tv',
      action: 'disable-site',
      baseUrl: 'https://subhd.tv',
      reason: 'the download page blocked every request',
      tiersAttempted: ['curl', 'chromium'],
      evidence: ['[chromium] search: …'],
    },
  },
  {
    kind: 'acquire.none-viable',
    message: 'Couldn\'t pick a release for "The Ramparts of Ice Season 1": no season pack',
    data: {
      instance: 'Sonarr',
      targetKind: 'series',
      targetId: 142,
      dedupeKey: '1',
      seasonNumber: 1,
      title: 'The Ramparts of Ice Season 1',
      reasoning: 'no season pack',
      action: 'force-grab',
      guid: 'g-top',
      indexerId: 3,
      pickedTitle: '[Trix] S01 Batch',
      releaseGroup: 'Trix',
    },
  },
  {
    kind: 'acquire.candidates-capped',
    message: 'Capped candidates for "The Ramparts of Ice Season 1" from 128 to 30 (dropped 98 candidate(s))',
    data: { title: 'The Ramparts of Ice', seasonNumber: 1, droppedCount: 98 },
  },
  {
    kind: 'reconcile.missed-imports',
    message: 'Enqueued 1 ingest job(s) on "Sonarr" for imports missed by webhooks',
    data: { instance: 'Sonarr', targets: ['series:143'] },
  },
];

function seed(db: Database.Database, rows: Legacy[]): void {
  const insert = db.prepare('INSERT INTO events (ts, kind, level, job_id, message, data) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((row, i) => insert.run(1000 + i, row.kind, 'info', 1, row.message, JSON.stringify(row.data)));
}

function pathOf(file: unknown): unknown {
  return typeof file === 'object' && file !== null ? (file as { path?: unknown }).path : file;
}

function dataById(db: Database.Database): Map<string, Record<string, unknown>> {
  const rows = db.prepare('SELECT kind, data FROM events').all() as { kind: string; data: string }[];
  return new Map(rows.map((r) => [r.kind, JSON.parse(r.data) as Record<string, unknown>]));
}

describe('parseComposedMessage', () => {
  it.each([
    { name: 'splits site, head and detail', message: '[subhd.tv] search: looked for the JP title', site: 'subhd.tv', head: 'search', detail: 'looked for the JP title' },
    {
      name: 'keeps a colon inside the detail',
      message: '[acg.rip] failed: Generation failed for callsite "site-search": rate-limited.',
      site: 'acg.rip',
      head: 'failed',
      detail: 'Generation failed for callsite "site-search": rate-limited.',
    },
    { name: 'spans newlines', message: '[x.tv] open: line one\nline two', site: 'x.tv', head: 'open', detail: 'line one\nline two' },
  ])('$name', ({ message, site, head, detail }) => {
    expect(parseComposedMessage(message)).toEqual({ site, head, detail });
  });

  it.each(['Download for "SAO" (Sonarr)', '[no colon here]', 'plain narration'])('is null for %s', (message) => {
    expect(parseComposedMessage(message)).toBeNull();
  });
});

describe('migrateEventEnvelopes', () => {
  it('gives every real legacy row an envelope, and deletes none of them', () => {
    const db = freshDb();
    seed(db, FIXTURES);

    const report = migrateEventEnvelopes(db);

    expect(report.total).toBe(FIXTURES.length);
    expect(report.deleted).toEqual({});
    expect(Object.values(report.migrated).reduce((a, b) => a + b, 0)).toBe(FIXTURES.length);
    for (const [kind, data] of dataById(db)) {
      expect(readEnvelope(data), kind).not.toBeNull();
    }
  });

  it.each([
    {
      kind: 'subtitle.transcript',
      expected: { scope: 'subtitle', action: 'step', facts: { site: 'subhd.tv', tier: 'chromium', detail: expect.stringContaining('Alicization') } },
    },
    {
      kind: 'agent.stop',
      expected: {
        scope: 'subtitle',
        action: 'visit',
        // The whole StopReason object collapses to its kind; the detail half of the
        // composed message becomes the reason.
        facts: { site: 'subhd.tv', round: 1, maxRounds: 3, tier: 'chromium', steps: 4, stop: 'done', reason: 'downloaded' },
        verdict: { tone: 'success' },
      },
    },
    {
      kind: 'acquire.grabbed',
      expected: {
        scope: 'acquire',
        action: 'pick',
        facts: { season: 4, counts: { grabbed: 1 }, release: { title: 'Sword Art Online S4 [1080P][Bluray][-TARDiS]', group: 'TARDiS' } },
        verdict: { tone: 'success' },
      },
    },
    {
      kind: 'job.failed',
      expected: { scope: 'run', action: 'finished', facts: { pipeline: 'subtitle', retried: false, permanent: false }, verdict: { tone: 'danger' } },
    },
    {
      kind: 'job.rescheduled',
      expected: { scope: 'run', action: 'rescheduled', facts: { pipeline: 'ingest', delayMs: 120_000, reason: 'arr still importing this target' } },
    },
    {
      kind: 'webhook.received',
      expected: { scope: 'trigger', action: 'webhook', facts: { source: 'webhook', eventType: 'Download', outcome: 'coalesced', reason: 'new' } },
    },
    {
      kind: 'subtitle.unresolved',
      expected: {
        scope: 'subtitle',
        action: 'unresolved',
        facts: {
          episodes: [
            { season: 2, episode: 21 },
            { season: 2, episode: 22 },
          ],
          languages: ['zh-Hans', 'zh-Hant'],
        },
      },
    },
    {
      kind: 'subtitle.placed',
      expected: { scope: 'subtitle', action: 'placed', facts: { file: { path: '/library/SAO - S01E23.ja.ass' }, sourcePath: '/cache/x.ass' } },
    },
    {
      kind: 'acquire.candidates-capped',
      expected: { scope: 'acquire', action: 'filter', facts: { title: 'The Ramparts of Ice', season: 1, counts: { capped: 98 } }, verdict: { tone: 'warning' } },
    },
    {
      kind: 'reconcile.missed-imports',
      expected: { scope: 'reconcile', action: 'missed-imports', facts: { instance: 'Sonarr', counts: { enqueued: 1 } } },
    },
  ])('rewrites $kind into the envelope', ({ kind, expected }) => {
    const db = freshDb();
    seed(db, FIXTURES);
    migrateEventEnvelopes(db);
    expect(dataById(db).get(kind)).toMatchObject(expected);
  });

  it('keeps the attention protocol fields outside the envelope, where the dedupe reads them', () => {
    const db = freshDb();
    seed(db, FIXTURES);
    migrateEventEnvelopes(db);
    expect(dataById(db).get('subtitle.unresolved')).toMatchObject({
      instance: 'Sonarr',
      targetKind: 'series',
      targetId: 143,
      dedupeKey: 'unresolved',
    });
  });

  it.each([
    { kind: 'acquire.none-viable', accept: { action: 'force-grab', instance: 'Sonarr', guid: 'g-top', indexerId: 3, pickedTitle: '[Trix] S01 Batch', releaseGroup: 'Trix', seasonNumber: 1 } },
    { kind: 'subtitle.site-unusable', accept: { action: 'disable-site', baseUrl: 'https://subhd.tv', reason: 'the download page blocked every request' } },
  ])("moves $kind's re-executable payload under data.accept, off the envelope's own `action`", ({ kind, accept }) => {
    const db = freshDb();
    seed(db, FIXTURES);
    migrateEventEnvelopes(db);
    const data = dataById(db).get(kind)!;
    expect(data.accept).toEqual(accept);
    // The envelope's own action won, and nothing of the payload leaked back to the top.
    expect(data.action).not.toBe(accept.action);
  });

  it('deletes rows whose kind has no rule, and only those', () => {
    const db = freshDb();
    seed(db, [
      { kind: 'ghost.kind', message: 'from a build that no longer exists', data: { anything: 1 } },
      FIXTURES[0]!,
    ]);

    const report = migrateEventEnvelopes(db);

    expect(report.deleted).toEqual({ 'ghost.kind': 1 });
    expect(db.prepare('SELECT kind FROM events').all()).toEqual([{ kind: 'subtitle.transcript' }]);
  });

  it('is idempotent: a second pass touches nothing', () => {
    const db = freshDb();
    seed(db, FIXTURES);
    migrateEventEnvelopes(db);
    const after = db.prepare('SELECT id, data FROM events ORDER BY id').all();

    const second = migrateEventEnvelopes(db);

    expect(second.migrated).toEqual({});
    expect(second.deleted).toEqual({});
    expect(Object.values(second.skipped).reduce((a, b) => a + b, 0)).toBe(FIXTURES.length);
    expect(db.prepare('SELECT id, data FROM events ORDER BY id').all()).toEqual(after);
  });

  it('a dry run reports exactly what an apply would do, and writes nothing', () => {
    const db = freshDb();
    seed(db, [...FIXTURES, { kind: 'ghost.kind', message: 'x', data: {} }]);
    const before = db.prepare('SELECT id, data FROM events ORDER BY id').all();

    const dry = migrateEventEnvelopes(db, { dryRun: true });

    expect(db.prepare('SELECT id, data FROM events ORDER BY id').all()).toEqual(before);
    expect(migrateEventEnvelopes(db, { dryRun: false })).toEqual(dry);
  });

  it('survives a data column that is not an object at all rather than deleting the row for it', () => {
    const db = freshDb();
    db.prepare('INSERT INTO events (ts, kind, level, job_id, message, data) VALUES (?, ?, ?, ?, ?, ?)').run(
      1,
      'subtitle.missing',
      'info',
      1,
      '12 video(s) missing subtitles',
      'not json at all',
    );

    expect(migrateEventEnvelopes(db).deleted).toEqual({});
    expect(dataById(db).get('subtitle.missing')).toMatchObject({ scope: 'subtitle', action: 'missing' });
  });

  it('agrees with what a live append derives, except where a rule deliberately renames', () => {
    // `EventLog.append` fills a missing envelope by splitting the kind on its first dot.
    // A rule that lands somewhere else for the same kind would make a migrated row and a
    // freshly appended one of that kind read as two different things in the feed — so the
    // renames have to be a short, deliberate list rather than an accident.
    const RENAMED: Record<string, string> = {
      'agent.stop': 'subtitle:visit',
      'subtitle.search-round': 'subtitle:visit',
      'webhook.received': 'trigger:webhook',
      'job.failed': 'run:finished',
      'job.attention': 'run:attention',
      'job.rescheduled': 'run:rescheduled',
      'acquire.grabbed': 'acquire:pick',
      'acquire.candidates-capped': 'acquire:filter',
      'subtitle.transcript': 'subtitle:step',
      'subtitle.site-cooldown': 'subtitle:visit',
      'subtitle.candidates-capped': 'subtitle:filter',
    };
    const drifted: string[] = [];
    for (const kind of MIGRATABLE_KINDS) {
      const db = freshDb();
      seed(db, [{ kind, message: 'm', data: {} }]);
      migrateEventEnvelopes(db);
      const data = dataById(db).get(kind)!;
      const landed = `${String(data.scope)}:${String(data.action)}`;
      const dot = kind.indexOf('.');
      const derived = dot === -1 ? `system:${kind}` : `${kind.slice(0, dot)}:${kind.slice(dot + 1)}`;
      if (landed !== (RENAMED[kind] ?? derived)) drifted.push(`${kind} -> ${landed}`);
    }
    expect(drifted).toEqual([]);
  });

  /** The legacy key names either mapper reads, minus the file paths — a rule only reads the
   * few it cares about, so handing all of them to every kind is the cheapest way to make
   * each rule state its opinion about the names `lift` also knows.
   *
   * The message is the same sentence as `data.reason` on purpose: several rules recover the
   * reason FROM the message where `lift` can only read the key, and a message that said
   * something else would report that difference as drift. */
  const SINK_REASON = 'the download page blocked every request';
  const SINK: Record<string, unknown> = {
    site: 'subhd.tv',
    title: 'Sword Art Online',
    instance: 'Sonarr',
    url: 'https://subhd.tv/a',
    archive: 'pack.rar',
    pipeline: 'subtitle',
    seasonNumber: 4,
    reason: SINK_REASON,
    sourcePath: '/data/subs/from.ass',
    sourceFile: '/data/subs/legacy-name.ass',
    releaseGroup: 'TARDiS',
  };

  /** One at a time: `lift` picks the first of these it finds and each rule picks the one its
   * kind actually writes, so a row carrying all four would report that ordering as drift. */
  const PATH_KEYS = ['path', 'placedPath', 'quarantinedPath', 'targetPath'];

  it('extracts the same facts a live append would, for every fact name both mappers know', () => {
    // The migration and `lift` (src/events/envelope.ts) are two independent mappers over the
    // same legacy payloads — nothing is shared, because only the migration can key off the
    // row's `kind`. Comparing the scope+action alone let the facts drift silently, which is
    // how `subtitle.quarantined` came to read `sourceFile` while `lift` read `sourcePath`
    // first.
    //
    // Scoped to the fact names BOTH mappers filled: a per-kind rule legitimately knows facts
    // `lift` cannot guess (a release, an outcome, a tier) and legitimately drops ones `lift`
    // would guess wrong for that kind. Where both spoke, they have to say the same thing.
    const batches: Legacy[][] = [
      FIXTURES,
      ...PATH_KEYS.map((key) =>
        MIGRATABLE_KINDS.map((kind) => ({ kind, message: SINK_REASON, data: { ...SINK, [key]: `/data/${key}.ass` } })),
      ),
    ];
    const drifted: string[] = [];

    for (const batch of batches) {
      const db = freshDb();
      seed(db, batch);
      migrateEventEnvelopes(db);
      const migratedByKind = dataById(db);

      for (const row of batch) {
        const migrated = (migratedByKind.get(row.kind)!.facts ?? {}) as Record<string, unknown>;
        const appended = (readEnvelope(ensureEnvelope(row.kind, row.data))?.facts ?? {}) as Record<string, unknown>;

        for (const [key, lifted] of Object.entries(appended)) {
          const mine = migrated[key];
          if (lifted === undefined || mine === undefined) continue;
          // `pathFile` deliberately keeps only the path, where `lift` also guesses a group
          // from `releaseGroup` — that is the RELEASE's group, not the file's, for most kinds.
          const [a, b] = key === 'file' ? [pathOf(mine), pathOf(lifted)] : [mine, lifted];
          if (JSON.stringify(a) !== JSON.stringify(b)) {
            drifted.push(`${row.kind}.${key}: migration ${JSON.stringify(a)} vs append ${JSON.stringify(b)}`);
          }
        }
      }
    }

    expect(drifted).toEqual([]);
  });

  it('has a rule for every kind the code can append', () => {
    // A kind the code emits but the rule table does not know is a row this migration would
    // silently DELETE on the operator's next run. Scanning the source is cruder than a
    // registry, but it is the only check that stays true when someone adds an emitter and
    // forgets this file. (Kinds built from a variable — `failure.kind` in agent/run.ts —
    // are invisible to it; they are covered by the fixture cases above instead.)
    const emitted = new Set<string>();
    for (const file of sourceFiles(join(import.meta.dirname, '..', 'src'))) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/events\.append\(\{\s*(?:\/\/[^\n]*\n\s*)*kind: '([a-z][\w.-]*)'/g)) {
        emitted.add(m[1]!);
      }
    }

    expect(emitted.size).toBeGreaterThan(20); // the scan actually found emitters
    expect([...emitted].filter((k) => !MIGRATABLE_KINDS.includes(k))).toEqual([]);
    expect(new Set(MIGRATABLE_KINDS).size).toBe(MIGRATABLE_KINDS.length);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
