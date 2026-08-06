import { z } from 'zod';
import type { ReleaseCandidate } from '../../arr/types.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';
import { synthesizePolicyPrompt } from './policy.js';

export const PickResultSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('pick'),
    guid: z.string(),
    releaseGroup: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    reasoning: z.string(),
  }),
  z.object({ decision: z.literal('none'), reasoning: z.string() }),
]);
export type PickResult = z.infer<typeof PickResultSchema>;

const BYTES_PER_GB = 1_073_741_824;
const CALLSITE = 'release-pick';

/** Renders one numbered candidate line, e.g. `#1 [title] | 1.4 GB | 25 seeders | indexer`. */
function renderCandidateLine(index: number, c: ReleaseCandidate): string {
  const sizeGB = (c.size / BYTES_PER_GB).toFixed(1);
  const seedersLabel = c.seeders === null || c.seeders === undefined ? '? seeders' : `${c.seeders} seeders`;
  return `#${index + 1} [${c.title}] | ${sizeGB} GB | ${seedersLabel} | ${c.indexer}`;
}

/**
 * Asks the LLM to pick one release (or declare none viable) from the prefiltered
 * candidate list. Builds the policy prompt via `synthesizePolicyPrompt`, appends a
 * numbered rendering of every candidate, and calls the LLM with `PickResultSchema`.
 * A `pick` decision's guid is checked against the candidate list after the schema
 * validates the shape — the schema can't know which guids exist, only the pipeline
 * can — so a hallucinated guid throws `LlmError` rather than propagating a pick that
 * doesn't correspond to any real candidate.
 */
export async function pickRelease(input: {
  llm: StructuredGenerator;
  candidates: ReleaseCandidate[];
  tags: string[];
  title: string;
  kind: 'series' | 'movie';
  seasonNumber?: number;
}): Promise<PickResult> {
  const { llm, candidates, ...promptInput } = input;
  const { system, user } = synthesizePolicyPrompt(promptInput);

  const candidateLines = candidates.map((c, i) => renderCandidateLine(i, c)).join('\n');
  const prompt = [user, 'Candidates:', candidateLines].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: PickResultSchema,
    system,
    prompt,
  });

  if (result.decision === 'pick' && !candidates.some((c) => c.guid === result.guid)) {
    throw new LlmError(`LLM picked guid "${result.guid}" which is not among the candidates`, CALLSITE);
  }

  return result;
}
