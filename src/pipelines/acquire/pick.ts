import { z } from 'zod';
import type { ReleaseCandidate } from '../../arr/types.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';
import { BYTES_PER_GB } from '../../util/bytes.js';
import { synthesizePolicyPrompt } from './policy.js';

/**
 * Shape the LLM itself answers with. The prompt only ever shows the LLM a numbered
 * candidate list (`renderCandidateLine` below) — it never sees a guid — so it answers
 * with the candidate's number (1-based, matching the `#N` prefix on each rendered line)
 * rather than an identifier it was never shown. `pickRelease` maps that number back to
 * the real candidate (and its guid) internally; see `PickResultSchema` below for the
 * shape callers of `pickRelease` actually get back.
 */
// A flat object, NOT a discriminated union: providers that take the schema as a tool /
// structured-output definition (Anthropic, OpenAI json_schema, claude-code) require a
// root-level `type: "object"`, and a union serializes to a bare `anyOf` they 400 on.
// The pick-only fields are nullable instead; the superRefine enforces the pairing.
// `.nullable()` WITHOUT `.default()` on the three pick-only fields, deliberately: `.default()`
// drops a field from the JSON-schema `required` array and adds a `default` keyword, which
// OpenAI's json_schema strict mode (the default under @ai-sdk/openai) rejects outright — and
// even where it's accepted, it stops telling the provider the field is mandatory once it
// commits to `decision: "pick"`. Staying `required` (just nullable) keeps the shape valid for
// strict-mode providers and keeps the schema honest; `superRefine` below still enforces the
// pick-requires-candidate pairing at the value level.
const LlmPickResponseSchema = z
  .object({
    decision: z.enum(['pick', 'none']),
    candidate: z.number().int().nullable(),
    releaseGroup: z
      .string()
      .nullable()
      .describe(
        'The release/fansub group name extracted from the picked candidate title (often bracketed, e.g. "[SubsPlease]" or "[喵萌奶茶屋&LoliHouse]"); null only when no group is identifiable',
      ),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
    reasoning: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'pick' && v.candidate === null) {
      ctx.addIssue({ code: 'custom', path: ['candidate'], message: 'candidate number is required when decision is "pick"' });
    }
  });

/** External shape `pickRelease` resolves to — a `guid`, not the candidate number the LLM
 * actually answered with, so every other caller (`run.ts`, tests) keeps working against a
 * real candidate identifier rather than an index into a list only `pick.ts` ever builds. */
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
 * numbered rendering of every candidate, and calls the LLM with `LlmPickResponseSchema`
 * — the LLM answers with the candidate's 1-based number, since it's never shown a guid
 * to answer with in the first place. A `pick` decision's number is mapped back to the
 * real candidate (and its guid) after the schema validates the shape — the schema can
 * only check "is this an int", not "is this a number that exists in the list", so an
 * out-of-range number throws `LlmError` rather than propagating a pick that doesn't
 * correspond to any real candidate.
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

  // Nothing to choose from — an empty candidate list isn't a policy question, so it's
  // not worth an LLM round-trip (cost, latency, and a queued fixture the caller would
  // have to supply for a foregone conclusion).
  if (candidates.length === 0) {
    return { decision: 'none', reasoning: 'no candidates' };
  }

  const { system, user } = synthesizePolicyPrompt(promptInput);

  const candidateLines = candidates.map((c, i) => renderCandidateLine(i, c)).join('\n');
  const prompt = [user, 'Candidates:', candidateLines].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: LlmPickResponseSchema,
    system,
    prompt,
  });

  if (result.decision === 'none') return { decision: 'none', reasoning: result.reasoning };

  // Unreachable after the schema's superRefine, but keeps the nullable type honest.
  if (result.candidate === null) {
    throw new LlmError('LLM said "pick" without a candidate number', CALLSITE);
  }
  const picked = candidates[result.candidate - 1];
  if (!picked) {
    throw new LlmError(
      `LLM picked candidate number ${result.candidate}, which is out of range (candidates are numbered 1-${candidates.length})`,
      CALLSITE,
    );
  }

  return {
    decision: 'pick',
    guid: picked.guid,
    releaseGroup: result.releaseGroup,
    confidence: result.confidence ?? 'low',
    reasoning: result.reasoning,
  };
}
