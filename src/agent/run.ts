import type { AppContext } from '../context.js';
import { SiteProfiles, type AccessTier } from '../db/siteProfiles.js';
import { SubtitleRuns } from '../db/subtitleRuns.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { JobRow } from '../jobs/queue.js';
import { targetEventData } from '../events/target.js';
import { errorMessage } from '../util/errors.js';
import { runAgentLoop, TierBlockedError } from './loop.js';
import { makeTier, TIER_ORDER, type FetchTier } from './tiers.js';

const MAX_BACKOFF_MS = 6 * 3_600_000;

/** Cooldown after repeated site failures: exponential on the site's configured base,
 * capped at 6h — a wall that dropped 10 minutes ago shouldn't be retried for a day, but a
 * persistently-failing site must not be hammered every job. */
export function failBackoffMs(failCount: number, baseSeconds = 30): number {
  return Math.min(2 ** failCount * baseSeconds * 1000, MAX_BACKOFF_MS);
}

interface TierFactory {
  make(t: AccessTier): FetchTier;
}

const REAL_TIERS: TierFactory = { make: makeTier };

/**
 * Runs the site-search agent for one site with full access-ladder orchestration: cooldown
 * check, start at the remembered tier, escalate one rung on TierBlockedError, and persist
 * every outcome back into the site profile (tier floor, discovered search patterns,
 * failure backoff). Returns the downloaded file + its source URL, or null when the site
 * couldn't produce one this run — never throws (a broken site is a health event, not a job
 * failure). The transcript lands in `subtitle_runs` and streams live as
 * `subtitle.transcript` events.
 */
export async function searchSite(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  query: string,
  destDir: string,
  tiers: TierFactory = REAL_TIERS,
): Promise<{ filePath: string; url: string } | null> {
  const profiles = new SiteProfiles(ctx.db);
  const runs = new SubtitleRuns(ctx.db);
  profiles.upsert({ name: site.name, baseUrl: site.baseUrl });
  const profile = profiles.get(site.name)!;

  const cooldownMs = failBackoffMs(profile.fail_count, ctx.config.browser.siteCooldownSeconds);
  if (profile.last_failure_at !== null && Date.now() - profile.last_failure_at < cooldownMs) {
    ctx.events.append({
      kind: 'subtitle.site-cooldown',
      jobId: job.id,
      message: `Skipping ${site.name} — in failure cooldown (${Math.round(cooldownMs / 60_000)}m backoff)`,
      data: targetEventData(job, { site: site.name }),
    });
    return null;
  }

  const runId = runs.start(job.id, site.name);
  const startIdx = Math.max(0, TIER_ORDER.indexOf((profile.last_working_tier ?? 'curl') as (typeof TIER_ORDER)[number]));
  const activeTiers: FetchTier[] = [];

  try {
    for (let i = startIdx; i < TIER_ORDER.length; i++) {
      const tier = tiers.make(TIER_ORDER[i]!);
      activeTiers.push(tier);
      try {
        const outcome = await runAgentLoop({
          llm: ctx.llm,
          tier,
          site,
          profile: profiles.get(site.name)!,
          query,
          destDir,
          maxSteps: ctx.config.browser.stepBudget,
          onTranscript: (entry) => {
            runs.appendTranscript(runId, [entry]);
            ctx.events.append({ kind: 'subtitle.transcript', jobId: job.id, message: `[${site.name}] ${entry.action}: ${entry.detail}`, data: targetEventData(job, { site: site.name, entry }) });
          },
        });

        if (outcome.kind === 'downloaded') {
          runs.finish(runId, 'done');
          const learned = profile.search_url_patterns;
          profiles.update(site.name, { lastWorkingTier: TIER_ORDER[i], lastSuccessAt: Date.now(), failCount: 0, searchUrlPatterns: learned.slice(0, 5) });
          return { filePath: outcome.filePath, url: outcome.url };
        }
        // exhausted/gave-up/blocked-without-error: fall through to the next rung.
      } catch (err) {
        if (!(err instanceof TierBlockedError)) {
          // A genuine error (bad LLM output after retries, FS failure, ...) is a site-level
          // failure, not an escalation signal.
          runs.finish(runId, 'failed');
          profiles.update(site.name, { lastFailureAt: Date.now(), failCount: profile.fail_count + 1 });
          ctx.events.append({
            kind: 'subtitle.site-failed', level: 'warn', jobId: job.id,
            message: `Site ${site.name} failed: ${errorMessage(err)}`,
            data: targetEventData(job, { site: site.name, dedupeKey: site.name }),
          });
          return null;
        }
        // TierBlockedError: record the wall and try the next rung.
        profiles.update(site.name, { notes: `${TIER_ORDER[i]} blocked (${new Date().toISOString()})` });
      }
    }

    // Every rung came up empty.
    runs.finish(runId, 'failed');
    profiles.update(site.name, { lastFailureAt: Date.now(), failCount: profile.fail_count + 1 });
    ctx.events.append({
      kind: 'subtitle.site-exhausted', level: 'warn', jobId: job.id,
      message: `Site ${site.name} produced no download across ${TIER_ORDER.length - startIdx} tier(s)`,
      data: targetEventData(job, { site: site.name, dedupeKey: site.name }),
    });
    return null;
  } finally {
    await Promise.all(activeTiers.map((t) => t.close()));
  }
}
