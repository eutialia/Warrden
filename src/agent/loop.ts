import { z } from 'zod';
import { join } from 'node:path';
import type { StructuredGenerator } from '../llm/generator.js';
import type { FetchTier } from './tiers.js';
import { siteKey } from '../config/siteLabel.js';
import type { SiteProfileRow } from '../db/siteProfiles.js';
import type { TranscriptEntry } from '../db/subtitleRuns.js';
import { formatSearchHintsForPrompt, type SearchHints } from '../pipelines/subtitle/queries.js';

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
});
type AgentOutcome =
  | { kind: 'downloaded'; filePath: string; url: string; searchUrl: string | null }
  | { kind: 'exhausted' }
  | { kind: 'gave-up' };

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
 * scheme, and hosts that are equal, or one a subdomain of the other, once a leading
 * `www.` is stripped from both. Not same-origin: a subtitle site legitimately serves
 * auth and downloads from sibling hosts (`auth.example.test`, `cdn.example.test` next to
 * `www.example.test`), so an exact-host comparison refused traffic the site itself sends
 * the agent to.
 */
function isSameSite(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    if (a.protocol !== b.protocol) return false;
    const stripWww = (host: string): string => host.replace(/^www\./, '');
    const ah = stripWww(a.host);
    const bh = stripWww(b.host);
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  } catch {
    return false;
  }
}

/**
 * Whether `hostname` (a URL's `.hostname`, brackets included for IPv6) names a loopback,
 * private, or link-local destination: `127.0.0.0/8` and `localhost`, `10/8`, `172.16/12`,
 * `192.168/16`, `169.254/16` (which includes the cloud metadata address
 * `169.254.169.254`), `::1`, and unique-local IPv6 `fc00::/7`. Closes the
 * server-side-request-forgery shape — page text the agent reads can otherwise name any
 * URL, and without this guard a fetch verb would happily reach a LAN service or a cloud
 * metadata endpoint.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
    if (a === 192 && b === 168) return true; // private 192.168/16
    if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. 169.254.169.254)
    return false;
  }

  if (bare === '::1') return true; // loopback
  if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/.test(bare)) return true; // unique-local fc00::/7
  return false;
}

/** A refusal line for `action`/`url` if it targets a private or loopback destination,
 * else `null`. Applies to every fetch verb (search/open/request/download) — unlike the
 * same-site guard, this one is not verb-specific: nothing the agent does should be able
 * to reach a LAN service or cloud metadata endpoint, whatever site sent it there. */
function privateDestinationRefusal(action: string, url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return isPrivateOrLoopbackHost(hostname) ? `${action} refused: ${url} targets a private/loopback address` : null;
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
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  const history: HistoryStep[] = [];
  let lastSearchUrl: string | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const prompt = [
      `Title: ${query}`,
      history.length > 0 ? `Steps so far:\n${formatHistoryForPrompt(history)}` : 'No steps yet — start by searching.',
      `Step ${step + 1} of ${maxSteps}. What is the next action?`,
    ].join('\n\n');

    const action = await llm.generate({
      callsite: CALLSITE,
      schema: AgentActionSchema,
      system,
      prompt,
      promptCache: true,
    });
    onTranscript({ ts: Date.now(), tier: tier.tier, action: action.action, detail: `${action.note} (${action.url})` });

    if (action.action === 'give_up') return { kind: 'gave-up' };

    const referer = action.referer !== '' ? action.referer : undefined;

    // Every fetch verb is checked against private/loopback destinations before anything
    // else runs — a clean scan of stored knowledge is not evidence it's safe to act on;
    // this guard (plus the same-site guard below, plus the bounded action set) is what
    // actually bounds the damage a tampered or malicious page can do.
    const privateRefusal = privateDestinationRefusal(action.action, action.url);
    if (privateRefusal) {
      history.push({ prefix: privateRefusal });
      continue;
    }

    if (action.action === 'download') {
      // Sanitize the URL tail so a model-chosen path segment can't escape destDir via
      // `..` or separators (join('/data/dl', 'x-1-../../etc/passwd') would otherwise
      // resolve outside the download dir).
      const rawName = action.url.split('/').pop() || 'download';
      const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'download';
      const destPath = join(destDir, `${siteKey(site.baseUrl)}-${Date.now()}-${safeName}`);
      const res = await tier.fetch(action.url, {
        destPath,
        ...(referer !== undefined ? { referer } : {}),
      });
      if (res.blocked) throw new TierBlockedError(`download blocked at ${action.url}`);
      if (!res.ok || res.filePath === undefined) {
        history.push({ prefix: `download ${action.url} -> FAILED` });
        continue;
      }
      return { kind: 'downloaded', filePath: res.filePath, url: action.url, searchUrl: lastSearchUrl };
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
        history.push({ prefix: `request refused: ${action.url} is not on ${siteHost}` });
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
      if (res.blocked) throw new TierBlockedError(`request blocked at ${action.url}`);
      if (res.ok) {
        history.push({
          prefix: `request ${method} ${action.url} -> OK: `,
          observation: (res.body ?? '').slice(0, OBSERVATION_CAP),
        });
      } else {
        history.push({ prefix: `request ${method} ${action.url} -> HTTP ${res.status ?? 'error'}` });
      }
      continue;
    }

    const res = await tier.fetch(action.url);
    if (res.blocked) throw new TierBlockedError(`${action.action} blocked at ${action.url}`);
    if (res.ok && action.action === 'search') lastSearchUrl = action.url;
    if (res.ok) {
      history.push({
        prefix: `${action.action} ${action.url} -> OK: `,
        observation: (res.body ?? '').slice(0, OBSERVATION_CAP),
      });
    } else {
      history.push({ prefix: `${action.action} ${action.url} -> HTTP ${res.status ?? 'error'}` });
    }
  }
  return { kind: 'exhausted' };
}
