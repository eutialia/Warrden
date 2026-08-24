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
import { runAgentLoop, SEARCH_CALLSITE, TierBlockedError } from './loop.js';
import { describeStop, stopFromError, stopIsSiteFault, stopTone, type StopReason } from './stop.js';
import { LlmError } from '../llm/generator.js';
import { eventEnvelope } from '../events/envelope.js';
import { CookieJar, makeTier, TIER_ORDER, type FetchTier, type MakeTierOpts } from './tiers.js';

/** Transcript actions that cost the loop a step: every action the model chose, plus a reply
 * that would not parse (the loop spends a step telling it so). A refusal or an escalation
 * note rides on a step already counted. */
const STEP_ACTIONS = new Set(['search', 'open', 'download', 'request', 'give_up', 'malformed']);

/** How many steps a rung spent, read back off the transcript it wrote — the only account
 * left when the loop threw instead of returning its own `steps`. */
function stepsTaken(entries: TranscriptEntry[]): number {
  return entries.filter((e) => STEP_ACTIONS.has(e.action)).length;
}

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

/** Distinct search result pages a `not-found` give-up needs behind it to be taken at its
 * word and end the ladder there. One listing is a single look, which a cheap tier that
 * renders nothing produces just as readily as a site with nothing on it. */
const EVIDENCE_LISTINGS = 2;

/** What one `searchSite` call produced, whether or not it ended in a download. */
export interface SiteRunResult {
  /** Why the last attempt stopped — the one vocabulary every caller reports and decides on. */
  stop: StopReason;
  /** LLM steps the last attempt actually took — 0 when nothing ran (a wall on every rung).
   * What separates "searched once, nothing there" from a spent budget. */
  steps: number;
  download: { filePath: string; url: string } | null;
  transcript: TranscriptEntry[];
  /** Whether any rung of this run got a search result page back. A run that read a listing
   * has seen how the site's search actually works, whether or not it ended with a file. */
  searchObserved: boolean;
}

/**
 * One `agent.stop` event: the single line that says why a piece of LLM-driven work ended.
 * Every part of the location is optional because the callers differ — a ladder rung has a
 * round and a tier, a site skipped before anything ran has neither — but the ending itself is
 * always `describeStop`, never a sentence written at the call site.
 *
 * `searchSite` calls this exactly once per invocation, and the skip path in the subtitle
 * pipeline calls it for a visit that never started — so one `agent.stop` IS one site visit's
 * verdict, which is why it carries a `verdict` tone and the visit's whole shape as facts.
 * The dashboard's per-visit row reads these rather than re-deriving the same conclusion from
 * `subtitle_runs`.
 */
export function reportAgentStop(
  ctx: AppContext,
  job: JobRow,
  stop: StopReason,
  where: { callsite: string; site?: string; round?: number; maxRounds?: number; tier?: AccessTier; steps: number; url?: string },
): void {
  const head = [
    where.site !== undefined ? `[${where.site}]` : '',
    where.round !== undefined ? `round ${where.round}/${where.maxRounds ?? where.round}` : '',
    where.tier !== undefined ? `(${where.tier})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  ctx.events.append({
    kind: 'agent.stop',
    jobId: job.id,
    message: head === '' ? describeStop(stop) : `${head}: ${describeStop(stop)}`,
    data: eventEnvelope(
      {
        scope: 'subtitle',
        action: 'visit',
        facts: {
          site: where.site,
          tier: where.tier,
          round: where.round,
          maxRounds: where.maxRounds ?? where.round,
          steps: where.steps,
          stop: stop.kind,
          callsite: where.callsite,
          url: where.url,
          // The model's own sentence, where it wrote one — the difference between
          // "nothing found" and why it thinks so.
          reason: stop.kind === 'gave-up' ? stop.reason : stop.kind === 'error' ? stop.message : undefined,
          // The give-up's own classification, and the skip's: `stop` alone would collapse
          // "searched and found nothing" into "could not get through".
          outcome: stop.kind === 'gave-up' ? stop.because : stop.kind === 'skipped' ? stop.why : undefined,
          permanent: stop.kind === 'error' ? stop.permanent : undefined,
        },
        verdict: { tone: stopTone(stop) },
      },
      targetEventData(job),
    ),
  });
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
      data: eventEnvelope(
        {
          scope: 'subtitle',
          action: 'knowledge-refused',
          facts: { site: siteLabel(baseUrl), reasons: threats.map((t) => t.pattern), detail: threats[0]?.excerpt },
          verdict: { tone: 'danger' },
        },
        targetEventData(job, { dedupeKey: siteLabel(baseUrl) }),
      ),
    });
    return '';
  } catch (err) {
    ctx.events.append({
      kind: 'subtitle.knowledge-unreadable',
      level: 'warn',
      jobId: job.id,
      message: `Site knowledge for ${siteLabel(baseUrl)} could not be read — searching without it: ${errorMessage(err)}`,
      data: eventEnvelope(
        {
          scope: 'subtitle',
          action: 'knowledge-unreadable',
          facts: { site: siteLabel(baseUrl), error: errorMessage(err) },
          verdict: { tone: 'warning' },
        },
        targetEventData(job, { dedupeKey: siteLabel(baseUrl) }),
      ),
    });
    return '';
  }
}

/**
 * Runs the site-search agent for one site with full access-ladder orchestration: a generic
 * browse loop, once per rung, with tier escalation. Whether the site should be searched at
 * all (disabled, in cooldown) is the caller's filter, not this function's: reaching here
 * means an attempt starts. Site-specific protocols live in
 * the site's knowledge file (injected into the loop prompt), not in code adapters. Returns
 * a `SiteRunResult` carrying the download (if any), the full transcript, and the stop that
 * ended it — never throws (a broken site is a health event, not a job failure). The transcript lands
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
      data: eventEnvelope(
        {
          scope: 'subtitle',
          // The agent's own verb (`search`, `open`, `download`, `escalate`) — the step's
          // identity, so a consumer never parses it back out of the message.
          action: entry.action,
          facts: { site: siteLabel(site.baseUrl), tier: entry.tier, detail: entry.detail },
        },
        targetEventData(job, {
          ...(entry.level !== undefined ? { dedupeKey: `refused:${siteLabel(site.baseUrl)}` } : {}),
        }),
      ),
    });
  };

  /** Whether any rung read a search listing — carried across rungs, since the run's whole
   * transcript is what reflection is handed. */
  let searchObserved = false;

  /** The rung the ladder is on — what the stop event reports against. Set before `make()`
   * so a factory throw names the rung it threw for, not the one that worked. */
  let lastTier: AccessTier = TIER_ORDER[startIdx]!;

  /**
   * Ends a run that brought back no file: one `agent.stop` line saying which tier it
   * finished on, how many steps it spent and why it ended, the `subtitle_runs` row closed,
   * and the failure booked against the site's profile — but only when the stop is the
   * site's own fault. `failure` is the separate question of whether an operator is told at
   * all: a wall on a run that was never allowed to climb says nothing about the site, so it
   * gets neither the event nor the backoff.
   */
  const endRun = (
    stop: StopReason,
    steps: number,
    failure?: { kind: 'subtitle.site-failed' | 'subtitle.site-exhausted'; message: string },
  ): SiteRunResult => {
    reportAgentStop(ctx, job, stop, {
      callsite: SEARCH_CALLSITE,
      site: siteLabel(site.baseUrl),
      round,
      maxRounds,
      tier: lastTier,
      steps,
    });
    runs.finish(runId, 'failed');
    siteStep.end('error');
    if (failure !== undefined) {
      if (stopIsSiteFault(stop)) {
        profiles.update(site.baseUrl, { lastFailureAt: Date.now(), failCount: profile.fail_count + 1 });
      }
      ctx.events.append({
        kind: failure.kind,
        level: 'warn',
        jobId: job.id,
        message: failure.message,
        data: eventEnvelope(
          {
            scope: 'subtitle',
            action: failure.kind === 'subtitle.site-failed' ? 'site-failed' : 'site-exhausted',
            facts: { site: siteLabel(site.baseUrl), tier: lastTier, steps, stop: stop.kind },
            verdict: { tone: stopTone(stop) },
          },
          targetEventData(job, { dedupeKey: siteLabel(site.baseUrl) }),
        ),
      });
    }
    return { stop, steps, download: null, transcript, searchObserved };
  };

  try {
    // What the last rung reported: the wall it would be if no rung ever got to run.
    let lastStop: StopReason = { kind: 'blocked', tier: lastTier };
    // Whether any rung got as far as returning a stop. False after the loop means every
    // rung hit a wall, which is a different story from a ladder that ran and found nothing.
    let attempted = false;
    // Steps the last attempt spent. A throw has no return value to read it off, so the
    // rung's own transcript entries are counted instead (`stepsTaken`).
    let steps = 0;
    // Rungs that actually returned or threw — what the site-level events count.
    let rungsTried = 0;
    // Whether the one rung a give-up the agent could not back up is allowed to buy has
    // been spent. One is the whole allowance: a second would be paying chromium prices to
    // re-read the same uncertainty.
    let softRungSpent = false;

    // Without escalation the ladder is one rung tall: the site's remembered starting tier.
    const lastIdx = opts.escalate === false ? startIdx : TIER_ORDER.length - 1;
    for (let i = startIdx; i <= lastIdx; i++) {
      const tierName = TIER_ORDER[i]!;
      lastTier = tierName;
      rungsTried += 1;
      // Where this rung's transcript starts, so a throw can be told what this rung spent
      // rather than what the whole ladder did.
      const rungStart = transcript.length;
      // make() lives inside the try so a factory throw cannot escape searchSite's
      // never-throws contract — it is handled like any other tier failure.
      try {
        const tier = tiers.make(tierName);
        activeTiers.push(tier);
        const run = await runAgentLoop({
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
        steps = run.steps;
        lastStop = run.stop;
        searchObserved ||= run.listings > 0;

        if (run.download !== undefined) {
          runs.finish(runId, 'done');
          siteStep.end('ok');
          const searchUrl = run.download.searchUrl;
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
          reportAgentStop(ctx, job, run.stop, {
            callsite: SEARCH_CALLSITE,
            site: siteLabel(site.baseUrl),
            round,
            maxRounds,
            tier: tierName,
            steps: run.steps,
            url: run.download.url,
          });
          return {
            stop: run.stop,
            steps: run.steps,
            download: { filePath: run.download.filePath, url: run.download.url },
            transcript,
            searchObserved,
          };
        }

        if (run.stop.kind === 'gave-up') {
          // The agent's own account of the site, answered rung by rung. A wall it named
          // itself is exactly what the ladder exists for, so it climbs. "I searched and
          // found nothing", with two distinct listings behind it, is believed: another rung
          // would pay chromium prices to read the same empty results. Anything less — one
          // listing, none, or "I could not tell" — buys exactly one more rung, because a
          // cheap tier that renders nothing looks identical to a site with nothing on it.
          if (run.stop.because === 'blocked') continue;
          if (run.stop.because === 'not-found' && run.listings >= EVIDENCE_LISTINGS) break;
          if (softRungSpent) break;
          softRungSpent = true;
          continue;
        }

        // Refusals and malformed replies end the site here rather than on the next rung: one
        // would replay the same guarded destinations at full step budget, the other would put
        // the same prompt to the same model. Both take the usual failure backoff.
        if (run.stop.kind === 'refused' || run.stop.kind === 'malformed') {
          return endRun(run.stop, run.steps, {
            kind: 'subtitle.site-failed',
            message: `Site ${siteLabel(site.baseUrl)} failed: ${describeStop(run.stop)}`,
          });
        }
        // exhausted/gave-up: fall through to the next rung.
      } catch (err) {
        if (!(err instanceof TierBlockedError)) {
          const stop = stopFromError(err);
          // The provider failing is not the site failing. Blaming the site for it books a
          // `fail_count` bump and a cooldown on a run that never searched, and hands the
          // pipeline a "no download" it reports as "nothing found". Let it out instead: the
          // job fails, and the runner retries it with the backoff the error asks for — the
          // same thing `archive-map` has always done. A reply that would not parse stays
          // `malformed`; that is the model answering wrong, not the call failing.
          if (stop.kind !== 'malformed' && err instanceof LlmError) {
            runs.finish(runId, 'failed');
            siteStep.end('error');
            throw err;
          }
          // A genuine error (a dead route, an FS failure, a factory throw, ...) is a
          // site-level failure, not an escalation signal.
          return endRun(stop, stepsTaken(transcript.slice(rungStart)), {
            kind: 'subtitle.site-failed',
            message: `Site ${siteLabel(site.baseUrl)} failed: ${describeStop(stop)}`,
          });
        }
        // TierBlockedError: note the wall in the run's transcript and try the next rung.
        lastStop = { kind: 'blocked', tier: tierName };
        steps = 0;
        onTranscriptEvent({ ts: Date.now(), tier: tierName, action: 'escalate', detail: errorMessage(err) });
      }
    }

    // Every rung hit a wall before the loop could run: nothing was searched. Without
    // escalation that is not the site's fault at all — the run simply was not allowed to
    // answer the wall — so it takes no failure and no cooldown, and the next job (or the next
    // round with escalation on) finds the site exactly as it left it.
    if (!attempted) {
      if (opts.escalate === false) return endRun(lastStop, 0);
      return endRun(lastStop, 0, {
        kind: 'subtitle.site-exhausted',
        message: `Site ${siteLabel(site.baseUrl)} was blocked at every tier (${rungsTried})`,
      });
    }

    // Every rung came up empty.
    return endRun(lastStop, steps, {
      kind: 'subtitle.site-exhausted',
      message: `Site ${siteLabel(site.baseUrl)} produced no download across ${rungsTried} tier(s)`,
    });
  } finally {
    await Promise.all(activeTiers.map((t) => t.close()));
  }
}
