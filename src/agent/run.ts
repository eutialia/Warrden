import { join } from 'node:path';
import type { AppContext } from '../context.js';
import { SiteProfiles, type AccessTier } from '../db/siteProfiles.js';
import { SubtitleRuns, type TranscriptEntry } from '../db/subtitleRuns.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { JobRow } from '../jobs/queue.js';
import { targetEventData } from '../events/target.js';
import { buildSearchHints, type SearchHints } from '../pipelines/subtitle/queries.js';
import { errorMessage } from '../util/errors.js';
import { resolveSiteAdapter } from './adapters/registry.js';
import { runAdapterSearch } from './adapters/run.js';
import type { SiteAdapter } from './adapters/types.js';
import { runAgentLoop, TierBlockedError } from './loop.js';
import { makeTier, TIER_ORDER, type FetchTier } from './tiers.js';

const MAX_BACKOFF_MS = 6 * 3_600_000;
/** After this long on a higher tier without probing cheaper ones, start one rung down so
 * sites that dropped a bot wall can decay back toward curl (design: tier decay). */
const TIER_DECAY_MS = 7 * 24 * 3_600_000;

/** Cooldown after repeated site failures: exponential on the site's configured base,
 * capped at 6h — a wall that dropped 10 minutes ago shouldn't be retried for a day, but a
 * persistently-failing site must not be hammered every job. */
export function failBackoffMs(failCount: number, baseSeconds = 30): number {
  return Math.min(2 ** failCount * baseSeconds * 1000, MAX_BACKOFF_MS);
}

/**
 * Ladder start index: remembered tier, optionally decayed one cheaper rung when the last
 * success is older than `TIER_DECAY_MS` so walls that dropped can be rediscovered without
 * a dashboard clear.
 */
export function tierStartIndex(
  lastWorkingTier: string | null,
  lastSuccessAt: number | null,
  now = Date.now(),
): number {
  const remembered = TIER_ORDER.indexOf(lastWorkingTier as (typeof TIER_ORDER)[number]);
  const floor = Math.max(0, remembered);
  if (floor === 0) return 0;
  if (lastSuccessAt !== null && now - lastSuccessAt >= TIER_DECAY_MS) {
    return floor - 1;
  }
  return floor;
}

interface TierFactory {
  make(t: AccessTier): FetchTier;
}

const REAL_TIERS: TierFactory = { make: makeTier };

export interface SearchSiteDeps {
  tiers?: TierFactory;
  /** Inject adapters in tests; production uses the built-in registry. */
  resolveAdapter?: (site: SubtitleSiteConfig) => SiteAdapter | null;
}

/**
 * Runs the site-search agent for one site with full access-ladder orchestration: cooldown
 * check, optional protocol adapter (parse-then-pick), then generic HTML loop with tier
 * escalation. Returns the downloaded file + its source URL, or null when the site
 * couldn't produce one this run — never throws (a broken site is a health event, not a job
 * failure). The transcript lands in `subtitle_runs` and streams live as
 * `subtitle.transcript` events.
 */
export async function searchSite(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  query: string | SearchHints,
  destDir: string,
  tiersOrDeps: TierFactory | SearchSiteDeps = REAL_TIERS,
): Promise<{ filePath: string; url: string } | null> {
  // Back-compat: tests pass a TierFactory as the 6th arg; production may pass deps.
  const deps: SearchSiteDeps =
    'make' in tiersOrDeps && typeof tiersOrDeps.make === 'function'
      ? { tiers: tiersOrDeps }
      : (tiersOrDeps as SearchSiteDeps);
  const tiers = deps.tiers ?? REAL_TIERS;
  const resolveAdapter = deps.resolveAdapter ?? resolveSiteAdapter;

  const profiles = new SiteProfiles(ctx.db);
  const runs = new SubtitleRuns(ctx.db);
  profiles.upsert({ name: site.name, baseUrl: site.baseUrl });
  const profile = profiles.get(site.name)!;
  const hints: SearchHints =
    typeof query === 'string'
      ? buildSearchHints({
          title: query,
          languages: ctx.config.subtitle.languages,
          preferredGroups: ctx.config.subtitle.preferredGroups,
        })
      : query;
  const primaryQuery = hints.title;

  // Cooldown only applies while fail_count > 0. Success (and the dashboard "reset
  // failures" path) set fail_count back to 0; without this guard a stale last_failure_at
  // would still block the site for failBackoffMs(0) even after a clean success/reset.
  const cooldownMs = failBackoffMs(profile.fail_count, ctx.config.browser.siteCooldownSeconds);
  if (
    profile.fail_count > 0 &&
    profile.last_failure_at !== null &&
    Date.now() - profile.last_failure_at < cooldownMs
  ) {
    ctx.events.append({
      kind: 'subtitle.site-cooldown',
      jobId: job.id,
      message: `Skipping ${site.name} — in failure cooldown (${Math.round(cooldownMs / 60_000)}m backoff)`,
      data: targetEventData(job, { site: site.name }),
    });
    return null;
  }

  const runId = runs.start(job.id, site.name);
  // Start at the remembered tier (with optional decay); unimplemented seams fall back via
  // indexOf === -1 → max(0, -1) === 0 in tierStartIndex.
  const startIdx = tierStartIndex(profile.last_working_tier, profile.last_success_at);
  const activeTiers: FetchTier[] = [];

  /** Shared append+SSE path for every transcript entry, whether emitted by the loop's own
   * steps or by the runner's escalation handling. */
  const onTranscriptEvent = (entry: TranscriptEntry): void => {
    runs.appendTranscript(runId, [entry]);
    ctx.events.append({
      kind: 'subtitle.transcript',
      jobId: job.id,
      message: `[${site.name}] ${entry.action}: ${entry.detail}`,
      data: targetEventData(job, { site: site.name, entry }),
    });
  };

  /** Persist a site-level failure (genuine error or every rung empty) and emit the event. */
  const failSite = (kind: 'subtitle.site-failed' | 'subtitle.site-exhausted', message: string): null => {
    runs.finish(runId, 'failed');
    profiles.update(site.name, { lastFailureAt: Date.now(), failCount: profile.fail_count + 1 });
    ctx.events.append({
      kind,
      level: 'warn',
      jobId: job.id,
      message,
      data: targetEventData(job, { site: site.name, dedupeKey: site.name }),
    });
    return null;
  };

  try {
    // Protocol adapter first (subhd, …): structured search + pick + download, one captcha try.
    const adapter = resolveAdapter(site);
    if (adapter) {
      try {
        const adapterOut = await runAdapterSearch({
          adapter,
          llm: ctx.llm,
          hints,
          destDir,
          workDir: join(ctx.dataDir, 'subtitle', 'adapter', site.name, String(job.id)),
          onTranscript: onTranscriptEvent,
        });
        if (adapterOut) {
          runs.finish(runId, 'done');
          profiles.update(site.name, {
            lastWorkingTier: 'curl',
            lastSuccessAt: Date.now(),
            failCount: 0,
            lastFailureAt: null,
          });
          return { filePath: adapterOut.filePath, url: adapterOut.url };
        }
        onTranscriptEvent({
          ts: Date.now(),
          tier: 'curl',
          action: 'adapter-fallback',
          detail: `${adapter.id}: no download — falling through to generic agent`,
        });
      } catch (err) {
        onTranscriptEvent({
          ts: Date.now(),
          tier: 'curl',
          action: 'adapter-fallback',
          detail: `${adapter.id}: error ${errorMessage(err)} — falling through to generic agent`,
        });
      }
    }

    for (let i = startIdx; i < TIER_ORDER.length; i++) {
      const tierName = TIER_ORDER[i]!;
      const tier = tiers.make(tierName);
      activeTiers.push(tier);
      try {
        const outcome = await runAgentLoop({
          llm: ctx.llm,
          tier,
          site,
          profile,
          query: primaryQuery,
          hints,
          destDir,
          maxSteps: ctx.config.browser.stepBudget,
          onTranscript: onTranscriptEvent,
        });

        if (outcome.kind === 'downloaded') {
          runs.finish(runId, 'done');
          const searchUrl = outcome.searchUrl;
          const isNew =
            searchUrl !== null &&
            searchUrl !== site.searchUrlTemplate &&
            !profile.search_url_patterns.includes(searchUrl);
          const learned = isNew
            ? [...profile.search_url_patterns, searchUrl].slice(-5)
            : profile.search_url_patterns;
          profiles.update(site.name, {
            lastWorkingTier: tierName,
            lastSuccessAt: Date.now(),
            failCount: 0,
            lastFailureAt: null,
            searchUrlPatterns: learned,
          });
          return { filePath: outcome.filePath, url: outcome.url };
        }
        // exhausted/gave-up: fall through to the next rung.
      } catch (err) {
        if (!(err instanceof TierBlockedError)) {
          // A genuine error (bad LLM output after retries, FS failure, ...) is a site-level
          // failure, not an escalation signal.
          return failSite('subtitle.site-failed', `Site ${site.name} failed: ${errorMessage(err)}`);
        }
        // TierBlockedError: note the wall in the run's transcript and try the next rung.
        onTranscriptEvent({ ts: Date.now(), tier: tierName, action: 'escalate', detail: errorMessage(err) });
      }
    }

    // Every rung came up empty.
    return failSite(
      'subtitle.site-exhausted',
      `Site ${site.name} produced no download across ${TIER_ORDER.length - startIdx} tier(s)`,
    );
  } finally {
    await Promise.all(activeTiers.map((t) => t.close()));
  }
}
