import { z } from 'zod';
import { join } from 'node:path';
import type { StructuredGenerator } from '../llm/generator.js';
import type { FetchTier } from './tiers.js';
import type { SiteProfileRow } from '../db/siteProfiles.js';
import type { TranscriptEntry } from '../db/subtitleRuns.js';
import { formatSearchHintsForPrompt, type SearchHints } from '../pipelines/subtitle/queries.js';

const CALLSITE = 'site-search';
const OBSERVATION_CAP = 4000;

/** Flat root object — never a union — per the Anthropic/OpenAI strict-mode constraint
 * documented on matchLlm.ts's schema. `url` is '' for give_up (nullable would drop strict
 * required-ness the same way). */
const AgentActionSchema = z.object({
  action: z.enum(['search', 'open', 'download', 'give_up']).describe('what to do next'),
  url: z.string().describe('the absolute URL to act on (empty string for give_up)'),
  note: z.string().describe('one short sentence explaining this step for the transcript'),
});
type AgentOutcome =
  | { kind: 'downloaded'; filePath: string; url: string; searchUrl: string | null }
  | { kind: 'exhausted' }
  | { kind: 'gave-up' };

/** The loop hit the current tier's wall — the runner escalates one rung and retries. */
export class TierBlockedError extends Error {
  constructor(message = 'tier blocked') {
    super(message);
    this.name = 'TierBlockedError';
  }
}

/**
 * One site-search agent run at ONE tier: a step-budgeted LLM loop over exactly three
 * actions (search/open/download). Warrden's code owns the budget, the fetch, and every
 * termination condition; the model only picks the next URL. Observations are the first
 * OBSERVATION_CAP chars of fetched HTML — enough for link extraction, small enough to keep
 * the rolling prompt bounded. Every step (and its note) is reported via `onTranscript`.
 */
export async function runAgentLoop(input: {
  llm: StructuredGenerator;
  tier: FetchTier;
  site: { name: string; baseUrl: string; searchUrlTemplate?: string };
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
    profile.notes ? `Known site quirks: ${profile.notes}` : '',
    hintBlock,
    'Choose one action per step: search (build a search URL), open (visit a result page), download (fetch the archive file), or give_up.',
    'Only download links that look like complete season packs, batch archives, or full-movie packs — not single-episode files, unless nothing else exists.',
    'Preferred groups and languages are soft preferences: never give_up solely because the perfect group is missing.',
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ].filter(Boolean).join(' ');

  const history: string[] = [];
  let lastSearchUrl: string | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const prompt = [
      `Title: ${query}`,
      history.length > 0 ? `Steps so far:\n${history.join('\n')}` : 'No steps yet — start by searching.',
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

    if (action.action === 'download') {
      // Sanitize the URL tail so a model-chosen path segment can't escape destDir via
      // `..` or separators (join('/data/dl', 'x-1-../../etc/passwd') would otherwise
      // resolve outside the download dir).
      const rawName = action.url.split('/').pop() || 'download';
      const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'download';
      const destPath = join(destDir, `${site.name}-${Date.now()}-${safeName}`);
      const res = await tier.fetch(action.url, { destPath });
      if (res.blocked) throw new TierBlockedError(`download blocked at ${action.url}`);
      if (!res.ok || res.filePath === undefined) {
        history.push(`download ${action.url} -> FAILED`);
        continue;
      }
      return { kind: 'downloaded', filePath: res.filePath, url: action.url, searchUrl: lastSearchUrl };
    }

    const res = await tier.fetch(action.url);
    if (res.blocked) throw new TierBlockedError(`${action.action} blocked at ${action.url}`);
    if (res.ok && action.action === 'search') lastSearchUrl = action.url;
    history.push(
      res.ok
        ? `${action.action} ${action.url} -> OK: ${(res.body ?? '').slice(0, OBSERVATION_CAP)}`
        : `${action.action} ${action.url} -> HTTP ${res.status ?? 'error'}`,
    );
  }
  return { kind: 'exhausted' };
}
