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

/** Whether `url` is same scheme+host as `baseUrl` (request same-origin guard). */
function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
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
 * model only picks the next action (and may follow operator-authored protocol notes in the
 * site profile). The most recent observation is kept up to OBSERVATION_CAP chars; older
 * steps are elided at prompt-render time so the rolling prompt stays bounded.
 * Every step (and its note) is reported via `onTranscript`.
 */
export async function runAgentLoop(input: {
  llm: StructuredGenerator;
  tier: FetchTier;
  site: { baseUrl: string; searchUrlTemplate?: string };
  profile: SiteProfileRow;
  /** Primary title; also `hints.title` when hints are provided. */
  query: string;
  hints?: SearchHints;
  destDir: string;
  maxSteps: number;
  onTranscript: (e: TranscriptEntry) => void;
}): Promise<AgentOutcome> {
  const { llm, tier, site, profile, destDir, maxSteps, onTranscript } = input;
  const query = input.hints?.title ?? input.query;
  const hintBlock = input.hints ? formatSearchHintsForPrompt(input.hints) : '';

  const patterns = [site.searchUrlTemplate, ...profile.search_url_patterns].filter((p): p is string => p !== undefined);
  const system = [
    `You are finding and downloading a subtitle pack (zip/tar archive or subtitle files) for "${query}" on ${site.baseUrl}.`,
    patterns.length > 0 ? `Known search URL patterns ({query} = URL-encoded search term): ${patterns.join(', ')}` : '',
    profile.notes
      ? `Site protocol notes (follow step by step when they describe a full walkthrough — endpoints, request shapes, captcha behavior): ${profile.notes}`
      : '',
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
      // Same-origin guard: request is a POST-capable primitive; third-party page text in
      // the prompt must not aim it at LAN/foreign hosts. open/search/download stay open.
      if (!isSameOrigin(action.url, site.baseUrl)) {
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
