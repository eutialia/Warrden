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

/** The three-level gate every tier reports on, and the whole plan's overall risk —
 * inferred from the schema so every caller that acts on a `BundlePlan` (the rescue stage in
 * `run.ts`, the accept-attention route in `server/app.ts`) shares this
 * exact type instead of re-declaring the union. */
type BundleConfidence = z.infer<typeof BundleMapResponseSchema>['confidence'];

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

/** Builds the `ManualImportFile` row `executeManualImport` (called from `run.ts`'s rescue
 * stage) expects, stamping
 * `seriesId` and round-tripping `quality`/`languages`/`releaseGroup`/`folderName`
 * verbatim from the arr-reported `item` — Warrden never inspects or rewrites those
 * opaque blobs, only decides which episode(s) the file maps to. `episodeIds` is deduped
 * here (the one place every tier's ids flow through) so a repeated id — a duplicated
 * tier-1 `item.episodes` entry, or an LLM `[1, 1]` — never gets miscounted as two
 * different files claiming the same episode by the duplicate-target guard below. */
function toManualImportFile(item: ManualImportItem, episodeIds: number[], seriesId: number): ManualImportFile {
  return {
    path: item.path,
    folderName: item.folderName,
    seriesId,
    episodeIds: [...new Set(episodeIds)],
    quality: item.quality,
    languages: item.languages,
    releaseGroup: item.releaseGroup,
  };
}

/**
 * Asks the LLM to map every still-unresolved leftover file (deterministic mapping
 * already took what it could) to the episode(s) it contains — usually one, empty when
 * the file isn't an episode at all (sample/NCOP/NCED/menu/extra), never more than one
 * except a genuine double-episode file. Callers must not invoke this with an empty
 * `episodes` table — mirror `matchSidecarsWithLlm`'s own short-circuit at the call site
 * instead of paying for a guaranteed-useless round-trip.
 *
 * As with `matchLlm.ts`'s sidecar call, a `file` number outside `1..items.length` is a
 * contract violation (the LLM referenced a file it was never shown) and throws
 * `LlmError`; an `episodeIds` entry naming an id outside `episodes` is just a bad guess
 * about one file and is silently dropped instead of sinking the batch — nothing
 * irreversible happens here, a file with no surviving id just lands in `skipped` for a
 * human to place manually.
 */
async function mapBundleWithLlm(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  items: ManualImportItem[];
  episodes: EpisodeResource[];
  jobId?: number;
}): Promise<{ episodeIdsByFile: number[][]; confidence: BundleConfidence; reasoning: string }> {
  const { llm, seriesTitle, items, episodes, jobId } = input;

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
    trace: jobId !== undefined ? { jobId } : undefined,
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
  confidence: BundleConfidence;
  reasoning: string;
  skipped: string[]; // paths judged not-an-episode (samples, NC*, extras), or dropped as unsafe
}

/**
 * Plans a manual-import batch for one bundle folder/downloadId's leftover video files —
 * pure planning, no I/O; `run.ts`'s rescue stage is the one that actually calls `executeManualImport`
 * with the resulting `files`. Movies never take this path: a stuck movie import maps
 * 1:1 to its `movieId` in `run.ts`, and leftover movie-folder videos are extras that
 * must never be imported.
 *
 * Three tiers, cheapest/most-certain first, so the LLM only ever sees what neither of
 * the first two could place:
 * 1. Items the arr already resolved on its own (`episodes.length > 0`, no rejections)
 *    round-trip straight into `files` — the arr's own manual-import parser already did
 *    the work, second-guessing it would only introduce risk. Its episode ids are still
 *    validated against `episodes` (an id the caller's episode list doesn't recognize is
 *    dropped); an item with no surviving id is NOT tier-1 material and falls through to
 *    tiers 2/3 instead of importing with an empty `episodeIds`.
 * 2. Everything else gets one shot at `matchSidecarDeterministic` (from `sidecars.ts`;
 *    it works on any filename, not just sidecars), matched against the FULL episode
 *    list — its single-regular-season heuristic needs to see every season to decide
 *    whether a bare number is unambiguous, so pre-filtering to `hasFile === false` would
 *    corrupt that decision (see the inline comment at the call site). The hit is then
 *    only accepted when `!hit.hasFile`: bundle rescue exists to fill in missing
 *    episodes, and a bare trailing number that happens to parse as, say, "05" must never
 *    displace a real file already sitting on disk. A hit on an occupied episode (or no
 *    hit at all) falls through to the LLM tier instead, which can see `hasFile` in the
 *    episode table and answer an empty `episodeIds` for it.
 * 3. Whatever's left after both goes to a single LLM call (`mapBundleWithLlm`) — skipped
 *    entirely (no call at all) when the episode table is empty, mirroring
 *    `matchSidecarsWithLlm`'s own short-circuit, since no episode table means nothing
 *    the LLM says can possibly be right. An empty (or fully-invalid-id) `episodeIds` for
 *    a file, or a file the LLM's `mappings` never mentions at all, means it isn't an
 *    importable episode, so it lands in `skipped` rather than `files`.
 *
 * After all three tiers, two safety passes run over the assembled `files` before
 * anything is returned, because this plan feeds an irreversible import:
 * - **Duplicate-target guard**: if two or more files end up claiming the same episode id
 *   (e.g. `Show - 05.mkv` and `Show - 05v2.mkv` both resolving to episode 5), none of
 *   them is trustworthy enough to import unattended — ALL of them are pulled out of
 *   `files` and appended to `skipped`, and `reasoning` gets a note. Picking one over the
 *   other is a human call.
 * - **Already-imported skip (incremental only)**: any file whose episode id(s) are all
 *   already on disk (`hasFile === true`) is dropped from `files` into `skipped`. Warrden
 *   never proposes re-importing or replacing library files that Sonarr already owns —
 *   only real leftovers (missing episodes) stay in the plan. A plan that ends up empty
 *   after this pass returns `null` (quiet no-op), which is the correct outcome when the
 *   arr's manual-import API re-lists an entire finished library.
 *
 * Returns `null` when nothing ended up importable — an empty `files` plan isn't worth
 * acting on.
 */
export async function planBundleImport(input: {
  llm: StructuredGenerator;
  seriesTitle: string;
  seriesId: number;
  items: ManualImportItem[]; // manual-import candidates for one folder/downloadId
  episodes: EpisodeResource[]; // FULL episode list (mapping targets episodes without files)
  /** Ties this call's `llm.call` trace entries to the job that made it; omitted by callers
   * with no job at hand (tests), which just means the call isn't traced. */
  jobId?: number;
}): Promise<BundlePlan | null> {
  const { llm, seriesTitle, seriesId, items, episodes, jobId } = input;

  const validEpisodeIds = new Set(episodes.map((e) => e.id));

  let files: ManualImportFile[] = [];
  const skipped: string[] = [];
  const remaining: ManualImportItem[] = [];

  for (const item of items) {
    if (item.rejections.length === 0 && item.episodes.length > 0) {
      const validIds = item.episodes.map((e) => e.id).filter((id) => validEpisodeIds.has(id));
      if (validIds.length > 0) {
        files.push(toManualImportFile(item, validIds, seriesId));
        continue;
      }
    }

    // Tier 2 must call matchSidecarDeterministic with the FULL episode list, not one
    // pre-filtered to hasFile:false: its bare-number heuristic ("exactly one regular
    // season -> match by episodeNumber alone") only works when it can see every season.
    // Filtering out a complete season first can leave exactly one INCOMPLETE season
    // behind, which the heuristic then wrongly treats as "the only season" — e.g. S01
    // complete + S02 missing turns a genuinely ambiguous "05" into a false-confident
    // S02E05. So: match against everything, then reject the hit if it's occupied. A hit
    // on an occupied episode (or no hit at all) falls through to the LLM tier, which can
    // see hasFile in the episode table and reason about it properly.
    const deterministic = matchSidecarDeterministic(basename(item.path), episodes);
    if (deterministic && !deterministic.hasFile) {
      files.push(toManualImportFile(item, [deterministic.id], seriesId));
      continue;
    }

    remaining.push(item);
  }

  let confidence: BundleConfidence = 'high';
  let reasoning = 'every file resolved via the arr or deterministic filename matching; no LLM call needed';

  if (remaining.length > 0 && episodes.length === 0) {
    // No episode table at all — nothing the LLM could say about these files would mean
    // anything, so they're unresolvable by construction. Skip the guaranteed-useless
    // paid call, same as matchSidecarsWithLlm's empty-episode-table short-circuit.
    skipped.push(...remaining.map((item) => item.path));
  } else if (remaining.length > 0) {
    const llmResult = await mapBundleWithLlm({ llm, seriesTitle, items: remaining, episodes, jobId });
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

  // Duplicate-target guard: two files can each resolve "cleanly" on their own tier and
  // still both claim the same episode id (two cuts of the same episode in one bundle).
  // Neither is more trustworthy than the other, so both are pulled — silently keeping
  // one would be an unattended guess about which release to keep.
  const filesByEpisodeId = new Map<number, number[]>();
  files.forEach((f, i) => {
    for (const id of f.episodeIds ?? []) {
      const indices = filesByEpisodeId.get(id) ?? [];
      indices.push(i);
      filesByEpisodeId.set(id, indices);
    }
  });
  const duplicateIndices = new Set<number>();
  for (const indices of filesByEpisodeId.values()) {
    if (indices.length > 1) indices.forEach((i) => duplicateIndices.add(i));
  }
  if (duplicateIndices.size > 0) {
    const kept: ManualImportFile[] = [];
    files.forEach((f, i) => {
      if (duplicateIndices.has(i)) skipped.push(f.path);
      else kept.push(f);
    });
    files = kept;
    reasoning += `; ${duplicateIndices.size} file(s) skipped — duplicate episode targets (multiple files claimed the same episode)`;
  }

  // Incremental only: drop files that only target episodes Sonarr already has on disk.
  // Replacing an existing library file is never Warrden's job (Sonarr upgrades handle that).
  // A file that maps to a mix of free + occupied ids keeps only the free ones.
  const occupiedEpisodeIds = new Set(episodes.filter((e) => e.hasFile).map((e) => e.id));
  if (occupiedEpisodeIds.size > 0 && files.length > 0) {
    const kept: ManualImportFile[] = [];
    let droppedOccupied = 0;
    for (const f of files) {
      const ids = f.episodeIds ?? [];
      const freeIds = ids.filter((id) => !occupiedEpisodeIds.has(id));
      if (freeIds.length === 0) {
        skipped.push(f.path);
        droppedOccupied++;
      } else {
        kept.push(freeIds.length === ids.length ? f : { ...f, episodeIds: freeIds });
      }
    }
    files = kept;
    if (droppedOccupied > 0) {
      reasoning += `; ${droppedOccupied} file(s) skipped — episode already imported in the library`;
    }
  }

  if (files.length === 0) return null;

  return { files, confidence, reasoning, skipped };
}
