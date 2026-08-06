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
 * Shared derivation behind `resolveSourceDirs`/`resolveRootDerivedSourceDirs`: for each
 * dropped path, the longest matching `downloadRoots` entry (segment-aware, like
 * `mapArrPath`) identifies the torrent's own root folder (`root + '/' + firstSegment`,
 * `rootDerived: true`); a path matching no configured root falls back to its own
 * containing directory (`dirname`, `rootDerived: false`) — better to sweep something
 * scoped too narrowly than to silently skip a torrent client Warrden doesn't know about.
 * A file sitting directly in a root (no subfolder — a single-file torrent) contributes
 * nothing, since there's no sibling folder to sweep. When the same directory is reached
 * both ways across multiple dropped paths, it counts as root-derived — root-derived is
 * strictly more specific/trusted than a dirname guess, never the other way round.
 */
function deriveSourceDirs(droppedPaths: string[], downloadRoots: string[]): { dir: string; rootDerived: boolean }[] {
  const dirs = new Map<string, boolean>();

  for (const p of droppedPaths) {
    const root = longestMatchingRoot(p, downloadRoots);
    if (root === undefined) {
      const dir = posix.dirname(p);
      if (!dirs.has(dir)) dirs.set(dir, false);
      continue;
    }
    const rel = p.slice(root.length + 1);
    const slashIdx = rel.indexOf('/');
    if (slashIdx === -1) continue; // file directly in the root — nothing to sweep
    dirs.set(posix.join(root, rel.slice(0, slashIdx)), true);
  }

  return [...dirs.entries()].map(([dir, rootDerived]) => ({ dir, rootDerived }));
}

/**
 * Derives the set of ARR-side directories to sweep for leftover sidecar/video files, from
 * every dropped-file path an import event reported. All paths in and out are ARR-side
 * (unmapped) — `runIngestJob` maps the result through `mapArrPath` itself, same boundary
 * convention as `mapArrPath`'s own arr-vs-local split. Results are deduped and sorted for
 * a deterministic sweep order. Used by the sidecar sweep, which is unaffected by whether a
 * dir is root-derived or a dirname() fallback — see `resolveRootDerivedSourceDirs` for the
 * narrower set the rescue stage's folder-scoped manual-import lookups use instead.
 */
export function resolveSourceDirs(droppedPaths: string[], downloadRoots: string[]): string[] {
  return deriveSourceDirs(droppedPaths, downloadRoots)
    .map((d) => d.dir)
    .sort();
}

/**
 * The subset of `resolveSourceDirs`'s directories that resolved through a configured
 * `downloadRoots` entry, excluding the dirname() fallback. The fallback dir can be a
 * download client's shared "completed" folder (used by every torrent, not just this
 * one) rather than something scoped to this torrent — folder-scoped manual-import
 * lookups there would risk auto-importing an unrelated bare-number file sitting in the
 * same shared directory. Task 10's rescue stage uses this for that reason; the sidecar
 * sweep keeps using the full `resolveSourceDirs` set, since matching a sidecar to a
 * specific already-on-disk episode carries no equivalent blind-import risk.
 */
export function resolveRootDerivedSourceDirs(droppedPaths: string[], downloadRoots: string[]): string[] {
  return deriveSourceDirs(droppedPaths, downloadRoots)
    .filter((d) => d.rootDerived)
    .map((d) => d.dir)
    .sort();
}
