import { describe, expect, it } from 'vitest';
import type { EventRow, Job, JobDetailResponse } from '@/api';
import { jobRows } from '@/components/activity/jobRows';
import { episodeSummary, eventStep, importStep, isImport, stepParts } from '@/components/activity/eventStep';
import { foldByCoalesceKey, type EventFacts } from '@/lib/eventEnvelope';
import { isStep, toSegments, type StepFeedRow } from '@/components/activity/UnifiedTimeline';

/**
 * Every `data` below is an envelope in the exact shape the backend now writes — the same
 * rows `GET /api/jobs/45` (acquire) and `/81` (subtitle) return after the migration. The
 * adapter reads `data` and nothing else, so a fixture that carried a hand-written `message`
 * would be testing a field the reader never opens.
 */

const JOB: Job = {
  id: 81,
  pipeline: 'subtitle',
  target_kind: 'series',
  target_id: 136,
  arr_instance: 'Sonarr',
  status: 'done',
  dirty: 0,
  attempts: 0,
  not_before: 1787489321864,
  payload: { source: 'ingest' },
  result: null,
  error: null,
  created_at: 1787488721864,
  updated_at: 1787491977137,
};

type DetailOver = Omit<Partial<JobDetailResponse>, 'job'> & { job?: Partial<Job> };

function detail({ job, ...rest }: DetailOver = {}): JobDetailResponse {
  return {
    job: { ...JOB, ...job },
    acquireRecords: [],
    attention: [],
    placedFiles: [],
    events: [],
    ...rest,
  };
}

function event(over: Partial<EventRow>): EventRow {
  return { id: 1, ts: 1000, kind: 'x', level: 'info', job_id: 81, message: 'unread', data: {}, ...over };
}

// ---------------------------------------------------------------------------
// stepParts — labels composed from facts
// ---------------------------------------------------------------------------

describe('stepParts', () => {
  const cases: { name: string; event: EventRow; label: string; detail: string }[] = [
    {
      name: 'an agent step is its site and its own verb, with the model sentence on hover',
      event: event({
        kind: 'subtitle.transcript',
        data: {
          scope: 'subtitle',
          action: 'search',
          facts: { site: 'subhd.tv', tier: 'chromium', detail: 'Searching for the Japanese title. (https://subhd.tv/search/x)' },
        },
      }),
      label: 'subhd.tv · search · Browser',
      detail: 'Searching for the Japanese title. (https://subhd.tv/search/x)',
    },
    {
      name: 'a visit verdict says the site, the tier and the steps it spent',
      event: event({
        kind: 'agent.stop',
        data: {
          scope: 'subtitle',
          action: 'visit',
          facts: { site: 'subhd.tv', tier: 'chromium', round: 1, maxRounds: 3, steps: 4, stop: 'done' },
          verdict: { tone: 'success' },
        },
      }),
      label: 'subhd.tv · Visit ended · Browser · 4 steps',
      detail: 'subhd.tv · Visit ended · Browser · 4 steps',
    },
    {
      name: 'a one-step visit is singularised',
      event: event({
        kind: 'agent.stop',
        data: { scope: 'subtitle', action: 'visit', facts: { site: 'acg.rip', tier: 'curl', steps: 1, stop: 'gave-up' } },
      }),
      label: 'acg.rip · Visit ended · Fast HTTP · 1 step',
      detail: 'acg.rip · Visit ended · Fast HTTP · 1 step',
    },
    {
      name: 'a failure keeps its first sentence on hover',
      event: event({
        kind: 'subtitle.site-failed',
        level: 'warn',
        data: {
          scope: 'subtitle',
          action: 'site-failed',
          facts: { site: 'bbs.acgrip.com', error: 'Generation failed for callsite "site-search": rate-limited.' },
          verdict: { tone: 'danger' },
        },
      }),
      label: 'bbs.acgrip.com · Site failed',
      detail: 'Generation failed for callsite "site-search": rate-limited.',
    },
    {
      name: 'counts read as counts, not as a sentence someone wrote',
      event: event({
        kind: 'acquire.filter',
        data: { scope: 'acquire', action: 'filter', facts: { season: 1, counts: { candidates: 128, kept: 30, dropped: 98 } } },
      }),
      label: 'Filtered · S1 · 128 candidates · 30 kept · 98 dropped',
      detail: 'Filtered · S1 · 128 candidates · 30 kept · 98 dropped',
    },
    {
      name: 'a zero count is left off rather than announced',
      event: event({ data: { scope: 'run', action: 'finished', facts: { pipeline: 'ingest', counts: { placed: 0 } } } }),
      label: 'Run finished',
      detail: 'Run finished',
    },
    {
      name: 'episodes collapse to a range per season',
      event: event({
        kind: 'subtitle.unresolved',
        level: 'attention',
        data: {
          scope: 'subtitle',
          action: 'unresolved',
          facts: {
            episodes: [
              { season: 2, episode: 21 },
              { season: 2, episode: 23 },
              { season: 3, episode: 1 },
            ],
            languages: ['zh-Hans', 'zh-Hant'],
          },
        },
      }),
      label: 'Still missing · S2E21-E23, S3E1 · zh-Hans, zh-Hant',
      detail: 'Still missing · S2E21-E23, S3E1 · zh-Hans, zh-Hant',
    },
    {
      name: 'a placed file is named by its basename, not its whole path',
      event: event({
        kind: 'subtitle.placed',
        data: {
          scope: 'subtitle',
          action: 'placed',
          facts: { file: { path: '/library/SAO/Season 1/SAO - S01E23 - Bonds Bluray-1080p.ja.ass' }, sourcePath: '/cache/x.ass' },
          verdict: { tone: 'success' },
        },
      }),
      label: 'Placed · SAO - S01E23 - Bonds Bluray-1080p.ja.ass',
      detail: 'Placed · SAO - S01E23 - Bonds Bluray-1080p.ja.ass',
    },
    {
      name: 'a row with no envelope reads as its kind rather than as parsed prose',
      event: event({ kind: 'ghost.kind', message: '[subhd.tv] search: this must not be parsed', data: {} }),
      label: 'ghost.kind',
      detail: 'ghost.kind',
    },
  ];

  it.each(cases)('$name', ({ event: row, label, detail: text }) => {
    expect(stepParts(row)).toEqual({ label, detail: text });
  });
});

describe('eventStep tone', () => {
  it.each([
    { name: 'the envelope verdict wins', over: { data: { scope: 'run', action: 'finished', verdict: { tone: 'danger' } } }, tone: 'danger' },
    {
      name: 'a neutral verdict repaints nothing',
      over: { data: { scope: 'subtitle', action: 'visit', verdict: { tone: 'neutral' } } },
      tone: undefined,
    },
    {
      name: 'attention still earns amber without a verdict',
      over: { level: 'attention' as const, data: { scope: 'subtitle', action: 'unresolved' } },
      tone: 'warning',
    },
    {
      name: 'warn stays uncoloured',
      over: { level: 'warn' as const, data: { scope: 'subtitle', action: 'quarantined' } },
      tone: undefined,
    },
  ])('$name', ({ over, tone }) => {
    expect(eventStep(event(over)).tone).toBe(tone);
  });

  it('a folded burst says how many rows it stands for', () => {
    const row = eventStep(event({ data: { scope: 'trigger', action: 'webhook', facts: {} } }), 34);
    expect(row.label).toBe('Webhook · ×34');
  });
});

describe('episodeSummary', () => {
  it.each([
    { name: 'one episode', episodes: [{ season: 1, episode: 4 }], expected: 'S1E4' },
    {
      name: 'a run within one season',
      episodes: [
        { season: 1, episode: 4 },
        { season: 1, episode: 6 },
      ],
      expected: 'S1E4-E6',
    },
    {
      name: 'unsorted input, several seasons',
      episodes: [
        { season: 3, episode: 2 },
        { season: 1, episode: 9 },
        { season: 1, episode: 2 },
      ],
      expected: 'S1E2-E9, S3E2',
    },
  ])('$name', ({ episodes, expected }) => {
    expect(episodeSummary(episodes)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// imports — one row per file, from the widened Download webhook
// ---------------------------------------------------------------------------

/** A `webhook.received` row in the shape `handleWebhook` writes it after the schema
 * widening. `facts` below are the normalized ones, never the arr's own field names. */
function hookEvent(facts: EventFacts, over: Partial<EventRow> = {}): EventRow {
  return event({
    kind: 'webhook.received',
    data: { scope: 'trigger', action: 'webhook', facts: { source: 'webhook', coalesceKey: 'hooks:46', ...facts } },
    ...over,
  });
}

/** Sonarr's real job-#80 import, normalized. */
const IMPORTED_EPISODE: EventFacts = {
  title: 'You and I Are Polar Opposites',
  reason: 'new',
  episodes: [{ season: 2, episode: 8, title: 'The Future' }],
  file: {
    path: 'Season 2/You and I Are Polar Opposites - S02E08 - The Future WEBDL-1080p.mkv',
    quality: 'WEBDL-1080p',
    group: 'Erai-raws',
    size: 1_472_349_068,
    subs: ['eng', 'por', 'spa', 'ara', 'fre', 'ger', 'ita', 'rus', 'pol'],
    audio: ['jpn'],
  },
  release: { title: 'You and I Are Polar Opposites S2E8 [1080P][WEBDL][-Erai-raws]', indexer: 'Nyaa.si (Prowlarr)', type: 'single' },
};

/** The same row as Radarr sends it: a title instead of an episode tag, no episodes. */
const IMPORTED_MOVIE: EventFacts = {
  title: 'Perfect Blue',
  reason: 'new',
  file: { path: 'Perfect Blue (1997) Bluray-1080p.mkv', quality: 'Bluray-1080p', group: 'TARDiS', size: 8_589_934_592, subs: ['eng'] },
};

describe('importStep', () => {
  it.each([
    {
      name: 'an episode names itself the way the file does',
      facts: IMPORTED_EPISODE,
      label: 'S02E08 · imported · WEBDL-1080p',
      detail: 'The Future · Erai-raws · 1.4 GB · embedded subs: eng, por, spa, ara, fre, ger, ita, rus, pol',
    },
    {
      name: 'a movie names itself, having no episode to name',
      facts: IMPORTED_MOVIE,
      label: 'Perfect Blue · imported · Bluray-1080p',
      detail: 'TARDiS · 8.0 GB · embedded subs: eng',
    },
    {
      name: 'an upgrade says so',
      facts: { ...IMPORTED_MOVIE, reason: 'upgrade' },
      label: 'Perfect Blue · upgraded · Bluray-1080p',
      detail: 'TARDiS · 8.0 GB · embedded subs: eng',
    },
    {
      name: 'a multi-episode file keeps both episodes and both titles',
      facts: {
        episodes: [
          { season: 2, episode: 12, title: 'Part One' },
          { season: 2, episode: 13, title: 'Part Two' },
        ],
        file: { path: 'Season 2/T - S02E12-E13.mkv', quality: 'Bluray-1080p', size: 3_221_225_472 },
      },
      label: 'S02E12-E13 · imported · Bluray-1080p',
      detail: 'Part One, Part Two · 3.0 GB',
    },
    {
      name: 'every absent clause is simply left out',
      facts: { episodes: [{ season: 2, episode: 8 }], file: { path: 'a.mkv' } },
      label: 'S02E08 · imported',
      // Nothing to add on hover, so the line repeats rather than opening an empty card.
      detail: 'S02E08 · imported',
    },
    {
      name: 'a webhook with episodes but no file block still says which episode landed',
      facts: { episodes: [{ season: 1, episode: 4, title: 'Elegy' }] },
      label: 'S01E04 · imported',
      detail: 'Elegy',
    },
  ])('$name', ({ facts, label, detail: text }) => {
    expect(importStep(hookEvent(facts))).toMatchObject({ label, detail: text });
  });

  it.each([
    { name: 'a file', facts: IMPORTED_MOVIE, expected: true },
    { name: 'episodes only', facts: { episodes: [{ season: 1, episode: 1 }] }, expected: true },
    { name: 'neither (every row written before the widening)', facts: { outcome: 'coalesced' }, expected: false },
    { name: 'an empty episodes array', facts: { episodes: [] }, expected: false },
  ])('recognises a webhook row carrying $name', ({ facts, expected }) => {
    expect(isImport(hookEvent(facts))).toBe(expected);
  });

  it('claims nothing that is not a webhook, however many facts it carries', () => {
    const placed = event({ data: { scope: 'subtitle', action: 'placed', facts: { file: { path: 'a.ass' } } } });
    expect(isImport(placed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coalescing (read-side fold)
// ---------------------------------------------------------------------------

describe('foldByCoalesceKey', () => {
  function hook(id: number, key?: string): EventRow {
    return event({ id, ts: id * 100, data: { scope: 'trigger', action: 'webhook', facts: key === undefined ? {} : { coalesceKey: key } } });
  }

  it('leaves rows without a key alone', () => {
    expect(foldByCoalesceKey([hook(1), hook(2)])).toEqual([
      { event: hook(1), folded: 1 },
      { event: hook(2), folded: 1 },
    ]);
  });

  it('collapses a burst onto the newest row, in the place the burst started', () => {
    const folded = foldByCoalesceKey([hook(1, 'hooks:9'), hook(2), hook(3, 'hooks:9'), hook(4, 'hooks:9')]);
    expect(folded.map((f) => [f.event.id, f.folded])).toEqual([
      [4, 3],
      [2, 1],
    ]);
  });

  it('keeps different keys apart', () => {
    const folded = foldByCoalesceKey([hook(1, 'hooks:9'), hook(2, 'waits:9'), hook(3, 'hooks:9')]);
    expect(folded.map((f) => [f.event.id, f.folded])).toEqual([
      [3, 2],
      [2, 1],
    ]);
  });

  it('is a no-op on an empty feed', () => {
    expect(foldByCoalesceKey([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// jobRows
// ---------------------------------------------------------------------------

describe('jobRows', () => {
  it('sorts oldest first and puts a block after the step it concludes', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire', updated_at: 3000 },
        events: [
          event({ id: 1, ts: 3000, data: { scope: 'run', action: 'finished' } }),
          event({ id: 2, ts: 1000, data: { scope: 'trigger', action: 'webhook' } }),
        ],
        acquireRecords: [acquireRecord({ id: 11, created_at: 3000 })],
      }),
    );
    expect(rows.map(rowId)).toEqual([2, 1, 'pick:11']);
  });

  it('renders the run verdict from the terminal event rather than synthesising one', () => {
    const rows = jobRows(
      detail({
        job: { status: 'failed', error: 'ignored — the event carries the verdict now' },
        events: [
          event({
            id: 9,
            ts: 5000,
            kind: 'run.finished',
            level: 'warn',
            data: {
              scope: 'run',
              action: 'finished',
              facts: { pipeline: 'subtitle', error: 'EACCES: permission denied.' },
              verdict: { tone: 'danger' },
            },
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 9, tone: 'danger', detail: 'EACCES: permission denied.' });
  });

  it('has nothing to conclude while a run is still going', () => {
    const running = detail({ job: { status: 'running' }, events: [event({ id: 1, ts: 1000, data: { scope: 'subtitle', action: 'search' } })] });
    expect(jobRows(running).map(rowId)).toEqual([1]);
  });

  it('is empty for a job that has not started', () => {
    expect(jobRows(detail({ job: { status: 'pending' } }))).toEqual([]);
  });

  it('folds a webhook storm into one row', () => {
    const rows = jobRows(
      detail({
        job: { id: 46, pipeline: 'ingest' },
        events: [1, 2, 3].map((id) =>
          event({ id, ts: id * 100, kind: 'webhook.received', data: { scope: 'trigger', action: 'webhook', facts: { coalesceKey: 'hooks:46' } } }),
        ),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 3, label: 'Webhook · ×3' });
  });

  it('gives every imported file its own row instead of folding the pack into one line', () => {
    const rows = jobRows(
      detail({
        job: { id: 46, pipeline: 'ingest' },
        events: [8, 9, 10].map((episode, i) =>
          hookEvent(
            { episodes: [{ season: 2, episode }], file: { path: `Season 2/T - S02E${episode}.mkv`, quality: 'WEBDL-1080p' } },
            { id: i + 1, ts: (i + 1) * 100 },
          ),
        ),
      }),
    );
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      [1, 'S02E08 · imported · WEBDL-1080p'],
      [2, 'S02E09 · imported · WEBDL-1080p'],
      [3, 'S02E10 · imported · WEBDL-1080p'],
    ]);
  });

  it('folds only the fact-less rows when a run spans the widening', () => {
    const rows = jobRows(
      detail({
        job: { id: 46, pipeline: 'ingest' },
        events: [
          // Two rows from before the schema kept its fields: nothing of their own to say.
          hookEvent({ outcome: 'enqueued' }, { id: 1, ts: 100 }),
          hookEvent({ outcome: 'coalesced' }, { id: 2, ts: 200 }),
          hookEvent({ ...IMPORTED_EPISODE }, { id: 3, ts: 300 }),
          hookEvent({ ...IMPORTED_MOVIE }, { id: 4, ts: 400 }),
        ],
      }),
    );
    // The fold lands on the newest fact-less row (id 2) and stands for both; the two
    // fact-carrying rows keep their own lines, each in its own place in time.
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      [2, 'Webhook · ×2'],
      [3, 'S02E08 · imported · WEBDL-1080p'],
      [4, 'Perfect Blue · imported · Bluray-1080p'],
    ]);
  });

  it('leaves the waiting fold alone — it carries no import to render', () => {
    const rows = jobRows(
      detail({
        job: { id: 46, pipeline: 'ingest' },
        events: [
          hookEvent({ ...IMPORTED_EPISODE }, { id: 1, ts: 100 }),
          ...[2, 3, 4].map((id) =>
            event({
              id,
              ts: id * 100,
              kind: 'job.rescheduled',
              data: { scope: 'run', action: 'rescheduled', facts: { coalesceKey: 'waits:46', delayMs: 120_000 } },
            }),
          ),
        ],
      }),
    );
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      [1, 'S02E08 · imported · WEBDL-1080p'],
      [4, 'Waiting · ×3'],
    ]);
  });

  it('drops acquire.pick events rather than showing the pick twice', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire', updated_at: 5000 },
        events: [
          event({ id: 1, ts: 1000, kind: 'acquire.pick', data: { scope: 'acquire', action: 'pick', facts: { season: 1 } } }),
          event({ id: 2, ts: 1500, kind: 'webhook.received', data: { scope: 'trigger', action: 'webhook' } }),
        ],
        acquireRecords: [acquireRecord({ id: 11, created_at: 2000 })],
      }),
    );
    expect(rows.map(rowId)).toEqual([2, 'pick:11']);
  });

  it('gives each acquire record its own pick block, in the flow', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire', updated_at: 9000 },
        acquireRecords: [
          acquireRecord({ id: 11, created_at: 2000, status: 'grabbed', release_group: 'TARDiS', season: 1 }),
          acquireRecord({ id: 12, created_at: 4000, status: 'none-viable', season: 2 }),
        ],
        events: [event({ id: 1, ts: 1000, data: { scope: 'acquire', action: 'search' } })],
      }),
    );
    expect(rows.map(rowId)).toEqual([1, 'pick:11', 'pick:12']);
    expect(rows.filter((r) => !isStep(r)).map((r) => [r.id, r.label, r.tone])).toEqual([
      ['pick:11', 'S1 · Grabbed · Bluray-1080p · TARDiS', 'success'],
      ['pick:12', 'S2 · Nothing good enough', 'warning'],
    ]);
  });

  it('leaves pick blocks to acquire alone', () => {
    const rows = jobRows(detail({ acquireRecords: [acquireRecord({ id: 11 })] }));
    expect(rows.every(isStep)).toBe(true);
  });

  it.each(['done', 'failed'] as const)('synthesises nothing for a %s run that logged nothing', (status) => {
    expect(jobRows(detail({ job: { status } }))).toEqual([]);
  });

  it('holds back the season being worked on and shows the ones already decided', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire', status: 'running' },
        acquireRecords: [
          acquireRecord({ id: 11, created_at: 2000, status: 'grabbed', season: 1 }),
          // S2 is what the run is doing right now: no status yet, so no conclusion yet.
          acquireRecord({ id: 12, created_at: 4000, status: null, season: 2 }),
        ],
        events: [event({ id: 1, ts: 3000, data: { scope: 'acquire', action: 'search', facts: { season: 2 } } })],
      }),
    );
    expect(rows.map(rowId)).toEqual(['pick:11', 1]);
  });

  it('shows the open record once the run is over, however it ended', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire', status: 'failed' },
        acquireRecords: [acquireRecord({ id: 12, created_at: 4000, status: null })],
      }),
    );
    expect(rows.map(rowId)).toEqual(['pick:12']);
  });

  it('a finished visit carries its own verdict, with nothing suppressing it mid-run', () => {
    const stop = event({
      id: 7,
      ts: 2000,
      kind: 'agent.stop',
      data: {
        scope: 'subtitle',
        action: 'visit',
        facts: { site: 'subhd.tv', tier: 'curl', steps: 2, stop: 'done' },
        verdict: { tone: 'success' },
      },
    });
    const searching = event({ id: 6, ts: 1000, data: { scope: 'subtitle', action: 'search', facts: { site: 'subhd.tv' } } });

    // Mid-visit: the site has spoken but not concluded, so there is no verdict to show.
    expect(jobRows(detail({ job: { status: 'running' }, events: [searching] })).map(rowId)).toEqual([6]);
    // The moment it concludes — same running job — the verdict is in the feed.
    expect(jobRows(detail({ job: { status: 'running' }, events: [searching, stop] })).map((r) => [r.id, r.tone])).toEqual(
      [
        [6, undefined],
        [7, 'success'],
      ],
    );
  });

  it('attributes each season its own release group rather than one to the whole run', () => {
    const rows = jobRows(
      detail({
        job: { id: 45, pipeline: 'acquire' },
        acquireRecords: [
          acquireRecord({ id: 11, created_at: 2000, status: 'grabbed', release_group: 'TARDiS', season: 1 }),
          acquireRecord({ id: 12, created_at: 3000, status: 'grabbed', release_group: 'SubsPlease', season: 2 }),
        ],
      }),
    );
    expect(rows.map((r) => r.label)).toEqual([
      'S1 · Grabbed · Bluray-1080p · TARDiS',
      'S2 · Grabbed · Bluray-1080p · SubsPlease',
    ]);
  });
});

// ---------------------------------------------------------------------------
// segmentation — which stretch of the feed the live pulse belongs to
// ---------------------------------------------------------------------------

describe('toSegments', () => {
  const step = (id: number): StepFeedRow => ({ id, ts: id * 100, label: `s${id}`, detail: `s${id}` });
  const block = (id: string): StepFeedRow => ({ kind: 'block', id, ts: 0, label: id, body: null });

  it('groups contiguous steps and leaves every block on its own', () => {
    const segments = toSegments([step(1), step(2), block('b'), step(3)]);
    expect(segments.map((s) => (s.kind === 'steps' ? s.steps.map((x) => x.id) : s.block.id))).toEqual([
      [1, 2],
      'b',
      [3],
    ]);
  });

  it('keeps consecutive blocks apart rather than folding them together', () => {
    expect(toSegments([block('a'), block('b')]).map((s) => s.kind)).toEqual(['block', 'block']);
  });

  it('finds the newest steps under a trailing block — where the live pulse belongs', () => {
    // Newest first, the order the timeline renders in.
    const newestFirst = toSegments([step(1), step(2), block('pick:11')]).reverse();
    expect(newestFirst.findIndex((s) => s.kind === 'steps')).toBe(1);
  });
});

function rowId(row: StepFeedRow): string | number {
  return row.id;
}

function acquireRecord(over: {
  id?: number;
  created_at?: number;
  status?: 'grabbed' | 'none-viable' | 'no-candidates' | 'already-satisfied' | null;
  release_group?: string;
  season?: number;
}) {
  const status = 'status' in over ? (over.status ?? null) : 'grabbed';
  return {
    id: over.id ?? 11,
    arr_instance: 'Sonarr',
    target_kind: 'series' as const,
    target_id: 143,
    source: 'retry',
    status,
    picked_guid: 'magnet:?xt=urn:btih:abc',
    release_group: over.release_group ?? null,
    reasoning: 'The only viable season pack.',
    candidates_json: { seasonNumber: over.season ?? 1, kept: [], dropped: [] },
    created_at: over.created_at ?? 2000,
    picked:
      status === 'grabbed'
        ? {
            title: 'Sword Art Online S01 1080p BluRay x265-TARDiS',
            indexer: 'Nyaa.si (Prowlarr)',
            quality: 'Bluray-1080p',
            size: 12_000_000_000,
            seeders: 41,
            shape: 'pack' as const,
            seasonNumber: over.season ?? 1,
            languages: ['Japanese'],
            forceGrab: false,
          }
        : null,
  };
}
