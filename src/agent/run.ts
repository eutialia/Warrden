import type { AppContext } from '../context.js';
import { siteLabel } from '../config/siteLabel.js';
import { SiteProfiles, type AccessTier } from '../db/siteProfiles.js';
import { SubtitleRuns, type TranscriptEntry } from '../db/subtitleRuns.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { JobRow } from '../jobs/queue.js';
import { targetEventData } from '../events/target.js';
import { buildSearchHints, type SearchHints } from '../pipelines/subtitle/queries.js';
import { errorMessage } from '../util/errors.js';
import { AGENT_SECTIONS, defaultSeedsDir, knowledgeForPrompt, loadKnowledge } from './siteKnowledge.js';
import { scanForThreats } from './threatPatterns.js';
import { runAgentLoop, TierBlockedError } from './loop.js';
import { CookieJar, makeTier, TIER_ORDER, type FetchTier, type MakeTierOpts } from './tiers.js';

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

/** Production tiers for one site-search run: shared cookie jar on curl, fresh chromium context.
 * Each call gets a fresh jar so consecutive searchSite invocations never share cookies.
 * Optional `fetchImpl` is for tests that mock HTTP on the real factory shape. */
export function createRunTiers(opts: Pick<MakeTierOpts, 'fetchImpl'> = {}): TierFactory {
  const cookieJar = new CookieJar();
  return { make: (t) => makeTier(t, { cookieJar, fetchImpl: opts.fetchImpl }) };
}

/** What one `searchSite` call produced, whether or not it ended in a download. `outcome`
 * lets a caller decide whether the run is worth reflecting on: `'cooldown'` means nothing
 * ran at all (the site was skipped before any tier was tried), so it is the one value a
 * caller should treat as "skip reflection" rather than "reflect on a failure". */
export interface SiteRunResult {
  download: { filePath: string; url: string } | null;
  transcript: TranscriptEntry[];
  /** LLM steps the last attempt actually took — 0 when nothing ran (cooldown, a wall on
   * every rung). What separates "searched once, nothing there" from a spent budget. */
  steps: number;
  outcome: 'downloaded' | 'gave-up' | 'exhausted' | 'blocked' | 'cooldown' | 'error';
}

export interface SearchSiteOptions {
  tiers?: TierFactory;
  /** Overrides `defaultSeedsDir()`. Tests always set it, pointing at a fixture directory
   * (usually an empty one), so a real shipped seed can never leak into a test that
   * happens to use the same base URL. */
  seedsDir?: string;
  /** Which round of this job's site search this call is, and how many it may get — the
   * caller owns the counter; this is only here so the round event can name it. */
  round?: number;
  maxRounds?: number;
  /**
   * Whether a tier wall may be answered by climbing the ladder. False keeps the run on the
   * site's remembered starting tier (curl on a fresh profile): the fresh-episode case, where
   * an empty result is about the calendar rather than the wall, and paying for chromium to
   * confirm the same emptiness is waste.
   */
  escalate?: boolean;
}

/**
 * The site's knowledge, rendered for the loop's system prompt, or `''` when there is none
 * to give. Two things can take it away, and both degrade this one site rather than the
 * job:
 *
 * - The agent-owned half trips the injection scan. Neither half is injected then, since a
 *   tampered agent half makes the whole file suspect — not repaired, not partially used —
 *   and an attention-level event puts it in front of a human. Operator notes are never
 *   scanned: they're trusted input by definition, and scanning them would let a phrase a
 *   human deliberately wrote refuse their own instruction. A clean scan is a cheap
 *   tripwire, not proof of safety — the bounded action set and the guards in loop.ts are
 *   what actually bound the damage of anything that gets through.
 * - Reading the file fails outright: the data volume went read-only, or something left a
 *   directory where the file should be. `loadKnowledge` reads and copies without a net,
 *   so that throw would otherwise escape `searchSite`, which promises never to throw, and
 *   fail the whole subtitle job over one site's file.
 */
function loadKnowledgeForPrompt(ctx: AppContext, job: JobRow, baseUrl: string, seedsDir: string): string {
  try {
    const knowledgeFile = loadKnowledge(ctx.dataDir, baseUrl, seedsDir);
    const agentText = AGENT_SECTIONS.flatMap((s) => knowledgeFile.sections[s]).join('\n');
    const threats = agentText ? scanForThreats(agentText, 'strict') : [];
    if (threats.length === 0) return knowledgeForPrompt(knowledgeFile);

    ctx.events.append({
      kind: 'subtitle.knowledge-refused',
      level: 'attention',
      jobId: job.id,
      message: `Site knowledge for ${siteLabel(baseUrl)} looks tampered with and was not used`,
      data: targetEventData(job, {
        site: siteLabel(baseUrl),
        dedupeKey: siteLabel(baseUrl),
        patterns: threats.map((t) => t.pattern),
        excerpt: threats[0]?.excerpt,
      }),
    });
    return '';
  } catch (err) {
    ctx.events.append({
      kind: 'subtitle.knowledge-unreadable',
      level: 'warn',
      jobId: job.id,
      message: `Site knowledge for ${siteLabel(baseUrl)} could not be read — searching without it: ${errorMessage(err)}`,
      data: targetEventData(job, { site: siteLabel(baseUrl), dedupeKey: siteLabel(baseUrl) }),
    });
    return '';
  }
}

/**
 * Runs the site-search agent for one site with full access-ladder orchestration: cooldown
 * check, then generic browse loop with tier escalation. Site-specific protocols live in
 * the site's knowledge file (injected into the loop prompt), not in code adapters. Returns
 * a `SiteRunResult` carrying the download (if any), the full transcript, and an outcome —
 * never throws (a broken site is a health event, not a job failure). The transcript lands
 * in `subtitle_runs` and streams live as `subtitle.transcript` events, and is also handed
 * back to the caller so it can be replayed into reflection.
 */
export async function searchSite(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  query: string | SearchHints,
  destDir: string,
  opts: SearchSiteOptions = {},
): Promise<SiteRunResult> {
  // Fresh jar per invocation when using the real factory (each call builds a new one;
  // opts.tiers from tests is left alone).
  const tiers = opts.tiers ?? createRunTiers();
  const round = opts.round ?? 1;
  const maxRounds = opts.maxRounds ?? 1;

  const profiles = new SiteProfiles(ctx.db);
  const runs = new SubtitleRuns(ctx.db);
  profiles.upsert({ baseUrl: site.baseUrl });
  const profile = profiles.get(site.baseUrl)!;
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
      message: `Skipping ${siteLabel(site.baseUrl)} — in failure cooldown (${Math.round(cooldownMs / 60_000)}m backoff)`,
      data: targetEventData(job, { site: siteLabel(site.baseUrl) }),
    });
    return { download: null, transcript: [], steps: 0, outcome: 'cooldown' };
  }

  const knowledge = loadKnowledgeForPrompt(ctx, job, site.baseUrl, opts.seedsDir ?? defaultSeedsDir());

  const runId = runs.start(job.id, siteLabel(site.baseUrl));
  // One top-level step per site, so every agent step, LLM call and tier escalation of this
  // site's run hangs off it in the trace view.
  const siteStep = ctx.trace.begin({
    jobId: job.id,
    kind: 'subtitle.site',
    summary: siteLabel(site.baseUrl),
  });
  // Start at the remembered tier (with optional decay); unimplemented seams fall back via
  // indexOf === -1 → max(0, -1) === 0 in tierStartIndex.
  const startIdx = tierStartIndex(profile.last_working_tier, profile.last_success_at);
  const activeTiers: FetchTier[] = [];
  // Every transcript entry this run produces, in order — handed back to the caller so
  // reflection (Task 6) sees the same steps that landed in subtitle_runs.
  const transcript: TranscriptEntry[] = [];
  // Steps the last completed attempt spent, carried onto every result shape — including the
  // failing ones, whose caller still has to tell a two-step give-up from a spent budget.
  let stepsSpent = 0;

  /** Shared append+SSE path for every transcript entry, whether emitted by the loop's own
   * steps or by the runner's escalation handling. */
  const onTranscriptEvent = (entry: TranscriptEntry): void => {
    transcript.push(entry);
    runs.appendTranscript(runId, [entry]);
    ctx.trace.event({
      jobId: job.id,
      kind: 'agent.step',
      parentSeq: siteStep.seq ?? undefined,
      summary: `${entry.action}: ${entry.detail}`.slice(0, 200),
      payload: () => entry,
    });
    ctx.events.append({
      kind: 'subtitle.transcript',
      // A refused private/loopback destination carries `attention` (see the loop's
      // `refuse`), which files the step as an attention item. Its own dedupeKey keeps the
      // whole run's refusals collapsed into one item, and keeps that item distinct from
      // any other attention this target raises.
      ...(entry.level !== undefined ? { level: entry.level } : {}),
      jobId: job.id,
      message: `[${siteLabel(site.baseUrl)}] ${entry.action}: ${entry.detail}`,
      data: targetEventData(job, {
        site: siteLabel(site.baseUrl),
        entry,
        ...(entry.level !== undefined ? { dedupeKey: `refused:${siteLabel(site.baseUrl)}` } : {}),
      }),
    });
  };

  /**
   * One line per round, so an operator reading the run can see what ended each one without
   * opening the transcript: which tier it ran on, how many steps it spent, and whether it
   * downloaded, gave up (in the agent's own words), ran out of budget, or broke. Emitted
   * once per `searchSite` call — a call that climbs two rungs is still one round, reported
   * against the rung it finished on.
   */
  const reportRound = (tier: AccessTier, outcome: string, detail: string, extra: Record<string, unknown>): void => {
    ctx.events.append({
      kind: 'subtitle.search-round',
      jobId: job.id,
      message: `[${siteLabel(site.baseUrl)}] round ${round}/${maxRounds} (${tier}): ${detail}`,
      data: targetEventData(job, { site: siteLabel(site.baseUrl), round, tier, outcome, ...extra }),
    });
  };

  /** Persist a site-level failure (genuine error or every rung empty) and emit the event. */
  const failSite = (
    kind: 'subtitle.site-failed' | 'subtitle.site-exhausted',
    message: string,
    outcome: 'error' | 'exhausted' | 'gave-up' | 'blocked',
  ): SiteRunResult => {
    runs.finish(runId, 'failed');
    siteStep.end('error');
    profiles.update(site.baseUrl, { lastFailureAt: Date.now(), failCount: profile.fail_count + 1 });
    ctx.events.append({
      kind,
      level: 'warn',
      jobId: job.id,
      message,
      data: targetEventData(job, { site: siteLabel(site.baseUrl), dedupeKey: siteLabel(site.baseUrl) }),
    });
    return { download: null, transcript, steps: stepsSpent, outcome };
  };

  try {
    // What the last rung's loop reported when it fell through (rather than erroring or
    // refusing) — carried into the final "every rung came up empty" outcome so a caller can
    // tell a deliberate give-up from a ladder that genuinely ran dry.
    let lastAttemptOutcome: 'exhausted' | 'gave-up' = 'exhausted';
    // The rung the ladder is currently on — what the round event reports against. Set before
    // `make()` so a factory throw names the rung it threw for, not the one that worked.
    let lastTier: AccessTier = TIER_ORDER[startIdx]!;
    // Whether any rung got as far as returning an outcome. False after the loop means every
    // rung hit a wall, which is a different story from a ladder that ran and found nothing.
    let attempted = false;
    // Carried out of the loop so the round event can name the step count and the model's own
    // give-up sentence after the ladder has ended.
    let lastSteps = 0;
    let lastReason: string | null = null;

    // Without escalation the ladder is one rung tall: the site's remembered starting tier.
    const lastIdx = opts.escalate === false ? startIdx : TIER_ORDER.length - 1;
    for (let i = startIdx; i <= lastIdx; i++) {
      const tierName = TIER_ORDER[i]!;
      lastTier = tierName;
      // make() lives inside the try so a factory throw cannot escape searchSite's
      // never-throws contract — it is handled like any other tier failure.
      try {
        const tier = tiers.make(tierName);
        activeTiers.push(tier);
        const outcome = await runAgentLoop({
          llm: ctx.llm,
          tier,
          site,
          profile,
          knowledge,
          query: primaryQuery,
          hints,
          destDir,
          maxSteps: ctx.config.browser.stepBudget,
          onTranscript: onTranscriptEvent,
          trace: siteStep.seq !== null ? { jobId: job.id, parentSeq: siteStep.seq } : undefined,
        });

        attempted = true;
        lastSteps = outcome.steps;
        stepsSpent = outcome.steps;
        if (outcome.kind === 'downloaded') {
          runs.finish(runId, 'done');
          siteStep.end('ok');
          const searchUrl = outcome.searchUrl;
          const isNew =
            searchUrl !== null &&
            searchUrl !== site.searchUrlTemplate &&
            !profile.search_url_patterns.includes(searchUrl);
          const learned = isNew
            ? [...profile.search_url_patterns, searchUrl].slice(-5)
            : profile.search_url_patterns;
          profiles.update(site.baseUrl, {
            lastWorkingTier: tierName,
            lastSuccessAt: Date.now(),
            failCount: 0,
            lastFailureAt: null,
            searchUrlPatterns: learned,
          });
          reportRound(tierName, 'downloaded', `downloaded ${outcome.url}`, { steps: outcome.steps });
          return { download: { filePath: outcome.filePath, url: outcome.url }, transcript, steps: outcome.steps, outcome: 'downloaded' };
        }
        if (outcome.kind === 'refused-repeatedly') {
          // The knowledge file (or the model reading it) keeps aiming at addresses the
          // guards refuse. Escalating would replay the same refusals on every remaining
          // rung at full step budget, so the site stops here and takes the usual failure
          // backoff — the next job retries it, after a human has had the chance to look.
          reportRound(tierName, 'refused-repeatedly', `refused ${outcome.refusals} times`, { steps: outcome.steps });
          return failSite(
            'subtitle.site-failed',
            `Site ${siteLabel(site.baseUrl)} failed: ${outcome.refusals} steps targeted a refused address`,
            'error',
          );
        }
        if (outcome.kind === 'malformed-repeatedly') {
          // The model is not answering the schema on this prompt. Another rung would put
          // the same prompt to the same model, so the site stops here — same shape as a run
          // that kept aiming at refused addresses.
          reportRound(tierName, 'malformed-repeatedly', `malformed replies ${outcome.failures} times`, { steps: outcome.steps });
          return failSite(
            'subtitle.site-failed',
            `Site ${siteLabel(site.baseUrl)} failed: ${outcome.failures} replies were not valid JSON`,
            'error',
          );
        }
        // exhausted/gave-up: fall through to the next rung.
        lastAttemptOutcome = outcome.kind === 'gave-up' ? 'gave-up' : 'exhausted';
        lastReason = outcome.kind === 'gave-up' ? outcome.reason : null;
      } catch (err) {
        if (!(err instanceof TierBlockedError)) {
          // A genuine error (bad LLM output after retries, FS failure, factory throw, ...)
          // is a site-level failure, not an escalation signal.
          // Steps are not reported for a throw: the loop never returned an outcome to count.
          reportRound(lastTier, 'error', `error: ${errorMessage(err)}`, { steps: 0, error: errorMessage(err) });
          return failSite('subtitle.site-failed', `Site ${siteLabel(site.baseUrl)} failed: ${errorMessage(err)}`, 'error');
        }
        // TierBlockedError: note the wall in the run's transcript and try the next rung.
        onTranscriptEvent({ ts: Date.now(), tier: tierName, action: 'escalate', detail: errorMessage(err) });
      }
    }

    // Every rung hit a wall before the loop could run: nothing was searched, so there is no
    // step count and no give-up sentence to report. Without escalation that is not the
    // site's fault at all — the run simply was not allowed to answer the wall — so it takes
    // no failure and no cooldown, and the next job (or the next round with escalation on)
    // finds the site exactly as it left it.
    if (!attempted) {
      if (opts.escalate === false) {
        reportRound(lastTier, 'blocked', `blocked at ${lastTier}`, { steps: 0 });
        runs.finish(runId, 'failed');
        siteStep.end('error');
        return { download: null, transcript, steps: 0, outcome: 'blocked' };
      }
      reportRound(lastTier, 'blocked', 'blocked at every tier', { steps: 0 });
      return failSite(
        'subtitle.site-exhausted',
        `Site ${siteLabel(site.baseUrl)} was blocked at every tier (${lastIdx - startIdx + 1})`,
        'blocked',
      );
    }

    // Every rung came up empty.
    if (lastAttemptOutcome === 'gave-up') {
      reportRound(lastTier, 'gave-up', `gave up: ${lastReason ?? 'no reason given'}`, {
        steps: lastSteps,
        reason: lastReason ?? 'no reason given',
      });
    } else {
      reportRound(lastTier, 'exhausted', `step budget exhausted after ${lastSteps} steps`, { steps: lastSteps });
    }
    return failSite(
      'subtitle.site-exhausted',
      `Site ${siteLabel(site.baseUrl)} produced no download across ${lastIdx - startIdx + 1} tier(s)`,
      lastAttemptOutcome,
    );
  } finally {
    await Promise.all(activeTiers.map((t) => t.close()));
  }
}
