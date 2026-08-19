import { z } from 'zod';
import type { ReleaseCandidate } from '../../arr/types.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';
import { BYTES_PER_GB } from '../../util/bytes.js';
import { synthesizePolicyPrompt } from './policy.js';
import type { SeasonMode } from './seasonMode.js';

/**
 * Shape the LLM itself answers with. The prompt only ever shows the LLM a numbered
 * candidate list (`renderCandidateLine` below) — it never sees a guid — so it answers
 * with the candidate's number (1-based, matching the `#N` prefix on each rendered line)
 * rather than an identifier it was never shown. `pickRelease` maps that number back to
 * the real candidate (and its guid) internally; see `PickResultSchema` below for the
 * shape callers of `pickRelease` actually get back.
 */
// A flat object, NOT a discriminated union: providers that take the schema as a tool /
// structured-output definition (Anthropic, OpenAI json_schema) require a
// root-level `type: "object"`, and a union serializes to a bare `anyOf` they 400 on.
// The pick-only fields are nullable instead; the superRefine enforces the pairing.
// `.nullable()` WITHOUT `.default()` on the three pick-only fields, deliberately: `.default()`
// drops a field from the JSON-schema `required` array and adds a `default` keyword, which
// OpenAI-family json_schema strict mode rejects outright (OpenRouter forwards the schema to
// the upstream route, so this still bites on those models), and
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
const PickResultSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('pick'),
    guid: z.string(),
    releaseGroup: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    reasoning: z.string(),
  }),
  z.object({ decision: z.literal('none'), reasoning: z.string() }),
]);
type PickResult = z.infer<typeof PickResultSchema>;

const CALLSITE = 'release-pick';

function isPack(c: ReleaseCandidate): boolean {
  return c.fullSeason === true;
}

function groupFromTitle(title: string): string | null {
  const m = title.match(/^\[([^\]]+)\]/);
  const group = m?.[1]?.trim();
  return group && group.length > 0 ? group : null;
}

/** The arr's own `releaseGroup` when it filled one in, else the bracketed prefix of the
 * title (`[Trix] ...`), which is where fansub releases actually carry it. Exported because
 * `run.ts` needs the same answer for a candidate the LLM never picked (a force-grab offer). */
export function resolveReleaseGroup(c: ReleaseCandidate): string | null {
  if (c.releaseGroup && c.releaseGroup.length > 0) return c.releaseGroup;
  return groupFromTitle(c.title);
}

/**
 * The host already decided pack vs single from Sonarr facts. Complete prefers packs
 * and falls back to singles only when no pack survived. Airing is the reverse.
 * Unknown/movie keep the full list: the host did not claim a shape.
 */
export function eligibleCandidates(mode: SeasonMode | undefined, candidates: ReleaseCandidate[]): ReleaseCandidate[] {
  if (mode === 'complete') {
    const packs = candidates.filter(isPack);
    return packs.length > 0 ? packs : candidates.filter((c) => !isPack(c));
  }
  if (mode === 'airing') {
    const singles = candidates.filter((c) => !isPack(c));
    return singles.length > 0 ? singles : candidates.filter(isPack);
  }
  return candidates;
}

function episodeNumbersOf(c: ReleaseCandidate): number[] {
  if (c.mappedEpisodeNumbers && c.mappedEpisodeNumbers.length > 0) return c.mappedEpisodeNumbers;
  return c.episodeNumbers ?? [];
}

function candidateShape(c: ReleaseCandidate): 'pack' | 'multi' | 'single' {
  if (c.fullSeason === true) return 'pack';
  return episodeNumbersOf(c).length > 1 ? 'multi' : 'single';
}

/** Renders one numbered candidate line, e.g. `#1 pack | [title] | WEBDL-1080p | Trix | Japanese | 2.2 GB | 130 seeders | Nyaa`. */
function renderCandidateLine(index: number, c: ReleaseCandidate): string {
  const sizeGB = (c.size / BYTES_PER_GB).toFixed(1);
  const seedersLabel = c.seeders === null || c.seeders === undefined ? '? seeders' : `${c.seeders} seeders`;
  const quality = c.quality?.quality?.name ?? '?';
  const group = c.releaseGroup && c.releaseGroup.length > 0 ? c.releaseGroup : '?';
  const langs =
    c.languages && c.languages.length > 0 ? c.languages.map((l) => l.name).join(', ') : '?';
  return `#${index + 1} ${candidateShape(c)} | [${c.title}] | ${quality} | ${group} | ${langs} | ${sizeGB} GB | ${seedersLabel} | ${c.indexer}`;
}

/**
 * Picks one release from the prefiltered list. The host owns only the SHAPE of the
 * eligible set (packs vs singles, via `eligibleCandidates`); the LLM ranks whatever
 * survives, even a pool of one, and its `none` verdict is returned verbatim rather
 * than overridden here. What a veto costs is the CALLER's call: `run.ts` turns a
 * shape-owned one into a human attention item offering a force-grab. The LLM answers
 * with a 1-based number into the eligible list, never a guid.
 */
export async function pickRelease(input: {
  llm: StructuredGenerator;
  candidates: ReleaseCandidate[];
  prefer: string[];
  avoid: string[];
  title: string;
  kind: 'series' | 'movie';
  seasonNumber?: number;
  mode?: SeasonMode;
  hint?: string;
  /** Ties this call's `llm.call` trace entries to the job that made it; omitted by callers
   * with no job at hand (tests), which just means the call isn't traced. */
  jobId?: number;
}): Promise<PickResult> {
  // `jobId` is destructured out explicitly: anything left in `promptInput` reaches
  // `synthesizePolicyPrompt` and would change the prompt bytes.
  const { llm, candidates, jobId, ...promptInput } = input;

  const pool = eligibleCandidates(promptInput.mode, candidates);

  // Nothing to rank and nothing to veto: the only none the host declares on its own.
  if (pool.length === 0) {
    return { decision: 'none', reasoning: 'no candidates' };
  }

  const { system, user } = synthesizePolicyPrompt(promptInput);

  const candidateLines = pool.map((c, i) => renderCandidateLine(i, c)).join('\n');
  const prompt = [user, 'Candidates:', candidateLines].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: LlmPickResponseSchema,
    system,
    prompt,
    trace: jobId !== undefined ? { jobId } : undefined,
  });

  if (result.decision === 'none' && result.candidate === null) {
    return { decision: 'none', reasoning: result.reasoning };
  }

  if (result.candidate === null) {
    throw new LlmError('LLM said "pick" without a candidate number', CALLSITE);
  }
  const picked = pool[result.candidate - 1];
  if (!picked) {
    throw new LlmError(
      `LLM picked candidate number ${result.candidate}, which is out of range (candidates are numbered 1-${pool.length})`,
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
