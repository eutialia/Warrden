import { z } from 'zod';
import { join } from 'node:path';
import { isObjectParseFailure, type StructuredGenerator } from '../llm/generator.js';
import { refusedDestination, type RefusedDestination } from './destinationGuard.js';
import type { FetchResult, FetchTier } from './tiers.js';
import { siteKey } from '../config/siteLabel.js';
import { safeUrlTailName } from '../fs/paths.js';
import type { SiteProfileRow } from '../db/siteProfiles.js';
import type { TranscriptEntry } from '../db/subtitleRuns.js';
import { formatSearchHintsForPrompt, FRESH_DAYS, type SearchHints } from '../pipelines/subtitle/queries.js';

const CALLSITE = 'site-search';
/** Cap on the most recent step's observation stored in history (and shown full in the prompt). */
const OBSERVATION_CAP = 16_000;
/** Older steps' observations are truncated to this at render time so the rolling prompt stays bounded. */
const ELIDED_OBSERVATION_CAP = 1000;

/**
 * Flat root object — never a union — per the Anthropic/OpenAI strict-mode constraint
 * documented on matchLlm.ts's schema. Every field is REQUIRED: dropping one from
 * `required` (via `.optional()` / `.default()`) is rejected by OpenAI strict mode.
 * Sentinels: `url` is '' for give_up; `method` is always GET|POST (GET unless the step
 * needs POST); `body`/`contentType`/`referer` are '' when absent. Loop code treats '' as none.
 */
export const AgentActionSchema = z.object({
  action: z.enum(['search', 'open', 'download', 'request', 'give_up']).describe('what to do next'),
  url: z.string().describe('the absolute URL to act on (empty string for give_up)'),
  note: z.string().describe('one short sentence explaining this step for the transcript'),
  method: z.enum(['GET', 'POST']).describe('HTTP method for request (always emit; use GET unless the step needs POST)'),
  body: z.string().describe('request body for POST; empty string when none'),
  contentType: z.string().describe('Content-Type for request body; empty string when none'),
  referer: z.string().describe('Referer header for request/download; empty string when none'),
  reason: z.string().describe('for give_up: one sentence on why; empty string otherwise'),
});
/**
 * Every outcome carries `steps`: how many LLM steps this attempt actually took, which is
 * what separates a "nothing exists yet" give-up after two steps from a run that spent its
 * whole budget. `exhausted` always spent `maxSteps`.
 */
export type AgentOutcome = { steps: number } & (
  | { kind: 'downloaded'; filePath: string; url: string; searchUrl: string | null }
  | { kind: 'exhausted' }
  /** `reason` is the model's own sentence, or `NO_REASON` when it gave none. */
  | { kind: 'gave-up'; reason: string }
  /** REFUSAL_LIMIT guarded destinations in one run — the runner stops the site rather
   * than paying for the same refusals again on every remaining tier. */
  | { kind: 'refused-repeatedly'; refusals: number }
  /** MALFORMED_LIMIT consecutive replies that were not the JSON object, after the
   * generator's own repair and retry. The model is not answering the schema on this
   * prompt; another rung would put the same prompt to the same model. */
  | { kind: 'malformed-repeatedly'; failures: number }
);

/** What a give-up says when the model left `reason` empty. */
const NO_REASON = 'no reason given';

/**
 * How many refused destinations end a run. A refusal costs an LLM call and returns no
 * page, so a knowledge file that keeps naming a guarded address would otherwise burn the
 * whole step budget once per tier — four full budgets of paid calls before the site gives
 * up. Three leaves room for a model that misreads a page once and corrects itself.
 *
 * Only the refusals a human is told about count (the `attention` ones: a private/loopback
 * destination, directly or via a redirect hop). Ending a site run has real cost — a failed
 * site, a `fail_count` bump, backoff before the next try — and the other refusals are
 * ordinary model slips: a protocol-relative URL, or a `request` aimed off-site. Those fail
 * their own step and the run carries on to its step budget, as it did before the breaker
 * existed.
 */
const REFUSAL_LIMIT = 3;

/**
 * How many replies in a row that are not the JSON object end a run. One is ordinary — the
 * correction goes into the next prompt and models usually take it — but a model that has
 * answered prose three times running is not going to answer the schema on the fourth, and
 * every attempt is a paid call. A successful step clears the count: a single slip
 * mid-transcript says nothing about the run.
 */
const MALFORMED_LIMIT = 3;

/** The correction fed back to the model after a reply that would not parse. */
const MALFORMED_NOTE = 'previous reply was not valid JSON — reply with the JSON object only, no code fence';

/** Cap on a refused URL echoed into the next prompt. It can be attacker-chosen text of any
 * length (a hostile site's `Location` header), and every other thing a page puts in the
 * prompt is bounded, so this is too. */
const REFUSED_URL_CAP = 200;

function capUrl(url: string): string {
  return url.length <= REFUSED_URL_CAP ? url : `${url.slice(0, REFUSED_URL_CAP)}…[elided]`;
}

/** Cap on the failed page's text echoed into the next prompt. Long enough for the sentence
 * a site puts on its error page, short enough that a failure never crowds out the run. */
const ERROR_SNIPPET_CAP = 600;

/**
 * A failed fetch rendered as one history line. The status on its own leaves the model
 * guessing, while the page usually says what actually went wrong ("go back to the detail
 * page and download again") and that is what lets the next step correct itself. Script and
 * style blocks are dropped before the tags so their contents do not survive as text.
 */
function httpFailure(res: FetchResult): string {
  const status = `HTTP ${res.status ?? 'error'}`;
  const text = (res.body ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? status : `${status}: ${text.slice(0, ERROR_SNIPPET_CAP)}`;
}

/** One history step: a fixed prefix plus an optional observation body (already OBSERVATION_CAP-capped). */
interface HistoryStep {
  prefix: string;
  observation?: string;
}

/** Render history for the prompt: last observation full; older ones truncated with elision marker. */
function formatHistoryForPrompt(history: HistoryStep[]): string {
  return history
    .map((step, i) => {
      if (step.observation === undefined) return step.prefix;
      const isLatest = i === history.length - 1;
      const obs =
        isLatest || step.observation.length <= ELIDED_OBSERVATION_CAP
          ? step.observation
          : `${step.observation.slice(0, ELIDED_OBSERVATION_CAP)}…[elided]`;
      return `${step.prefix}${obs}`;
    })
    .join('\n');
}

/**
 * Whether `url` is on the same site as `baseUrl` (request's same-site guard) — same
 * scheme, and hostnames that are equal, or one a subdomain of the other, once a leading
 * `www.` is stripped from both. Not same-origin: a subtitle site legitimately serves
 * auth and downloads from sibling hosts (`auth.example.test`, `cdn.example.test` next to
 * `www.example.test`), so an exact-host comparison refused traffic the site itself sends
 * the agent to.
 *
 * The ancestor side of that relation stops one label short of the top: `acg.rip` and
 * `rip` are not the same site, and without the dot test a site on any two-label domain
 * would accept every host under its TLD. Ports are not compared — a site that moves its
 * API to `:8443` is still the same site — so this is a host relation, not an origin one.
 */
function isSameSite(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    if (a.protocol !== b.protocol) return false;
    const stripWww = (host: string): string => host.replace(/^www\./, '');
    const ah = stripWww(a.hostname);
    const bh = stripWww(b.hostname);
    if (ah === bh) return true;
    return (ah.endsWith(`.${bh}`) && bh.includes('.')) || (bh.endsWith(`.${ah}`) && ah.includes('.'));
  } catch {
    return false;
  }
}

/** A refused destination, phrased to complete `<action> refused: <url> ...`. */
const REFUSAL_REASON: Record<RefusedDestination, string> = {
  private: 'targets a private/loopback address',
  unparseable: 'is not a usable URL',
  scheme: 'is not an http(s) URL',
};

/** The refusals a human must see (and that count toward `REFUSAL_LIMIT`): a private/loopback
 * address, or a non-http(s) scheme steering the agent off the web — both the SSRF/local-read
 * shape. A merely malformed URL is a model slip and stays a plain transcript note. */
function isSecuritySignal(reason: RefusedDestination): boolean {
  return reason === 'private' || reason === 'scheme';
}

/** The loop hit the current tier's wall — the runner escalates one rung and retries. */
export class TierBlockedError extends Error {
  constructor(message = 'tier blocked') {
    super(message);
    this.name = 'TierBlockedError';
  }
}

/**
 * One site-search agent run at ONE tier: a step-budgeted LLM loop over search/open/request/
 * download. Warrden's code owns the budget, the fetch, and every termination condition; the
 * model only picks the next action (and may follow the site's learned/operator knowledge,
 * passed in already rendered as `knowledge`). The most recent observation is kept up to
 * OBSERVATION_CAP chars; older steps are elided at prompt-render time so the rolling
 * prompt stays bounded.
 * Every step (and its note) is reported via `onTranscript`.
 */
export async function runAgentLoop(input: {
  llm: StructuredGenerator;
  tier: FetchTier;
  site: { baseUrl: string; searchUrlTemplate?: string };
  profile: SiteProfileRow;
  /** The site's learned + operator knowledge, already rendered for the prompt (via
   * `knowledgeForPrompt`) and scanned for prompt injection by the caller. `''` when
   * there's nothing to inject, or when the scan tripped and the caller withheld it. */
  knowledge: string;
  /** Primary title; also `hints.title` when hints are provided. */
  query: string;
  hints?: SearchHints;
  destDir: string;
  maxSteps: number;
  onTranscript: (e: TranscriptEntry) => void;
  /** Files this loop's `llm.call` entries under the caller's per-site step. */
  trace?: { jobId: number; parentSeq?: number };
}): Promise<AgentOutcome> {
  const { llm, tier, site, profile, knowledge, destDir, maxSteps, onTranscript } = input;
  const query = input.hints?.title ?? input.query;
  const hintBlock = input.hints ? formatSearchHintsForPrompt(input.hints) : '';

  const patterns = [site.searchUrlTemplate, ...profile.search_url_patterns].filter((p): p is string => p !== undefined);
  const system = [
    `You are finding and downloading a subtitle pack (zip/tar archive or subtitle files) for "${query}" on ${site.baseUrl}.`,
    patterns.length > 0 ? `Known search URL patterns ({query} = URL-encoded search term): ${patterns.join(', ')}` : '',
    knowledge || '',
    hintBlock,
    'Choose one action per step:',
    '- search: build a search URL and open it (GET)',
    '- open: visit a result page (GET)',
    '- request: arbitrary GET/POST to a URL (set method; body/contentType/referer as needed, or empty string); use for API/protocol steps from the site notes — never for the archive file itself',
    '- download: fetch the archive file (terminal success; optional referer). Only download saves a file — never fetch the archive with request',
    '- give_up: stop this site',
    'Cookies persist automatically across steps within this run — you never need to manage them.',
    'Older observations in the transcript are elided; record key facts (candidate slugs/URLs) in your note so you can reuse them later.',
    'Only download links that look like complete season packs, batch archives, or full-movie packs — not single-episode files, unless nothing else exists.',
    'Preferred groups and languages are soft preferences: never give_up solely because the perfect group is missing.',
    `When every missing episode aired within the last ${FRESH_DAYS} days and the site shows nothing for them, give_up: subtitles for a fresh episode usually do not exist yet, and the next scheduled run will look again.`,
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  const history: HistoryStep[] = [];
  let lastSearchUrl: string | null = null;
  let refusals = 0;
  /** Consecutive unparseable replies; any step that produced an action resets it. */
  let malformed = 0;
  /**
   * Records a guarded destination as this step's observation AND as a transcript entry,
   * then reports whether the run has spent its refusal allowance. The transcript entry is
   * the point: without it a refusal is invisible as a refusal — the step reads as an
   * ordinary action against a URL that then failed for no stated reason, and a knowledge
   * file aimed at cloud metadata looks like a clumsy model. `attention` marks the variants
   * that are a security signal rather than a wrong guess, so the runner raises them into
   * the attention queue where a human sees them — and those are exactly the ones that
   * count toward REFUSAL_LIMIT, so the breaker only ever fires on something a human is
   * being shown.
   */
  const refuse = (line: string, level?: 'attention'): boolean => {
    history.push({ prefix: line });
    onTranscript({ ts: Date.now(), tier: tier.tier, action: 'refused', detail: line, ...(level !== undefined ? { level } : {}) });
    if (level !== 'attention') return false;
    refusals += 1;
    return refusals >= REFUSAL_LIMIT;
  };
  for (let step = 0; step < maxSteps; step++) {
    const prompt = [
      `Title: ${query}`,
      history.length > 0 ? `Steps so far:\n${formatHistoryForPrompt(history)}` : 'No steps yet — start by searching.',
      `Step ${step + 1} of ${maxSteps}. What is the next action?`,
    ].join('\n\n');

    let action: z.infer<typeof AgentActionSchema>;
    try {
      action = await llm.generate({
        callsite: CALLSITE,
        schema: AgentActionSchema,
        system,
        prompt,
        promptCache: true,
        trace: input.trace,
      });
    } catch (err) {
      // A reply that is not the object is a bad STEP, not a dead site: the tier answered,
      // the page loaded, the model just wrote the wrong thing. Telling it so and spending
      // one of its steps is far cheaper than failing the site into a cooldown and replaying
      // the whole ladder. Anything else — a dead route, a missing key — still throws.
      if (!isObjectParseFailure(err)) throw err;
      malformed += 1;
      history.push({ prefix: MALFORMED_NOTE });
      onTranscript({ ts: Date.now(), tier: tier.tier, action: 'malformed', detail: MALFORMED_NOTE });
      if (malformed >= MALFORMED_LIMIT) return { kind: 'malformed-repeatedly', failures: malformed, steps: step + 1 };
      continue;
    }
    malformed = 0;
    onTranscript({ ts: Date.now(), tier: tier.tier, action: action.action, detail: `${action.note} (${action.url})` });

    if (action.action === 'give_up') {
      return { kind: 'gave-up', steps: step + 1, reason: action.reason.trim() || NO_REASON };
    }

    const referer = action.referer !== '' ? action.referer : undefined;

    // Every fetch verb is checked against private/loopback destinations before anything
    // else runs — a clean scan of stored knowledge is not evidence it's safe to act on;
    // this guard (plus the same-site guard below, plus the bounded action set) is what
    // actually bounds the damage a tampered or malicious page can do. The same guard runs
    // again inside the tiers on every redirect hop, which is the only place a destination
    // the model never named can appear.
    const refusal = refusedDestination(action.url);
    if (refusal !== null) {
      const line = `${action.action} refused: ${capUrl(action.url)} ${REFUSAL_REASON[refusal]}`;
      // A malformed URL is a model slip; a private/loopback address or an off-web scheme is
      // the SSRF/local-read shape and has to reach a human even when the run recovers next step.
      if (refuse(line, isSecuritySignal(refusal) ? 'attention' : undefined)) {
        return { kind: 'refused-repeatedly', refusals, steps: step + 1 };
      }
      continue;
    }

    /** A redirect hop the tier refused mid-fetch: the destination guard runs again on
     * every hop inside the fetch, so a public URL that 302s onto a guarded address never
     * connects. It comes back as a failed result rather than a throw, and is recorded and
     * counted exactly like a refusal the loop caught up front — including a `Location`
     * header that is not a URL, which fetches nothing either way but would otherwise read
     * as an ordinary HTTP failure. */
    const refuseHop = (res: FetchResult): 'stop' | 'continue' | null => {
      if (res.refusedUrl === undefined) return null;
      const reason = res.refusedReason ?? 'private';
      const line = `${action.action} refused: ${capUrl(action.url)} redirected to ${capUrl(res.refusedUrl)}, which ${REFUSAL_REASON[reason]}`;
      return refuse(line, isSecuritySignal(reason) ? 'attention' : undefined) ? 'stop' : 'continue';
    };

    if (action.action === 'download') {
      // The timestamp only disambiguates the transient file: destDir is the run's own scratch
      // and can legitimately receive the same pack name twice in one run. Cache identity is
      // derived from the URL downstream, not from this name.
      const destPath = join(destDir, `${siteKey(site.baseUrl)}-${Date.now()}-${safeUrlTailName(action.url)}`);
      const res = await tier.fetch(action.url, {
        destPath,
        ...(referer !== undefined ? { referer } : {}),
      });
      const hop = refuseHop(res);
      if (hop === 'stop') return { kind: 'refused-repeatedly', refusals, steps: step + 1 };
      if (hop === 'continue') continue;
      if (res.blocked) throw new TierBlockedError(`download blocked at ${action.url}`);
      if (!res.ok || res.filePath === undefined) {
        history.push({ prefix: `download ${action.url} -> FAILED` });
        continue;
      }
      return { kind: 'downloaded', steps: step + 1, filePath: res.filePath, url: action.url, searchUrl: lastSearchUrl };
    }

    if (action.action === 'request') {
      // Same-site guard: request is a POST-capable primitive; third-party page text in
      // the prompt must not aim it at a foreign host. open/search/download stay open —
      // they legitimately reach mirrors and CDNs and hard-guarding them would break real
      // sites; only the private/loopback check above applies to those verbs.
      if (!isSameSite(action.url, site.baseUrl)) {
        let siteHost: string;
        try {
          siteHost = new URL(site.baseUrl).host;
        } catch {
          siteHost = site.baseUrl;
        }
        const line = `request refused: ${capUrl(action.url)} is not on ${siteHost}`;
        if (refuse(line)) return { kind: 'refused-repeatedly', refusals, steps: step + 1 };
        continue;
      }

      const method = action.method;
      // Body/contentType only on POST — GET never carries a body on any tier.
      const res = await tier.fetch(action.url, {
        method,
        ...(method === 'POST' && action.body !== '' ? { body: action.body } : {}),
        ...(method === 'POST' && action.contentType !== '' ? { contentType: action.contentType } : {}),
        ...(referer !== undefined ? { referer } : {}),
      });
      const hop = refuseHop(res);
      if (hop === 'stop') return { kind: 'refused-repeatedly', refusals, steps: step + 1 };
      if (hop === 'continue') continue;
      if (res.blocked) throw new TierBlockedError(`request blocked at ${action.url}`);
      if (res.ok) {
        history.push({
          prefix: `request ${method} ${action.url} -> OK: `,
          observation: (res.body ?? '').slice(0, OBSERVATION_CAP),
        });
      } else {
        history.push({ prefix: `request ${method} ${action.url} -> ${httpFailure(res)}` });
      }
      continue;
    }

    const res = await tier.fetch(action.url);
    const hop = refuseHop(res);
    if (hop === 'stop') return { kind: 'refused-repeatedly', refusals, steps: step + 1 };
    if (hop === 'continue') continue;
    if (res.blocked) throw new TierBlockedError(`${action.action} blocked at ${action.url}`);
    if (res.ok && action.action === 'search') lastSearchUrl = action.url;
    if (res.ok) {
      history.push({
        prefix: `${action.action} ${action.url} -> OK: `,
        observation: (res.body ?? '').slice(0, OBSERVATION_CAP),
      });
    } else {
      history.push({ prefix: `${action.action} ${action.url} -> ${httpFailure(res)}` });
    }
  }
  return { kind: 'exhausted', steps: maxSteps };
}
