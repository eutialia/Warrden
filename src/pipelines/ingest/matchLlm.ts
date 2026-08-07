import { z } from 'zod';
import type { EpisodeResource } from '../../arr/types.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';

/**
 * Shape the LLM answers with. Like `pick.ts`'s `LlmPickResponseSchema`, this is a flat
 * `z.object` — never a discriminated union/anyOf at the root — because Anthropic and
 * OpenAI's strict-mode structured-output paths require a root-level `type: "object"`
 * and 400 on a bare `anyOf`. `episodeId` is `.nullable()` WITHOUT `.default()`: `.default()`
 * would drop the field from the JSON-schema `required` array, which OpenAI's strict mode
 * rejects outright.
 */
const SidecarMatchResponseSchema = z.object({
  assignments: z.array(
    z.object({
      file: z.number().int().describe('the 1-based number of the sidecar file from the numbered list'),
      episodeId: z
        .number()
        .int()
        .nullable()
        .describe('the matching episode id from the episode table, or null when no episode clearly matches'),
    }),
  ),
  reasoning: z.string(),
});

const CALLSITE = 'sidecar-match';

/** Zero-pads a season/episode number to 2 digits for the `SxxEyy` rendering below —
 * anime seasons/episodes are overwhelmingly < 100, and 3+ digit numbers still render
 * correctly (just without padding), same as Sonarr's own UI convention. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Renders one numbered episode table row, e.g. `id=10 S01E05 abs=17 "The Journey's End"`. */
export function renderEpisodeLine(e: EpisodeResource): string {
  const abs = e.absoluteEpisodeNumber ? ` abs=${e.absoluteEpisodeNumber}` : '';
  return `id=${e.id} S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}${abs} "${e.title}"`;
}

/**
 * Asks the LLM to map a batch of cryptic sidecar filenames (audio tracks/subtitles that
 * `matchSidecarDeterministic` in `sidecars.ts` couldn't place unambiguously) to the arr
 * episode they belong to. Files and episodes are referenced two different ways in the
 * answer, deliberately: files have no stable identifier of their own, so they're numbered
 * positionally (1-based, per the numbered list shown in the prompt) — same convention as
 * `pickRelease`'s numbered candidates. Episodes, by contrast, already have a real arr id,
 * and the episode table spells it out explicitly (`id=N`, see `renderEpisodeLine`) — so the
 * LLM echoes that real id straight back rather than inventing its own numbering scheme for
 * something that's already got one.
 *
 * Two failure shapes from the LLM are handled very differently, deliberately mirroring
 * the difference in what's at stake:
 * - A `file` number outside `1..files.length` means the LLM referenced a file that was
 *   never in the numbered list at all — that's a contract violation (the schema can
 *   only check "is this an int", not "is this a number we actually showed it"), so it
 *   throws `LlmError` and fails the whole batch loudly.
 * - An `episodeId` naming an episode not in `episodes` is just a bad guess about one
 *   file. Unlike `pickRelease` (where a bad pick triggers an irreversible grab),
 *   nothing irreversible happens here — an unmatched sidecar just lands in Attention
 *   for a human to place manually. So a single bad id coerces to `null` rather than
 *   sinking every other (possibly correct) assignment in the same batch.
 */
export async function matchSidecarsWithLlm(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  files: string[]; // sidecar file NAMES (not paths), 1-based numbering in the prompt
  episodes: EpisodeResource[]; // only hasFile episodes — a sidecar needs a video to sit beside
}): Promise<(number | null)[]> {
  const { llm, seriesTitle, files, episodes } = input;

  // Nothing to match — an empty file list isn't worth an LLM round-trip.
  if (files.length === 0) {
    return [];
  }

  // An empty episode table (e.g. every episode being hasFile:false) guarantees
  // every file is unmatchable regardless of what the LLM answers — skip the guaranteed-useless
  // paid call and coerce straight to null.
  if (episodes.length === 0) {
    return files.map(() => null);
  }

  const system = [
    'You map each numbered sidecar file (an audio track or subtitle) to the episode it belongs to, using the episode table provided.',
    'Filenames are often cryptic fansub names — use episode numbers, absolute numbers, and titles to decide.',
    "Answer with each file's number and the matched episode id, using episodeId null when a file is genuinely unmatchable.",
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const episodeLines = episodes.map(renderEpisodeLine).join('\n');
  const fileLines = files.map((f, i) => `#${i + 1} ${f}`).join('\n');
  const prompt = [
    `Series: ${seriesTitle}`,
    ['Episodes:', episodeLines].join('\n'),
    ['Sidecar files:', fileLines].join('\n'),
  ].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: SidecarMatchResponseSchema,
    system,
    prompt,
  });

  const byFile = new Map<number, number | null>();
  for (const a of result.assignments) {
    if (a.file < 1 || a.file > files.length) {
      throw new LlmError(
        `LLM assigned file number ${a.file}, which is out of range (files are numbered 1-${files.length})`,
        CALLSITE,
      );
    }
    byFile.set(a.file, a.episodeId);
  }

  const validEpisodeIds = new Set(episodes.map((e) => e.id));

  return files.map((_, i) => {
    const episodeId = byFile.get(i + 1) ?? null;
    return episodeId !== null && validEpisodeIds.has(episodeId) ? episodeId : null;
  });
}
