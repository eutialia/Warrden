import { z } from 'zod';
import type { StructuredGenerator } from '../../llm/generator.js';
import type { SearchHints } from '../../pipelines/subtitle/queries.js';
import type { SubtitleCandidate } from './types.js';

const CALLSITE = 'site-search';

/** Flat object root — same strict-mode constraint as every other Warrden LLM schema. */
const PackPickSchema = z.object({
  decision: z.enum(['pick', 'none']).describe('pick one numbered candidate or none viable'),
  candidate: z.number().int().nullable().describe('1-based index from the list; null when decision is none'),
  reasoning: z.string(),
});

function renderCandidate(i: number, c: SubtitleCandidate): string {
  const langs = c.langs.length > 0 ? c.langs.join(',') : '?';
  const dl = c.downloads != null ? ` dl=${c.downloads}` : '';
  const fmt = c.format ? ` [${c.format}]` : '';
  const by = c.uploader ? ` by ${c.uploader}` : '';
  return `#${i + 1} [${langs}]${fmt}${dl}${by} ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ''}`;
}

/**
 * Parse-then-pick: rank a structured candidate list the same way acquire ranks releases.
 * Soft preferences from `hints` (languages, preferred groups) live in the system prompt;
 * they never force an empty pick when only imperfect candidates exist.
 */
export async function pickSubtitlePack(input: {
  llm: StructuredGenerator;
  candidates: SubtitleCandidate[];
  hints: SearchHints;
}): Promise<{ candidate: SubtitleCandidate; reasoning: string } | null> {
  const { llm, candidates, hints } = input;
  if (candidates.length === 0) return null;

  const system = [
    'You pick ONE subtitle pack from a numbered candidate list for a media library.',
    'Prefer packs matching the target languages and preferred fansub groups when present.',
    'Preferred groups are a soft boost only — if none appear, still pick the best remaining pack (language match, multi-episode/batch, download count).',
    'Answer with the candidate number (# prefix). Use decision none only when every listing is clearly wrong language or unrelated title.',
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ].join(' ');

  const prompt = [
    `Title: ${hints.title}`,
    hints.languages.length > 0 ? `Target languages: ${hints.languages.join(', ')}` : '',
    hints.preferredGroups.length > 0
      ? `Preferred groups (soft): ${hints.preferredGroups.join(', ')}`
      : '',
    'Candidates:',
    candidates.map((c, i) => renderCandidate(i, c)).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: PackPickSchema,
    system,
    prompt,
    promptCache: true,
  });

  if (result.decision === 'none' || result.candidate === null) return null;
  const picked = candidates[result.candidate - 1];
  if (!picked) return null;
  return { candidate: picked, reasoning: result.reasoning };
}

/** One automated captcha solve attempt: plaintext SVG nodes first, then LLM on the SVG source. */
export async function solveCaptchaOnce(input: {
  llm: StructuredGenerator;
  svg: string;
}): Promise<string | null> {
  const plain = [...input.svg.matchAll(/>([A-Za-z0-9]{4,6})</g)].map((m) => m[1]!);
  if (plain.length === 1) return plain[0]!;
  if (plain.length > 1) {
    // Prefer the longest unique token when several text nodes exist.
    const sorted = [...new Set(plain)].sort((a, b) => b.length - a.length);
    if (sorted[0] && sorted[0].length >= 4) return sorted[0];
  }

  const CaptchaSchema = z.object({
    answer: z.string().describe('the captcha text, usually 4-6 alphanumeric characters'),
  });
  try {
    const result = await input.llm.generate({
      callsite: CALLSITE,
      schema: CaptchaSchema,
      system:
        'Read a short distorted-text captcha from an SVG (or its description). Reply with only the characters the user must type.',
      prompt: `SVG captcha source (truncated):\n${input.svg.slice(0, 3000)}\n\nWhat is the captcha answer?`,
      promptCache: true,
    });
    const ans = result.answer.trim();
    return ans.length >= 3 && ans.length <= 12 ? ans : null;
  } catch {
    return null;
  }
}
