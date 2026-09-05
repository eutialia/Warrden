import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { isObjectParseFailure, type StructuredGenerator } from '../llm/generator.js';
import { refusedDestination, type RefusedDestination } from './destinationGuard.js';
import type { FetchResult, FetchTier } from './tiers.js';
import { siteKey } from '../config/siteLabel.js';
import { safeUrlTailName } from '../fs/paths.js';
import type { SiteProfileRow } from '../db/siteProfiles.js';
import type { TranscriptEntry } from './transcript.js';
import { formatSearchHintsForPrompt, FRESH_DAYS, type SearchHints } from '../pipelines/subtitle/queries.js';
import type { StopReason } from './stop.js';

/** The LLM call-site every step of this loop is billed and traced under. */
export const SEARCH_CALLSITE = 'site-search';
/** Cap on the most recent step's observation stored in history (and shown full in the prompt). */
const OBSERVATION_CAP = 16_000;
/** Older steps' observations are truncated to this at render time so the rolling prompt stays bounded. */
const ELIDED_OBSERVATION_CAP = 1000;

/**
 * Flat root object — never a union — per the Anthropic/OpenAI strict-mode constraint
 * documented on matchLlm.ts's schema. Every field is REQUIRED: dropping one from
 * `required` (via `.optional()` / `.default()`) is rejected by OpenAI strict mode.
 * Sentinels: `url` is '' for give_up; `method` is always GET|POST (GET unless the step
 * needs POST); `body`/`contentType`/`referer` are '' when absent; `because` is '' on every
 * action but give_up. Loop code treats '' as none. `because` carries the empty option for
 * the same reason every other field does: a model that has learned '' means "not
 * applicable" writes it here too, and an enum without it turned correct replies into
 * malformed ones until the breaker ended the run.
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
  because: z
    .enum(['', 'not-found', 'blocked', 'unsure'])
    .describe('empty unless action is give_up; then one of not-found / blocked / unsure'),
});
/**
 * What one attempt produced: why it stopped, how many LLM steps it spent, and the file when
 * it got one. `steps` is what separates a "nothing exists yet" give-up after two steps from a
 * run that spent its whole budget; `exhausted` always spent `maxSteps`.
 */
export interface AgentRun {
  stop: StopReason;
  steps: number;
  download?: { filePath: string; url: string; searchUrl: string | null };
  /** Distinct search result pages this attempt actually got back — the evidence behind a
   * `not-found` give-up. Two different listings mean the agent looked, twice, and can be
   * believed; one (or none, or the same page twice) does not. */
  listings: number;
}

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
  const text = pageText(res.body ?? '');
  return text === '' ? status : `${status}: ${text.slice(0, ERROR_SNIPPET_CAP)}`;
}

/** Script and style blocks gone, contents and all. Every reader of a page runs on this
 * first: what a page says inside a `<script>` is code the site's own browser would run,
 * never markup the page served, and reading it as markup is how a form written as a
 * JavaScript string got its `name=value` pairs into the prompt as if they were real. */
function withoutCode(body: string): string {
  return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * A page as the model should read it: tags stripped, whitespace collapsed. Feed it a body
 * that has already been through `withoutCode`, or a raw one — it runs the strip itself so
 * no caller can forget it.
 *
 * Three things survive the tag strip, because without them the text is unusable rather than
 * merely smaller: an anchor's `href` (the run navigates by the links it reads), a form's
 * `action`/`method` (what a POST search has to be aimed at), and hidden input `name=value`
 * pairs (the per-session tokens a form is rejected without). Everything else — classes,
 * inline styles, tracking attributes — is the bulk that was crowding the real page out of a
 * bounded prompt.
 */
function pageText(body: string): string {
  return withoutCode(body)
    .replace(/<a\b[^>]*>/gi, (tag) => {
      const href = attr(tag, 'href');
      return href === undefined || href === '' ? ' ' : ` [${href}] `;
    })
    .replace(/<form\b[^>]*>/gi, (tag) => ` [form ${attr(tag, 'action') ?? ''} ${(attr(tag, 'method') ?? 'get').toLowerCase()}] `)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One attribute's value out of a single tag, quoted or not. The name has to START an
 * attribute, not merely end one: `-` is not a word character, so a `\b` boundary let
 * `data-name=` answer for `name` and `data-action=` for `action`, and which one won was
 * decided by whichever the page wrote first. */
function attr(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*["']?([^"'\\s>]*)`, 'i').exec(tag)?.[1];
}

/** Longest a single hidden field's value rides into the prompt. Session tokens are short;
 * anything longer is a site putting a payload where a token belongs. */
const HIDDEN_VALUE_CAP = 200;
/** How many hidden fields one page contributes. A real form has a handful. */
const MAX_HIDDEN_FIELDS = 20;

/**
 * The hidden `name=value` pairs of a page's forms, as one `[form: a=1, b=2]` line — or `''`
 * when the page has none. These are the per-session tokens (`formhash`, `searchsubmit`, CSRF
 * nonces) a POST search is rejected without, and they live only in attributes, so a plain tag
 * strip is exactly what loses them. Expects a body already through `withoutCode`: an input
 * a script only writes as a string is not a field the page served.
 */
function hiddenFields(body: string): string {
  const fields = new Map<string, string>();
  for (const tag of body.match(/<input\b[^>]*>/gi) ?? []) {
    if (attr(tag, 'type')?.toLowerCase() !== 'hidden') continue;
    const name = attr(tag, 'name');
    if (name === undefined || name === '' || fields.has(name)) continue;
    fields.set(name, (attr(tag, 'value') ?? '').slice(0, HIDDEN_VALUE_CAP));
  }
  if (fields.size === 0) return '';
  const shown = [...fields].slice(0, MAX_HIDDEN_FIELDS).map(([name, value]) => `${name}=${value}`);
  return `[form: ${shown.join(', ')}]`;
}

/**
 * A successful fetch as one observation: the form tokens first, then the page text, capped.
 * The tokens lead because the cap cuts from the end, and a token the cap swallowed is a POST
 * the next step cannot make.
 */
function observation(body: string): string {
  const clean = withoutCode(body);
  const fields = hiddenFields(clean);
  const text = pageText(clean);
  return `${fields === '' ? '' : `${fields} `}${text}`.slice(0, OBSERVATION_CAP);
}

/** Longest a token can be and still count toward a listing's identity. Session ids, cache
 * keys and nonces are longer than any word a result row is made of. */
const FINGERPRINT_TOKEN_CAP = 24;

/**
 * What makes one search result page distinct from another, for the evidence count behind a
 * `not-found` give-up. Not the bytes: an empty result shell that carries "generated in
 * 0.031s" and a request id is a different page every time it is fetched, and hashing it
 * raw let two looks at the same nothing pass for two looks. Digits collapse and long
 * tokens drop, so what is left is the words the page actually listed.
 */
function listingFingerprint(body: string): string {
  const normalized = pageText(body)
    .split(' ')
    // Length is judged before digits collapse, or a 32-hex request id shrinks under the cap
    // and survives as the one token that makes every fetch look like a new page.
    .filter((token) => token.length <= FINGERPRINT_TOKEN_CAP)
    .join(' ')
    .replace(/\d+/g, '#');
  return createHash('sha256').update(normalized).digest('hex');
}

/** One history step: what the model did, why it said it was doing it, how the fetch ended,
 * and the page it got back (already OBSERVATION_CAP-capped). */
interface HistoryStep {
  /** `<verb> <url>`, or a refusal/correction line that has no verb of its own. */
  prefix: string;
  /** The model's own one-line reason for this step. It is the only part of a step that
   * survives elision intact, which is what lets step twenty reuse a slug step three found. */
  note?: string;
  /** How the fetch ended: `-> OK: `, `-> FAILED`, `-> HTTP 403: ...`. */
  result?: string;
  observation?: string;
}

/** Render history for the prompt: last observation full; older ones truncated with elision marker. */
function formatHistoryForPrompt(history: HistoryStep[]): string {
  return history
    .map((step, i) => {
      const head = `${step.prefix}${step.note !== undefined && step.note !== '' ? ` — ${step.note}` : ''}${step.result ?? ''}`;
      if (step.observation === undefined) return head;
      const isLatest = i === history.length - 1;
      const obs =
        isLatest || step.observation.length <= ELIDED_OBSERVATION_CAP
          ? step.observation
          : `${step.observation.slice(0, ELIDED_OBSERVATION_CAP)}…[elided]`;
      return `${head}${obs}`;
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

/** The site's host as a refusal line names it, falling back to the configured string when
 * the base URL is not parseable — the refusal still has to read as a sentence. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
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
  hints: SearchHints;
  destDir: string;
  maxSteps: number;
  onTranscript: (e: TranscriptEntry) => void;
  /** Files this loop's `llm.call` entries under the caller's per-site step. */
  trace?: { jobId: number; parentSeq?: number };
}): Promise<AgentRun> {
  const { llm, tier, site, profile, knowledge, hints, destDir, maxSteps, onTranscript } = input;
  const query = hints.title;
  const hintBlock = formatSearchHintsForPrompt(hints);

  const patterns = [site.searchUrlTemplate, ...profile.search_url_patterns].filter((p): p is string => p !== undefined);
  const system = [
    `You are finding and downloading a subtitle pack (zip/tar archive or subtitle files) for "${query}" on ${site.baseUrl}.`,
    patterns.length > 0 ? `Known search URL patterns ({query} = URL-encoded search term): ${patterns.join(', ')}` : '',
    knowledge || '',
    hintBlock,
    'Choose one action per step:',
    '- search: build a search URL and fetch it — GET, or POST with method/body/contentType when the site searches through a form',
    '- open: visit a result page (GET)',
    '- request: arbitrary GET/POST to a URL (set method; body/contentType/referer as needed, or empty string); use for API/protocol steps from the site notes — never for the archive file itself',
    '- download: fetch the archive file (terminal success; optional referer). Only download saves a file — never fetch the archive with request',
    '- give_up: stop this site, with `because`:',
    '  - not-found: you searched and the site has nothing for these episodes',
    '  - blocked: you could not get through — a wall, a captcha, a login, or pages that come back empty or garbled',
    '  - unsure: you could not tell',
    'Cookies persist automatically across steps within this run — you never need to manage them.',
    'Pages arrive stripped to text: a link reads as [url] before its text, a form as [form action method], and a form\'s hidden fields as [form: name=value, ...]. Reuse those values verbatim when a step needs them.',
    'Older observations in the transcript are elided; record key facts (candidate slugs/URLs) in your note so you can reuse them later.',
    'Only download links that look like complete season packs, batch archives, or full-movie packs — not single-episode files, unless nothing else exists.',
    'Preferred groups and languages are soft preferences: never give_up solely because the perfect group is missing.',
    `When every missing episode aired within the last ${FRESH_DAYS} days and the site shows nothing for them, give_up with because=not-found: subtitles for a fresh episode usually do not exist yet, and the next scheduled run will look again.`,
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  const history: HistoryStep[] = [];
  /** One entry per DISTINCT search result page this attempt saw. A model that searches the
   * same URL twice, or pages that come back identical, learns nothing new — and the point of
   * the count is whether a `not-found` give-up has looking behind it. */
  const listings = new Set<string>();
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
        callsite: SEARCH_CALLSITE,
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
      if (malformed >= MALFORMED_LIMIT) return { stop: { kind: 'malformed', failures: malformed }, steps: step + 1, listings: listings.size };
      continue;
    }
    malformed = 0;
    onTranscript({ ts: Date.now(), tier: tier.tier, action: action.action, detail: `${action.note} (${action.url})` });

    if (action.action === 'give_up') {
      return {
        // A give-up that left `because` empty said it could not tell — which is what
        // `unsure` is for, and is truer than picking one of the other two for it.
        stop: { kind: 'gave-up', because: action.because === '' ? 'unsure' : action.because, reason: action.reason.trim() || NO_REASON },
        steps: step + 1,
        listings: listings.size,
      };
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
        return { stop: { kind: 'refused', refusals }, steps: step + 1, listings: listings.size };
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
      if (res.refused === undefined) return null;
      const { url, reason } = res.refused;
      const line = `${action.action} refused: ${capUrl(action.url)} redirected to ${capUrl(url)}, which ${REFUSAL_REASON[reason]}`;
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
      if (hop === 'stop') return { stop: { kind: 'refused', refusals }, steps: step + 1, listings: listings.size };
      if (hop === 'continue') continue;
      if (res.blocked) throw new TierBlockedError(`download blocked at ${action.url}`);
      if (!res.ok || res.filePath === undefined) {
        history.push({ prefix: `download ${action.url}`, note: action.note, result: ' -> FAILED' });
        continue;
      }
      return {
        stop: { kind: 'done' },
        steps: step + 1,
        listings: listings.size,
        download: { filePath: res.filePath, url: action.url, searchUrl: lastSearchUrl },
      };
    }

    // One fetch path for the three browsing verbs, because there is only one guard worth
    // having and it must not be reachable around. A search the site serves over POST is
    // still a search — the verb says what the step is for, not which method the site wants
    // — and `request` is the arbitrary-protocol verb on either method. `open` stays GET.
    const post = action.method === 'POST' && (action.action === 'request' || action.action === 'search');
    const explicitMethod = action.action === 'request' || post;

    // Same-site guard. A POST is what third-party page text must not be able to aim at a
    // foreign host, whichever verb carries it, and `request` is guarded on both methods
    // since it exists to speak a site's own protocol. Plain GET open/search/download stay
    // open — they legitimately reach mirrors and CDNs, and hard-guarding them would break
    // real sites; only the private/loopback check above applies to those.
    if (explicitMethod && !isSameSite(action.url, site.baseUrl)) {
      const line = `${action.action} refused: ${capUrl(action.url)} is not on ${hostOf(site.baseUrl)}`;
      if (refuse(line)) return { stop: { kind: 'refused', refusals }, steps: step + 1, listings: listings.size };
      continue;
    }

    // Body/contentType only on POST — GET never carries a body on any tier.
    const res = await tier.fetch(action.url, {
      ...(explicitMethod ? { method: post ? ('POST' as const) : ('GET' as const) } : {}),
      ...(post && action.body !== '' ? { body: action.body } : {}),
      ...(post && action.contentType !== '' ? { contentType: action.contentType } : {}),
      ...(referer !== undefined ? { referer } : {}),
    });
    const hop = refuseHop(res);
    if (hop === 'stop') return { stop: { kind: 'refused', refusals }, steps: step + 1, listings: listings.size };
    if (hop === 'continue') continue;
    if (res.blocked) throw new TierBlockedError(`${action.action} blocked at ${action.url}`);
    if (res.ok && action.action === 'search') {
      lastSearchUrl = action.url;
      listings.add(listingFingerprint(res.body ?? ''));
    }
    const verb = action.action === 'request' ? `request ${action.method}` : post ? 'search POST' : action.action;
    history.push({
      prefix: `${verb} ${action.url}`,
      note: action.note,
      ...(res.ok ? { result: ' -> OK: ', observation: observation(res.body ?? '') } : { result: ` -> ${httpFailure(res)}` }),
    });
  }
  return { stop: { kind: 'exhausted' }, steps: maxSteps, listings: listings.size };
}
