import { describe, expect, it, vi } from 'vitest';
import { searchSite, failBackoffMs, tierStartIndex } from '../src/agent/run.js';
import { SubtitleRuns } from '../src/db/subtitleRuns.js';
import { SiteProfiles, type AccessTier } from '../src/db/siteProfiles.js';
import type { FetchResult, FetchTier } from '../src/agent/tiers.js';
import type { SubtitleSiteConfig } from '../src/config/schema.js';
import { FakeGenerator, freshDb, makeCtx, findEvent, enqueueAndClaim, withFakeTime, tmpDir } from './helpers.js';

const SITE: SubtitleSiteConfig = { name: 'acgrip', baseUrl: 'https://acg.rip', searchUrlTemplate: 'https://acg.rip/?term={query}' };
const OK_HTML: FetchResult = { ok: true, status: 200, body: '<html>results</html>', blocked: false };

/** A stub `tiers` factory — `make(t)` returns a fake tier backed by ONE shared queue, so
 * escalation consumes results sequentially across rungs exactly as the real ladder would
 * (curl's wall, then chromium's success). Chromium stays out of tests while still
 * exercising the ladder's escalation. Records each rung requested so a test can assert the
 * escalation order. */
function stubTiers(results: FetchResult[]): { make: (t: AccessTier) => FetchTier; made: AccessTier[] } {
  const made: AccessTier[] = [];
  const queue = [...results];
  return {
    make: (t) => {
      made.push(t);
      return {
        tier: t,
        fetch: async () => queue.shift() ?? { ok: false, blocked: false },
        close: vi.fn(async () => {}),
      };
    },
    made,
  };
}

function setup() {
  const ctx = makeCtx();
  const job = enqueueAndClaim(ctx, { pipeline: 'ingest', targetKind: 'series', targetId: 1, arrInstance: 'sonarr', payload: {} });
  return { ctx, job };
}

describe('failBackoffMs', () => {
  it.each([
    [0, 30_000],
    [1, 60_000],
    [2, 120_000],
    [10, 6 * 3_600_000], // capped at 6h
  ])('failCount %i -> %i ms', (n, expected) => {
    expect(failBackoffMs(n)).toBe(expected);
  });
});

describe('tierStartIndex', () => {
  const week = 7 * 24 * 3_600_000;
  it('starts at curl when no floor is remembered', () => {
    expect(tierStartIndex(null, null)).toBe(0);
  });
  it('starts at the remembered chromium floor when success is recent', () => {
    const now = 1_000_000_000_000;
    expect(tierStartIndex('chromium', now - 1000, now)).toBe(1);
  });
  it('decays one cheaper rung when last success is older than a week', () => {
    const now = 1_000_000_000_000;
    expect(tierStartIndex('chromium', now - week - 1, now)).toBe(0);
  });
});

describe('SubtitleRuns', () => {
  it('starts a run, appends transcript entries, finishes it', () => {
    const runs = new SubtitleRuns(freshDb());
    const id = runs.start(7, 'acgrip');
    runs.appendTranscript(id, [{ ts: 1, tier: 'curl', action: 'search', detail: 'x' }]);
    runs.appendTranscript(id, [{ ts: 2, tier: 'curl', action: 'download', detail: 'y' }]);
    runs.finish(id, 'done');
    const row = runs.listByJob(7)[0]!;
    expect(row.transcript).toHaveLength(2);
    expect(row.status).toBe('done');
  });

  it('listByJob returns runs for the job in id order', () => {
    const runs = new SubtitleRuns(freshDb());
    const first = runs.start(7, 'acgrip');
    const second = runs.start(7, 'acgrip');
    runs.start(8, 'other'); // different job — must not appear
    expect(runs.listByJob(7).map((r) => r.id)).toEqual([first, second]);
  });
});

describe('searchSite', () => {
  it('escalates from curl to chromium on TierBlockedError and records last_working_tier', async () => {
    const { ctx, job } = setup();
    // Queued results are shared across both rungs in order: curl hits the wall, chromium
    // succeeds. Two LLM calls (one per tier's loop).
    const tiers = stubTiers([
      { ok: false, status: 403, body: 'Attention Required! | Cloudflare', blocked: true },
      { ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false },
    ]);
    ctx.llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/?term=x', note: 's' },
      { action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'dl' },
    ]);

    const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
    expect(out).toEqual({ filePath: '/dl/pack.zip', url: 'https://acg.rip/dl/123.zip' });
    expect(tiers.made).toEqual(['curl', 'chromium']);
    const profile = new SiteProfiles(ctx.db).get('acgrip')!;
    expect(profile.last_working_tier).toBe('chromium');
    expect(profile.fail_count).toBe(0);
  });

  it('skips when within cooldown, emitting subtitle.site-cooldown', async () => {
    const { ctx, job } = setup();
    const profiles = new SiteProfiles(ctx.db);
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    profiles.update('acgrip', { lastFailureAt: Date.now(), failCount: 2 });
    const tiers = stubTiers([]);

    await withFakeTime(async () => {
      const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
      expect(out).toBeNull();
    });
    expect(tiers.made).toHaveLength(0);
    expect(findEvent(ctx.events.list(), 'subtitle.site-cooldown')).toBeDefined();
  });

  it('records total failure (fail_count/last_failure_at) and emits subtitle.site-failed', async () => {
    const { ctx, job } = setup();
    ctx.llm = new FakeGenerator([new Error('bad llm output')]);
    const tiers = stubTiers([OK_HTML]);

    const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
    expect(out).toBeNull();
    const profile = new SiteProfiles(ctx.db).get('acgrip')!;
    expect(profile.fail_count).toBe(1);
    expect(profile.last_failure_at).not.toBeNull();
    expect(findEvent(ctx.events.list(), 'subtitle.site-failed')).toBeDefined();
    // The run row is marked failed (the LLM throw happened before any step, so no transcript).
    const row = new SubtitleRuns(ctx.db).listByJob(job.id).find((r) => r.site === 'acgrip')!;
    expect(row.status).toBe('failed');
    expect(row.transcript).toHaveLength(0);
  });

  it('success resets fail_count and leaves last_working_tier as the working rung', async () => {
    const { ctx, job } = setup();
    // Seed a prior failure so success must clear both the counter AND the timestamp —
    // otherwise a stale last_failure_at would keep the site in a residual cooldown.
    const profiles = new SiteProfiles(ctx.db);
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    profiles.update('acgrip', { failCount: 2, lastFailureAt: Date.now() - 10 * 60_000 });
    ctx.llm = new FakeGenerator([{ action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'dl' }]);
    const tiers = stubTiers([{ ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);

    const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
    expect(out).not.toBeNull();
    const profile = profiles.get('acgrip')!;
    expect(profile.fail_count).toBe(0);
    expect(profile.last_failure_at).toBeNull();
    expect(profile.last_success_at).not.toBeNull();
    expect(profile.last_working_tier).toBe('curl');
    const row = new SubtitleRuns(ctx.db).listByJob(job.id).find((r) => r.site === 'acgrip')!;
    expect(row.status).toBe('done');
    expect(row.transcript).toHaveLength(1);
  });

  it('does not skip a site after success just because last_failure_at is still recent', async () => {
    // fail_count is 0 (post-success / post-reset) but last_failure_at is 5s ago: without
    // the fail_count > 0 guard, failBackoffMs(0) would still block for the base cooldown.
    const { ctx, job } = setup();
    const profiles = new SiteProfiles(ctx.db);
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    profiles.update('acgrip', { failCount: 0, lastFailureAt: Date.now() - 5_000 });
    ctx.llm = new FakeGenerator([{ action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'dl' }]);
    const tiers = stubTiers([{ ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);

    const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
    expect(out).not.toBeNull();
    expect(findEvent(ctx.events.list(), 'subtitle.site-cooldown')).toBeUndefined();
  });

  it('success appends a newly discovered search pattern', async () => {
    const { ctx, job } = setup();
    ctx.llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/find?q=frieren', note: 's' },
      { action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'dl' },
    ]);
    const tiers = stubTiers([OK_HTML, { ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);

    const out = await searchSite(ctx, job, SITE, 'F', tmpDir(), tiers);
    expect(out).not.toBeNull();
    const profile = new SiteProfiles(ctx.db).get('acgrip')!;
    expect(profile.search_url_patterns).toEqual(['https://acg.rip/find?q=frieren']);
  });

  it('does not append the configured searchUrlTemplate itself', async () => {
    const { ctx, job } = setup();
    const literalTemplate: SubtitleSiteConfig = { name: 'acgrip', baseUrl: 'https://acg.rip', searchUrlTemplate: 'https://acg.rip/search' };
    ctx.llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/search', note: 's' },
      { action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'dl' },
    ]);
    const tiers = stubTiers([OK_HTML, { ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);

    await searchSite(ctx, job, literalTemplate, 'F', tmpDir(), tiers);
    const profile = new SiteProfiles(ctx.db).get('acgrip')!;
    expect(profile.search_url_patterns).toEqual([]);
  });
});
