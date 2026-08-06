import { posix } from 'node:path';

/** Longest download root (arr-side, `/`-separated) whose segment-aware prefix matches
 * `p` — same rule as `mapArrPath`: a bare string prefix would wrongly match
 * `/downloadsX` under a `/downloads` root. `undefined` when no root applies. */
function longestMatchingRoot(p: string, roots: string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    const r = root.replace(/\/+$/, '');
    const applies = p === r || p.startsWith(r + '/');
    if (!applies) continue;
    if (best === undefined || r.length > best.length) best = r;
  }
  return best;
}

/**
 * Derives the set of ARR-side directories to sweep for leftover sidecar/video files, from
 * every dropped-file path an import event reported. All paths in and out are ARR-side
 * (unmapped) — `runIngestJob` maps the result through `mapArrPath` itself, same boundary
 * convention as `mapArrPath`'s own arr-vs-local split.
 *
 * For each dropped path, the longest matching `downloadRoots` entry (segment-aware, like
 * `mapArrPath`) identifies the torrent's own root folder: `root + '/' + firstSegment`. A
 * file sitting directly in a root (no subfolder — a single-file torrent) contributes
 * nothing, since there's no sibling folder to sweep. A path matching no configured root
 * falls back to its own containing directory (`dirname`) — better to sweep something
 * scoped too narrowly than to silently skip a torrent client Warrden doesn't know about.
 * Results are deduped and sorted for a deterministic sweep order.
 */
export function resolveSourceDirs(droppedPaths: string[], downloadRoots: string[]): string[] {
  const dirs = new Set<string>();

  for (const p of droppedPaths) {
    const root = longestMatchingRoot(p, downloadRoots);
    if (root === undefined) {
      dirs.add(posix.dirname(p));
      continue;
    }
    const rel = p.slice(root.length + 1);
    const slashIdx = rel.indexOf('/');
    if (slashIdx === -1) continue; // file directly in the root — nothing to sweep
    dirs.add(posix.join(root, rel.slice(0, slashIdx)));
  }

  return [...dirs].sort();
}
