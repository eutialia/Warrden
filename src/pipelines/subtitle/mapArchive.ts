import { basename, relative } from 'node:path';
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

/**
 * Files per generate call. A subhd multi-season pack runs to ~1,500 files; one prompt
 * listing all of them buries the episode table and invites the model to drop or
 * renumber assignments wholesale. Batching keeps each list short enough to answer
 * carefully, at the cost of one call per 120 files.
 */
export const MAP_BATCH_SIZE = 120;

/** Zero-pads a season/episode number to 2 digits for the `SxxEyy` rendering — same
 * convention as `renderEpisodeLine` in `matchLlm.ts`. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Renders one numbered archive-file line with optional pre-parsed hints, e.g.
 * `#1 Season 2/01.ass (lang=zh-Hans, parsed=S02E01)`. The name is the file's path under
 * the pack root, not its basename: fansub packs put the season and often the group in the
 * directory and leave a bare episode number in the filename, so the basename alone hides
 * the half of the evidence that disambiguates. Null pieces render nothing.
 */
function renderFileLine(entry: ArchiveCacheEntry, index: number, rootDir: string): string {
  const name = relative(rootDir, entry.path) || basename(entry.path);
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

/** Renders one episode table row, marking the ones this run still wants a file for. The
 * unmarked rows are what stops a season-1 file from being cornered onto the season-1-numbered
 * gap: the model has somewhere true to put it. */
function renderMapEpisodeLine(e: EpisodeResource, wanted: Set<number>): string {
  return `${renderEpisodeLine(e)}${wanted.has(e.id) ? ' (wanted)' : ''}`;
}

/**
 * Asks the LLM to map subtitle files extracted from a downloaded pack (already
 * pre-annotated at cache-write time with lang/episodeRef hints) onto the arr episodes
 * they belong to. Same contract shape and failure semantics as `matchSidecarsWithLlm`:
 * - Out-of-range file number → throws `LlmError` (contract violation).
 * - Unknown episode id → coerces to null (one bad guess shouldn't sink the batch).
 * - Episode that exists but isn't wanted → null, counted through `onOffTarget`.
 * - Empty files → `[]`; empty episodes → all-null without an LLM call.
 */
export async function mapArchiveWithLlm(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  files: ArchiveCacheEntry[];
  /** Extraction root the file paths are rendered relative to — the archive cache dir. */
  rootDir: string;
  episodes: EpisodeResource[]; // only hasFile episodes — a sub needs a video to sit beside
  /** The subset of `episodes` this run still lacks a file for. Everything else is context:
   * shown so a file can be mapped truthfully, then dropped from the answer. */
  wanted: Set<number>;
  /** Ties this call's `llm.call` trace entries to the job that made it; omitted by callers
   * with no job at hand (tests), which just means the call isn't traced. */
  jobId?: number;
  /** Called once per batch that dropped assignments as off-target, with how many. */
  onOffTarget?: (count: number) => void;
}): Promise<(number | null)[]> {
  const { llm, seriesTitle, files, rootDir, episodes, wanted, jobId, onOffTarget } = input;

  if (files.length === 0) {
    return [];
  }

  // Empty episode table guarantees every file is unmatchable — skip the paid call.
  if (episodes.length === 0) {
    return files.map(() => null);
  }

  const episodeLines = episodes.map((e) => renderMapEpisodeLine(e, wanted)).join('\n');
  const validEpisodeIds = new Set(episodes.map((e) => e.id));

  const out: (number | null)[] = [];
  for (let start = 0; start < files.length; start += MAP_BATCH_SIZE) {
    const batch = files.slice(start, start + MAP_BATCH_SIZE);
    out.push(
      ...(await mapBatch({ llm, seriesTitle, batch, rootDir, episodeLines, validEpisodeIds, wanted, jobId, onOffTarget })),
    );
  }
  return out;
}

/** One generate call over one batch of files, numbered 1..batch.length within the call.
 * Returns the batch's slice of the answer, aligned to `batch`. */
async function mapBatch(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  batch: ArchiveCacheEntry[];
  rootDir: string;
  episodeLines: string;
  validEpisodeIds: Set<number>;
  wanted: Set<number>;
  jobId?: number;
  onOffTarget?: (count: number) => void;
}): Promise<(number | null)[]> {
  const { llm, seriesTitle, batch, rootDir, episodeLines, validEpisodeIds, wanted, jobId, onOffTarget } = input;

  const system = [
    'You map each numbered subtitle file extracted from a downloaded subtitle pack to the episode it belongs to, using the episode table provided.',
    'Each file is shown as its path inside the pack, so a directory name may carry the season or the fansub group even when the filename holds only an episode number.',
    'Filenames may include pre-parsed hints (lang, parsed episode ref) — use those plus episode numbers, absolute numbers, and titles to decide.',
    "The pack's directory and file names say which season(s) it covers.",
    'Map each file to the episode it truly belongs to, whether or not that episode is wanted.',
    'Never assign a file to a wanted episode only because the numbers coincide.',
    "Use null when the file's season is not in the table.",
    "Answer with each file's number and the matched episode id, using episodeId null when a file is genuinely unmatchable.",
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const fileLines = batch.map((f, i) => renderFileLine(f, i, rootDir)).join('\n');
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
    trace: jobId !== undefined ? { jobId } : undefined,
  });

  const byFile = new Map<number, number | null>();
  for (const a of result.assignments) {
    if (a.file < 1 || a.file > batch.length) {
      throw new LlmError(
        `LLM assigned file number ${a.file}, which is out of range (files are numbered 1-${batch.length})`,
        CALLSITE,
      );
    }
    byFile.set(a.file, a.episodeId);
  }

  let offTarget = 0;
  const ids = batch.map((_, i) => {
    const episodeId = byFile.get(i + 1) ?? null;
    if (episodeId === null || !validEpisodeIds.has(episodeId)) return null;
    if (!wanted.has(episodeId)) {
      offTarget++;
      return null;
    }
    return episodeId;
  });
  if (offTarget > 0) onOffTarget?.(offTarget);
  return ids;
}
