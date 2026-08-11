import { z } from 'zod';
import { isIP } from 'node:net';
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
  | { kind: 'gave-up' }
  /** REFUSAL_LIMIT guarded destinations in one run — the runner stops the site rather
   * than paying for the same refusals again on every remaining tier. */
  | { kind: 'refused-repeatedly'; refusals: number };

/**
 * How many refused destinations end a run. A refusal costs an LLM call and returns no
 * page, so a knowledge file that keeps naming a guarded address would otherwise burn the
 * whole step budget once per tier — four full budgets of paid calls before the site gives
 * up. Three leaves room for a model that misreads a page once and corrects itself.
 */
const REFUSAL_LIMIT = 3;

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

/** The four bytes of a dotted-quad IPv4 address, which `isIP` has already validated. */
function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number);
}

/**
 * An IPv6 literal as its 16 bytes, or `null` if it can't be read. Handles the one `::`
 * run and a trailing dotted quad (`::ffff:127.0.0.1`), which is all the textual forms
 * are; callers reach this only after `isIP` has said the string is a valid IPv6 address.
 */
function ipv6Bytes(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (i === groups.length - 1 && group.includes('.')) {
        out.push(...ipv4Bytes(group));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 literal carries in its low four bytes, when the high bytes are
 * one of the prefixes that mean "this is really an IPv4 address": `::ffff:0:0/96`
 * (IPv4-mapped, which is what `http://[::ffff:127.0.0.1]/` becomes once the URL parser
 * normalizes it), `::/96` (IPv4-compatible, and with it `::1` and `::` themselves), and
 * `::ffff:0:0:0/96` (IPv4-translated). Every one of those spellings reaches the same
 * machine as the bare IPv4 address, so all of them have to be judged as that address
 * rather than as an unrecognized IPv6 host.
 */
function embeddedIpv4(bytes: number[]): number[] | null {
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);
  const mappedOrCompatible = zeros(0, 10) && (zeros(10, 12) || (bytes[10] === 0xff && bytes[11] === 0xff));
  const translated = zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12);
  return mappedOrCompatible || translated ? bytes.slice(12) : null;
}

function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b] = bytes as [number, number];
  if (a === 0) return true; // "this network" 0/8 — 0.0.0.0 reaches loopback on Linux
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. 169.254.169.254)
  return false;
}

/**
 * Whether `hostname` (a URL's `.hostname`, brackets included for IPv6) names a loopback,
 * private, or link-local destination. Closes the server-side-request-forgery shape — page
 * text the agent reads can otherwise name any URL, and without this guard a fetch verb
 * would happily reach a LAN service or a cloud metadata endpoint.
 *
 * The host is normalized before any range test, because the ranges are the easy half and
 * the spellings are the hard one. A trailing dot comes off (`localhost.` resolves exactly
 * like `localhost`), an IPv6 literal is read as its 16 bytes, and a literal that carries
 * an IPv4 address in its low bytes is judged as that IPv4 address. What is then refused:
 * `0.0.0.0/8`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (which
 * includes the cloud metadata address `169.254.169.254`), the names `localhost` and
 * `*.localhost`, `::1` and `::`, unique-local `fc00::/7`, and link-local `fe80::/10`.
 *
 * What it does NOT catch, and cannot: a hostname that merely *resolves* to one of those
 * addresses. An attacker who controls a DNS record can point `pack.example.test` at
 * 127.0.0.1, or answer twice and rebind between this check and the connection. Catching
 * that means checking the address the socket actually connected to, which belongs in the
 * fetch tiers and not here. This guard covers literals only, and that is the whole of the
 * claim.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(ipv4Bytes(host));
  if (version === 6) {
    const bytes = ipv6Bytes(host);
    if (bytes === null) return true; // a literal this can't read is refused, not allowed
    const embedded = embeddedIpv4(bytes);
    if (embedded !== null) return isPrivateIpv4(embedded);
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // unique-local fc00::/7
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost');
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
  let refusals = 0;
  /** Records a guarded destination as this step's observation and reports whether the run
   * has spent its refusal allowance. */
  const refuse = (line: string): boolean => {
    history.push({ prefix: line });
    refusals += 1;
    return refusals >= REFUSAL_LIMIT;
  };
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
      if (refuse(privateRefusal)) return { kind: 'refused-repeatedly', refusals };
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
        const line = `request refused: ${action.url} is not on ${siteHost}`;
        if (refuse(line)) return { kind: 'refused-repeatedly', refusals };
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
