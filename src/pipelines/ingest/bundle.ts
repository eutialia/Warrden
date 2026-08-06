import { basename } from 'node:path';
import { z } from 'zod';
import type { EpisodeResource, ManualImportFile, ManualImportItem } from '../../arr/types.js';
import { LlmError, type StructuredGenerator } from '../../llm/generator.js';
import { BYTES_PER_GB } from '../../util/bytes.js';
import { renderEpisodeLine } from './matchLlm.js';
import { matchSidecarDeterministic } from './sidecars.js';

/**
 * Shape the LLM answers with — flat `z.object` at the root for the same reason as
 * `matchLlm.ts`'s `SidecarMatchResponseSchema` and `pick.ts`'s `LlmPickResponseSchema`:
 * Anthropic/OpenAI strict structured-output requires a root-level `type: "object"`, not
 * a bare `anyOf`. `episodeIds` is a plain (non-nullable) array with no `.default()` —
 * an empty array is itself the "not an episode" signal, so there's nothing to default.
 */
const BundleMapResponseSchema = z.object({
  mappings: z.array(
    z.object({
      file: z.number().int().describe('the 1-based number of the video file from the numbered list'),
      episodeIds: z
        .array(z.number().int())
        .describe(
          'the episode id(s) this file contains — usually one; empty when the file is not an episode (sample, NCOP/NCED, menu, extra)',
        ),
    }),
  ),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string(),
});

const CALLSITE = 'bundle-map';

/** Renders one numbered episode table row for the bundle prompt: `renderEpisodeLine`'s
 * rendering (shared with `matchLlm.ts`, not copied) plus a `hasFile` flag, since a
 * multi-season/specials bundle prompt needs to show the LLM which episodes are already
 * on disk (unlikely mapping targets) and which are gaps (likely mapping targets). */
function renderBundleEpisodeLine(e: EpisodeResource): string {
  return `${renderEpisodeLine(e)} hasFile=${e.hasFile}`;
}

/** Renders one numbered leftover-file line, e.g. `#1 Show - 05.mkv (1.4 GB)`. */
function renderFileLine(index: number, item: ManualImportItem): string {
  const sizeGB = (item.size / BYTES_PER_GB).toFixed(1);
  return `#${index + 1} ${basename(item.path)} (${sizeGB} GB)`;
}

/** Builds the `ManualImportFile` row `executeManualImport` (Task 10) expects, stamping
 * `seriesId` and round-tripping `quality`/`languages`/`releaseGroup`/`folderName`
 * verbatim from the arr-reported `item` — Warrden never inspects or rewrites those
 * opaque blobs, only decides which episode(s) the file maps to. */
function toManualImportFile(item: ManualImportItem, episodeIds: number[], seriesId: number): ManualImportFile {
  return {
    path: item.path,
    folderName: item.folderName,
    seriesId,
    episodeIds,
    quality: item.quality,
    languages: item.languages,
    releaseGroup: item.releaseGroup,
  };
}

/**
 * Asks the LLM to map every still-unresolved leftover file (deterministic mapping
 * already took what it could) to the episode(s) it contains — usually one, empty when
 * the file isn't an episode at all (sample/NCOP/NCED/menu/extra), never more than one
 * except a genuine double-episode file. As with `matchLlm.ts`'s sidecar call, a `file`
 * number outside `1..items.length` is a contract violation (the LLM referenced a file
 * it was never shown) and throws `LlmError`; an `episodeIds` entry naming an id outside
 * `episodes` is just a bad guess about one file and is silently dropped instead of
 * sinking the batch — nothing irreversible happens here, a file with no surviving id
 * just lands in `skipped` for a human to place manually.
 */
async function mapBundleWithLlm(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  items: ManualImportItem[];
  episodes: EpisodeResource[];
}): Promise<{ episodeIdsByFile: number[][]; confidence: 'high' | 'medium' | 'low'; reasoning: string }> {
  const { llm, seriesTitle, items, episodes } = input;

  const system = [
    'You map each numbered leftover video file from a torrent to the episode(s) it contains, using the episode table (season/episode, absolute number, title).',
    'Multi-season bundles often use absolute numbering; specials belong to season 0.',
    'Files that are not episodes (samples, NCOP/NCED, PVs, menus) get an empty episodeIds.',
    'State confidence: high = certain, medium = strong inference, low = guessing.',
    'JSON only.',
  ].join(' ');

  const episodeLines = episodes.map(renderBundleEpisodeLine).join('\n');
  const fileLines = items.map((item, i) => renderFileLine(i, item)).join('\n');
  const prompt = [
    `Series: ${seriesTitle}`,
    ['Episodes:', episodeLines].join('\n'),
    ['Files:', fileLines].join('\n'),
  ].join('\n\n');

  const result = await llm.generate({
    callsite: CALLSITE,
    schema: BundleMapResponseSchema,
    system,
    prompt,
  });

  const validEpisodeIds = new Set(episodes.map((e) => e.id));
  const byFile = new Map<number, number[]>();
  for (const m of result.mappings) {
    if (m.file < 1 || m.file > items.length) {
      throw new LlmError(
        `LLM mapped file number ${m.file}, which is out of range (files are numbered 1-${items.length})`,
        CALLSITE,
      );
    }
    byFile.set(
      m.file,
      m.episodeIds.filter((id) => validEpisodeIds.has(id)),
    );
  }

  const episodeIdsByFile = items.map((_, i) => byFile.get(i + 1) ?? []);
  return { episodeIdsByFile, confidence: result.confidence, reasoning: result.reasoning };
}

export interface BundlePlan {
  files: ManualImportFile[]; // ready for executeManualImport
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  skipped: string[]; // paths judged not-an-episode (samples, NC*, extras)
}

/**
 * Plans a manual-import batch for one bundle folder/downloadId's leftover video files —
 * pure planning, no I/O; Task 10 is the one that actually calls `executeManualImport`
 * with the resulting `files`. Movies never take this path: a stuck movie import maps
 * 1:1 to its `movieId` in `run.ts`, and leftover movie-folder videos are extras that
 * must never be imported.
 *
 * Three tiers, cheapest/most-certain first, so the LLM only ever sees what neither of
 * the first two could place:
 * 1. Items the arr already resolved on its own (`episodes.length > 0`, no rejections)
 *    round-trip straight into `files` — the arr's own manual-import parser already did
 *    the work, second-guessing it would only introduce risk.
 * 2. Everything else gets one shot at `matchSidecarDeterministic` (from `sidecars.ts`;
 *    it works on any filename, not just sidecars) against the *full* episode list —
 *    an `SxxEyy` or absolute-number match here is exact, not a guess.
 * 3. Whatever's left after both goes to a single LLM call (`mapBundleWithLlm`). An
 *    empty (or fully-invalid-id) `episodeIds` for a file means the LLM judged it not an
 *    importable episode, so it lands in `skipped` rather than `files`.
 *
 * `confidence` reflects the riskiest tier actually used: `'high'` when every file
 * resolved via tiers 1-2 (no LLM guessing involved at all), otherwise whatever the LLM
 * itself reported. Returns `null` when nothing ended up importable — an empty `files`
 * plan isn't worth acting on.
 */
export async function planBundleImport(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  seriesId: number;
  items: ManualImportItem[]; // manual-import candidates for one folder/downloadId
  episodes: EpisodeResource[]; // FULL episode list (mapping targets episodes without files)
}): Promise<BundlePlan | null> {
  const { llm, seriesTitle, seriesId, items, episodes } = input;

  const files: ManualImportFile[] = [];
  const skipped: string[] = [];
  const remaining: ManualImportItem[] = [];

  for (const item of items) {
    if (item.episodes.length > 0 && item.rejections.length === 0) {
      files.push(
        toManualImportFile(
          item,
          item.episodes.map((e) => e.id),
          seriesId,
        ),
      );
      continue;
    }

    const deterministic = matchSidecarDeterministic(basename(item.path), episodes);
    if (deterministic) {
      files.push(toManualImportFile(item, [deterministic.id], seriesId));
      continue;
    }

    remaining.push(item);
  }

  let confidence: 'high' | 'medium' | 'low' = 'high';
  let reasoning = 'every file resolved via the arr or deterministic filename matching; no LLM call needed';

  if (remaining.length > 0) {
    const llmResult = await mapBundleWithLlm({ llm, seriesTitle, items: remaining, episodes });
    confidence = llmResult.confidence;
    reasoning = llmResult.reasoning;

    remaining.forEach((item, i) => {
      const episodeIds = llmResult.episodeIdsByFile[i] ?? [];
      if (episodeIds.length === 0) {
        skipped.push(item.path);
      } else {
        files.push(toManualImportFile(item, episodeIds, seriesId));
      }
    });
  }

  if (files.length === 0) return null;

  return { files, confidence, reasoning, skipped };
}
