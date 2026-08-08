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
 * Shared derivation behind `resolveSourceDirsDetailed`: for each
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

interface SourceDirsDetailed {
  /** Every sweep-worthy dir. */
  all: string[];
  /** The subset that resolved through a configured `downloadRoots` entry, excluding the
   * dirname() fallback. */
  rootDerived: string[];
}

/**
 * Derives both directory sets `runIngestJob` needs from one `deriveSourceDirs` pass, so a
 * caller that wants both (as `runIngestJob` does — the sidecar sweep's full set AND the
 * rescue stage's narrower one) doesn't run the same derivation twice.
 *
 * `all`: the set of ARR-side directories to sweep for leftover sidecar/video files, from
 * every dropped-file path an import event reported. All paths in and out are ARR-side
 * (unmapped) — `runIngestJob` maps the result through `mapArrPath` itself, same boundary
 * convention as `mapArrPath`'s own arr-vs-local split. Used by the sidecar sweep, which is
 * unaffected by whether a dir is root-derived or a dirname() fallback.
 *
 * `rootDerived`: the subset that resolved through a configured `downloadRoots` entry,
 * excluding the dirname() fallback. The fallback dir can be a download client's shared
 * "completed" folder (used by every torrent, not just this one) rather than something
 * scoped to this torrent — folder-scoped manual-import lookups there would risk
 * auto-importing an unrelated bare-number file sitting in the same shared directory.
 * runIngestJob's rescue stage (`rescueStuckImports`) uses this for that reason.
 *
 * Both are deduped and sorted for a deterministic order.
 */
export function resolveSourceDirsDetailed(droppedPaths: string[], downloadRoots: string[]): SourceDirsDetailed {
  const derived = deriveSourceDirs(droppedPaths, downloadRoots);
  return {
    all: derived.map((d) => d.dir).sort(),
    rootDerived: derived
      .filter((d) => d.rootDerived)
      .map((d) => d.dir)
      .sort(),
  };
}
