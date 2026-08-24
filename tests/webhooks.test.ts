import { describe, it, expect, vi } from 'vitest';
import { handleWebhook, INGEST_DEBOUNCE_MS } from '../src/arr/webhooks.js';
import { makeCtx, configWithArrs, fakeArrClient, withFakeTime } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';
import { TraceEntries } from '../src/db/traceEntries.js';

const seriesAdd = { eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren', year: 2023, tvdbId: 424536 } };
const movieAdded = { eventType: 'MovieAdded', movie: { id: 7, title: 'Perfect Blue', year: 1997, tmdbId: 573 } };
const seriesDownload = { eventType: 'Download', series: { id: 42, title: 'Frieren' }, isUpgrade: false, downloadId: 'abc' };
const movieDownload = { eventType: 'Download', movie: { id: 7, title: 'Perfect Blue' }, isUpgrade: true, downloadId: 'def' };
// `downloadId` above is on the INCOMING payload, mimicking a real Sonarr/Radarr webhook
// body. It is kept as an event FACT (the only join between a webhook and a queue item) but
// still never reaches the JOB payload: ingest derives its own download ids from the arr's
// live queue, so a stale one on the payload would only be a lie waiting to be read.

function knownArrsCtx() {
  return makeCtx({
    config: configWithArrs('sonarr', 'radarr'),
    clients: new Map<string, ArrApi>([
      ['sonarr', fakeArrClient()],
      ['radarr', fakeArrClient()],
    ]),
  });
}

describe('handleWebhook', () => {
  it.each([
    { name: 'sonarr SeriesAdd', instance: 'sonarr', payload: seriesAdd, targetKind: 'series', targetId: 42 },
    { name: 'radarr MovieAdded', instance: 'radarr', payload: movieAdded, targetKind: 'movie', targetId: 7 },
  ])('$name enqueues acquire', ({ instance, payload, targetKind, targetId }) => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    const job = ctx.queue.claim()!;
    expect(job).toMatchObject({ pipeline: 'acquire', target_kind: targetKind, target_id: targetId, arr_instance: instance });
  });

  it.each([
    { name: 'sonarr Download (new)', instance: 'sonarr', payload: seriesDownload, targetKind: 'series', targetId: 42, isUpgrade: false },
    { name: 'radarr Download (upgrade)', instance: 'radarr', payload: movieDownload, targetKind: 'movie', targetId: 7, isUpgrade: true },
  ])('$name enqueues ingest', ({ instance, payload, targetKind, targetId, isUpgrade }) => {
    const ctx = knownArrsCtx();
    const target = 'series' in payload ? payload.series : payload.movie;
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    // Not `claim()`: a Download enqueue's `not_before` is debounced INGEST_DEBOUNCE_MS into
    // the future (see below), so it isn't claimable yet; read the pending row back directly.
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(job).toMatchObject({ pipeline: 'ingest', target_kind: targetKind, target_id: targetId, arr_instance: instance, status: 'pending' });
    // No `downloadId` — the payload above carries one (mimicking a real webhook body), but
    // it's never read, so it must not survive onto the job payload. `isUpgrade` DOES ride
    // along: the subtitle pipeline reads it to decide whether an upgrade re-triggers sub
    // reconciliation, so it's part of the payload contract, not a webhook-only detail.
    expect(job.payload).toEqual({ title: target.title, isUpgrade });
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received', job_id: job.id });
    expect(events[0]!.data).toMatchObject({ facts: { reason: isUpgrade ? 'upgrade' : 'new' } });
  });

  it('debounces a Download webhook\'s ingest enqueue by INGEST_DEBOUNCE_MS', () => {
    const ctx = knownArrsCtx();
    const now = Date.now();
    handleWebhook(ctx, 'sonarr', seriesDownload);
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(job.not_before).toBeGreaterThanOrEqual(now + INGEST_DEBOUNCE_MS - 1000);
  });

  it('coalesces a second Download webhook and pushes not_before forward, one run after the storm', () => {
    withFakeTime(() => {
      vi.setSystemTime(1_000);
      const ctx = knownArrsCtx();
      handleWebhook(ctx, 'sonarr', seriesDownload);
      const firstJob = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
      expect(firstJob.not_before).toBe(1_000 + INGEST_DEBOUNCE_MS);

      vi.setSystemTime(1_000 + 10_000); // a second Download webhook, 10 simulated seconds later
      expect(handleWebhook(ctx, 'sonarr', seriesDownload).handled).toBe(true);

      // events.list() is newest-first, so the second webhook's event is events[0].
      expect(ctx.events.list()[0]!.data).toMatchObject({ facts: { outcome: 'coalesced' } });
      expect(ctx.queue.get(firstJob.id)!.not_before).toBe(1_000 + 10_000 + INGEST_DEBOUNCE_MS);
      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(1);
    });
  });

  it('keeps not_before = 0 for a SeriesAdd acquire enqueue (no debounce outside Download)', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.list().find((j) => j.pipeline === 'acquire')!;
    expect(job.not_before).toBe(0);
  });

  it('ignores a Download event with neither series nor movie', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Download', isUpgrade: false })).toEqual({ handled: false, reason: 'ignored' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('acknowledges Test events without enqueueing', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Test' }).handled).toBe(true);
    expect(ctx.queue.claim()).toBeNull();
  });

  it('ignores unknown events and garbage payloads', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Rename' })).toEqual({ handled: false, reason: 'ignored' });
    expect(handleWebhook(ctx, 'sonarr', { nonsense: true })).toEqual({ handled: false, reason: 'ignored' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance with no registered client, even by default (no config, no clients)', () => {
    const ctx = makeCtx(); // default config: arrs: [], clients: {}
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance that is in config.arrs but has no ctx.clients entry — clients, not config, is authoritative (it is what the runner resolves against)', () => {
    const ctx = makeCtx({ config: configWithArrs('sonarr') }); // configured, but no client registered
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('carries the target title through as the acquire prompt hint', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    expect(ctx.queue.claim()!.payload).toEqual({ title: 'Frieren' });
  });

  it('appends an event carrying the job id and enqueue outcome', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received', job_id: job.id });
    expect(events[0]!.data).toMatchObject({ scope: 'trigger', action: 'webhook', facts: { outcome: 'enqueued', coalesceKey: `hooks:${events[0]!.job_id}` } });
  });

  it('captures the webhook body as a trigger.webhook trace entry', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const rows = new TraceEntries(ctx.db).listByJob(job.id);
    expect(rows[0]).toMatchObject({ kind: 'trigger.webhook' });
    expect(JSON.parse(rows[0]!.payload ?? '')).toEqual(seriesAdd);
  });

  it('appends a second trigger entry to the coalesced job trace', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const rows = new TraceEntries(ctx.db).listByJob(job.id);
    const triggerRows = rows.filter((r) => r.kind === 'trigger.webhook');
    expect(triggerRows).toHaveLength(2);
    expect(triggerRows[1]!.summary).toBe('SeriesAdd webhook (sonarr) (coalesced)');
  });

  it('writes no trigger entry when the enqueue only dirties a running twin', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!; // now running, so the second webhook can only mark it dirty
    const before = new TraceEntries(ctx.db).listByJob(job.id).length;

    handleWebhook(ctx, 'sonarr', seriesAdd);

    // The trigger will be served by the job `complete()` requeues later, which has no id
    // yet, so the running job's trace must not claim it.
    expect(new TraceEntries(ctx.db).listByJob(job.id)).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Download retention — what a real import webhook leaves in the event log
// ---------------------------------------------------------------------------

/**
 * The body Sonarr actually sent for job #80 (`trace 80 seq 0`), verbatim except that two of
 * the four `series.images` entries are dropped for length — the point of keeping it whole is
 * that the noise is IN the fixture, so the exclusions below are proven against real noise
 * rather than against a payload already tidied by the person writing the test.
 */
const sonarrDownload = {
  series: {
    id: 136,
    title: 'You and I Are Polar Opposites',
    titleSlug: 'you-and-i-are-polar-opposites',
    path: '/mnt/media/Anime/You and I Are Polar Opposites',
    tvdbId: 457078,
    tvMazeId: 89103,
    tmdbId: 278043,
    imdbId: 'tt36034547',
    type: 'standard',
    year: 2026,
    genres: ['Animation', 'Anime', 'Comedy', 'Romance'],
    images: [
      { coverType: 'banner', url: '/MediaCover/136/banner.jpg?lastWrite=639178596047949391', remoteUrl: 'https://artworks.thetvdb.com/banners/v4/series/457078/banners/69639ed5e06df.jpg' },
      { coverType: 'poster', url: '/MediaCover/136/poster.jpg?lastWrite=639188909849554230', remoteUrl: 'https://artworks.thetvdb.com/banners/v4/series/457078/posters/6a4a58b5ce87f.jpg' },
    ],
    tags: [],
    originalLanguage: { id: 8, name: 'Japanese' },
  },
  episodes: [
    {
      id: 5948,
      episodeNumber: 8,
      seasonNumber: 2,
      title: 'The Future',
      overview: "Nishi and Yamada spend some time at Yamada's house.",
      airDate: '2026-08-23',
      airDateUtc: '2026-08-23T08:00:00Z',
      seriesId: 136,
      tvdbId: 11872940,
    },
  ],
  episodeFile: {
    id: 5634,
    relativePath: 'Season 2/You and I Are Polar Opposites - S02E08 - The Future WEBDL-1080p.mkv',
    path: '/mnt/media/Anime/You and I Are Polar Opposites/Season 2/You and I Are Polar Opposites - S02E08 - The Future WEBDL-1080p.mkv',
    quality: 'WEBDL-1080p',
    qualityVersion: 1,
    releaseGroup: 'Erai-raws',
    sceneName: '[Erai-raws] Seihantai na Kimi to Boku 2nd Season - 08 [1080p CR WEB-DL AVC AAC][MultiSub][F74B4B6F]',
    size: 1_472_349_068,
    dateAdded: '2026-08-23T12:25:35.732943Z',
    languages: [{ id: 8, name: 'Japanese' }],
    mediaInfo: {
      audioChannels: 2,
      audioCodec: 'AAC',
      audioLanguages: ['jpn'],
      height: 1080,
      width: 1920,
      subtitles: ['eng', 'por', 'spa', 'ara', 'fre', 'ger', 'ita', 'rus', 'pol'],
      videoCodec: 'x264',
      videoDynamicRange: '',
      videoDynamicRangeType: '',
    },
    sourcePath: '/mnt/downloads/[Erai-raws] Seihantai na Kimi to Boku 2nd Season - 08 [1080p CR WEB-DL AVC AAC][MultiSub][F74B4B6F].mkv',
  },
  isUpgrade: false,
  downloadClient: 'qBittorrent',
  downloadClientType: 'qBittorrent',
  downloadId: 'D730FDA58846451B5149687087E0AF33C9F65684',
  customFormatInfo: { customFormats: [], customFormatScore: 0 },
  release: {
    releaseTitle: 'You and I Are Polar Opposites S2E8 [1080P][WEBDL][-Erai-raws]',
    indexer: 'Nyaa.si (Prowlarr)',
    // The PACK size: bigger than the file's, and identical on every webhook of a pack.
    size: 1_503_238_553,
    releaseType: 'singleEpisode',
  },
  eventType: 'Download',
  instanceName: 'Sonarr',
  applicationUrl: 'http://sonarr.local',
};

/** The same import, as Radarr describes it: `movieFile` for `episodeFile`, no episodes, no
 * `releaseType`. Every other field name is identical, which is the whole reason one
 * normalizer can serve both. */
const radarrDownload = {
  movie: { id: 7, title: 'Perfect Blue', year: 1997, tmdbId: 573, images: [{ coverType: 'poster', url: '/MediaCover/7/poster.jpg' }] },
  movieFile: {
    id: 91,
    relativePath: 'Perfect Blue (1997) Bluray-1080p.mkv',
    quality: 'Bluray-1080p',
    releaseGroup: 'TARDiS',
    sceneName: 'Perfect.Blue.1997.1080p.BluRay.x265-TARDiS',
    size: 8_589_934_592,
    mediaInfo: { audioLanguages: ['jpn', 'eng'], subtitles: ['eng'] },
    sourcePath: '/downloads/Perfect.Blue.1997.1080p.BluRay.x265-TARDiS.mkv',
  },
  isUpgrade: false,
  downloadId: 'RADARR-DL-1',
  release: { releaseTitle: 'Perfect.Blue.1997.1080p.BluRay.x265-TARDiS', indexer: 'Nyaa.si (Prowlarr)' },
  eventType: 'Download',
};

/** The facts of the one event a webhook appends. */
function factsOf(payload: unknown, instance = 'sonarr'): Record<string, unknown> {
  const ctx = knownArrsCtx();
  expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
  const data = ctx.events.list()[0]!.data as { facts?: Record<string, unknown> };
  return data.facts ?? {};
}

describe('Download webhook retention', () => {
  it('normalizes the real Sonarr body into the envelope, arr-agnostically', () => {
    expect(factsOf(sonarrDownload)).toEqual({
      source: 'webhook',
      instance: 'sonarr',
      eventType: 'Download',
      title: 'You and I Are Polar Opposites',
      pipeline: 'ingest',
      outcome: 'enqueued',
      coalesceKey: expect.stringMatching(/^hooks:\d+$/),
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
      release: {
        title: 'You and I Are Polar Opposites S2E8 [1080P][WEBDL][-Erai-raws]',
        indexer: 'Nyaa.si (Prowlarr)',
        type: 'single',
      },
      sourcePath: '/mnt/downloads/[Erai-raws] Seihantai na Kimi to Boku 2nd Season - 08 [1080p CR WEB-DL AVC AAC][MultiSub][F74B4B6F].mkv',
      downloadId: 'D730FDA58846451B5149687087E0AF33C9F65684',
    });
  });

  it('takes the FILE size, not the pack size the release quotes', () => {
    const facts = factsOf(sonarrDownload) as { file: { size: number } };
    expect(facts.file.size).toBe(sonarrDownload.episodeFile.size);
    expect(facts.file.size).not.toBe(sonarrDownload.release.size);
  });

  it.each([
    'images',
    'overview',
    'customFormatInfo',
    'genres',
    'tvdbId',
    'titleSlug',
    'originalLanguage',
    'downloadClient',
    // The series' own library root: `file.path` is deliberately RELATIVE, so a library
    // path in the event would mean a series field leaked in.
    '/mnt/media',
  ])('keeps %s out of the event — the trace has the whole body', (excluded) => {
    expect(JSON.stringify(factsOf(sonarrDownload))).not.toContain(excluded);
  });

  it('still stores the untouched body on the trace', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', sonarrDownload);
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(JSON.parse(new TraceEntries(ctx.db).listByJob(job.id)[0]!.payload ?? '')).toEqual(sonarrDownload);
  });

  it('normalizes Radarr into the same shape, with no episodes', () => {
    expect(factsOf(radarrDownload, 'radarr')).toMatchObject({
      file: {
        path: 'Perfect Blue (1997) Bluray-1080p.mkv',
        quality: 'Bluray-1080p',
        group: 'TARDiS',
        size: 8_589_934_592,
        subs: ['eng'],
        audio: ['jpn', 'eng'],
      },
      release: { title: 'Perfect.Blue.1997.1080p.BluRay.x265-TARDiS', indexer: 'Nyaa.si (Prowlarr)' },
      sourcePath: '/downloads/Perfect.Blue.1997.1080p.BluRay.x265-TARDiS.mkv',
      downloadId: 'RADARR-DL-1',
    });
    expect(factsOf(radarrDownload, 'radarr')).not.toHaveProperty('episodes');
  });

  it('gives an episodeFile and a movieFile with the same contents the same facts', () => {
    const file = {
      relativePath: 'x/y.mkv',
      quality: 'Bluray-1080p',
      releaseGroup: 'TARDiS',
      size: 42,
      sceneName: 'y',
      sourcePath: '/downloads/y.mkv',
      mediaInfo: { subtitles: ['eng'], audioLanguages: ['jpn'] },
    };
    const release = { releaseTitle: 'y', indexer: 'Nyaa.si' };
    const common = { eventType: 'Download', isUpgrade: false, downloadId: 'z', release };
    const sonarr = factsOf({ ...common, series: { id: 1, title: 'T' }, episodeFile: file });
    const radarr = factsOf({ ...common, movie: { id: 1, title: 'T' }, movieFile: file }, 'radarr');

    const { instance: _s, coalesceKey: _sk, ...sonarrRest } = sonarr;
    const { instance: _r, coalesceKey: _rk, ...radarrRest } = radarr;
    expect(sonarrRest).toEqual(radarrRest);
  });

  it('keeps every entry of a multi-episode file', () => {
    expect(
      factsOf({
        eventType: 'Download',
        series: { id: 1, title: 'T' },
        episodes: [
          { episodeNumber: 12, seasonNumber: 2, title: 'Part One' },
          { episodeNumber: 13, seasonNumber: 2, title: 'Part Two' },
        ],
        episodeFile: { relativePath: 'Season 2/T - S02E12-E13.mkv' },
      }).episodes,
    ).toEqual([
      { season: 2, episode: 12, title: 'Part One' },
      { season: 2, episode: 13, title: 'Part Two' },
    ]);
  });

  it.each([
    { name: 'singleEpisode', releaseType: 'singleEpisode', type: 'single' },
    { name: 'multiEpisode', releaseType: 'multiEpisode', type: 'multi' },
    { name: 'seasonPack', releaseType: 'seasonPack', type: 'pack' },
    { name: 'an arr shape we have never seen', releaseType: 'unknown', type: undefined },
  ])('maps $name onto the release vocabulary', ({ releaseType, type }) => {
    const facts = factsOf({ eventType: 'Download', series: { id: 1, title: 'T' }, release: { indexer: 'i', releaseType } });
    expect((facts.release as { type?: string }).type).toBe(type);
  });

  it.each([
    { name: 'no episodes', over: { episodes: undefined }, absent: 'episodes' },
    { name: 'an empty episodes array', over: { episodes: [] }, absent: 'episodes' },
    { name: 'no file block', over: { episodeFile: undefined }, absent: 'file' },
    { name: 'no release block', over: { release: undefined }, absent: 'release' },
    { name: 'no downloadId', over: { downloadId: undefined }, absent: 'downloadId' },
  ])('parses a body with $name and simply omits the fact', ({ over, absent }) => {
    expect(factsOf({ ...sonarrDownload, ...over })).not.toHaveProperty(absent);
  });

  it.each([
    { name: 'no mediaInfo', file: { relativePath: 'a.mkv' }, expected: { path: 'a.mkv' } },
    { name: 'empty track lists', file: { relativePath: 'a.mkv', mediaInfo: { subtitles: [], audioLanguages: [] } }, expected: { path: 'a.mkv' } },
    {
      name: 'no quality, group or size',
      file: { relativePath: 'a.mkv', mediaInfo: { subtitles: ['eng'] } },
      expected: { path: 'a.mkv', subs: ['eng'] },
    },
  ])('survives a file with $name', ({ file, expected }) => {
    expect(factsOf({ eventType: 'Download', series: { id: 1, title: 'T' }, episodeFile: file }).file).toEqual(expected);
  });

  it('falls back to the scene name when the arr sent no source path', () => {
    const file = { relativePath: 'a.mkv', sceneName: 'A.2026.1080p.WEB-DL-X' };
    expect(factsOf({ eventType: 'Download', series: { id: 1, title: 'T' }, episodeFile: file }).sourcePath).toBe(
      'A.2026.1080p.WEB-DL-X',
    );
  });

  it('leaves the job payload alone — the facts are the event\'s business', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', sonarrDownload);
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(job.payload).toEqual({ title: 'You and I Are Polar Opposites', isUpgrade: false });
  });
});
