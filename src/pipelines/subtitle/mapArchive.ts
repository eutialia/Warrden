import { basename } from 'node:path';
import { z } from 'zod';
import type { EpisodeResource } from '../../arr/types.js';
import type { ArchiveCacheEntry } from '../../db/archiveCache.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';
import { renderEpisodeLine } from '../ingest/matchLlm.js';

/**
 * Shape the LLM answers with. Same flat `z.object` root as `matchLlm.ts` / `pick.ts` —
 * Anthropic and OpenAI's strict-mode structured-output paths require a root-level
 * `type: "object"` and 400 on a bare `anyOf`. `episodeId` is `.nullable()` WITHOUT
 * `.default()` so the field stays in the JSON-schema `required` array.
 */
const ArchiveMapResponseSchema = z.object({
  assignments: z.array(
    z.object({
      file: z.number().int().describe('the 1-based number of the subtitle file from the numbered list'),
      episodeId: z
        .number()
        .int()
        .nullable()
        .describe('the matching episode id from the episode table, or null when no episode clearly matches'),
    }),
  ),
  reasoning: z.string(),
});

const CALLSITE = 'archive-map';

/** Zero-pads a season/episode number to 2 digits for the `SxxEyy` rendering — same
 * convention as `renderEpisodeLine` in `matchLlm.ts`. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Renders one numbered archive-file line with optional pre-parsed hints, e.g.
 * `#1 0-01.ass (lang=zh-Hans, parsed=S01E01)`. Null pieces render nothing.
 */
function renderFileLine(entry: ArchiveCacheEntry, index: number): string {
  const name = basename(entry.path);
  const hints: string[] = [];
  if (entry.lang !== null) {
    hints.push(`lang=${entry.lang}`);
  }
  if (entry.episodeRef !== null) {
    const season = entry.episodeRef.season !== null ? pad(entry.episodeRef.season) : '??';
    hints.push(`parsed=S${season}E${pad(entry.episodeRef.episode)}`);
  }
  const hintSuffix = hints.length > 0 ? ` (${hints.join(', ')})` : '';
  return `#${index + 1} ${name}${hintSuffix}`;
}

/**
 * Asks the LLM to map subtitle files extracted from a downloaded pack (already
 * pre-annotated at cache-write time with lang/episodeRef hints) onto the arr episodes
 * they belong to. Same contract shape and failure semantics as `matchSidecarsWithLlm`:
 * - Out-of-range file number → throws `LlmError` (contract violation).
 * - Unknown episode id → coerces to null (one bad guess shouldn't sink the batch).
 * - Empty files → `[]`; empty episodes → all-null without an LLM call.
 */
export async function mapArchiveWithLlm(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  files: ArchiveCacheEntry[];
  episodes: EpisodeResource[]; // only hasFile episodes — a sub needs a video to sit beside
}): Promise<(number | null)[]> {
  const { llm, seriesTitle, files, episodes } = input;

  if (files.length === 0) {
    return [];
  }

  // Empty episode table guarantees every file is unmatchable — skip the paid call.
  if (episodes.length === 0) {
    return files.map(() => null);
  }

  const system = [
    'You map each numbered subtitle file extracted from a downloaded subtitle pack to the episode it belongs to, using the episode table provided.',
    'Filenames may include pre-parsed hints (lang, parsed episode ref) — use those plus episode numbers, absolute numbers, and titles to decide.',
    "Answer with each file's number and the matched episode id, using episodeId null when a file is genuinely unmatchable.",
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const episodeLines = episodes.map(renderEpisodeLine).join('\n');
  const fileLines = files.map((f, i) => renderFileLine(f, i)).join('\n');
  const prompt = [
    `Series: ${seriesTitle}`,
    ['Episodes:', episodeLines].join('\n'),
    ['Subtitle files:', fileLines].join('\n'),
  ].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: ArchiveMapResponseSchema,
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
