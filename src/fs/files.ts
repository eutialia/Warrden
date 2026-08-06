import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const TMP_PREFIX = '.warrden-tmp-';

/**
 * Recursively lists files under `dir` whose extension (case-insensitive) is in `exts`
 * (each given with its leading dot, e.g. `.srt`). Dotfiles are skipped, and a dot-named
 * directory is skipped *before* descending into it rather than after — NAS shares commonly
 * carry OS/filesystem housekeeping trees like `.Trashes`, `.zfs`, or `.AppleDouble` that can
 * be enormous (e.g. a `.zfs` snapshot directory mirrors the entire dataset tree once per
 * snapshot), so enumerating their contents just to discard every entry would stall a sweep
 * for minutes even though it returns nothing from them. This also covers the atomic-copy
 * temp prefix `.warrden-tmp-`, itself a dotfile: a copy in flight, never a real sidecar.
 * Walks directory-by-directory (not `fs.readdirSync`'s `recursive` option, which has no way
 * to prune a subtree before descending into it). A missing `dir` returns `[]` rather than
 * throwing, since sweeping an ingest root that hasn't been created yet is a normal, not
 * exceptional, state. Returned paths are always absolute (resolved against `dir`) and
 * sorted for deterministic ordering.
 */
export function walkFiles(dir: string, exts: string[]): string[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const results: string[] = [];

  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // dotfiles and dot-directories, pruned pre-descent
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && wanted.has(extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  };
  visit(root);

  return results.sort();
}

/**
 * Copies `src` to `dest` without ever leaving a partially-written file at `dest`: writes to
 * a `.warrden-tmp-`-prefixed sibling first, then renames it into place (`rename` is atomic
 * on the same filesystem). The temp file is unlinked on any failure — including a failed
 * `copyFileSync` or `renameSync` — so a crash mid-copy never leaves a `.warrden-tmp-*` file
 * for `walkFiles` (or a human) to trip over. The cleanup unlink has its own try/catch so a
 * failure to remove the temp file can't mask the original error.
 */
export function atomicCopy(src: string, dest: string): void {
  const tmp = join(dirname(dest), TMP_PREFIX + basename(dest));
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup — the original error below is the one that matters
    }
    throw err;
  }
}

/** Thrown by `ensureMounts` when one or more expected mount markers are absent. */
export class MountError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`missing mount marker(s): ${missing.join(', ')}`);
    this.name = 'MountError';
    this.missing = missing;
  }
}

/**
 * Verifies every path in `markers` exists, throwing `MountError` (listing exactly the
 * absent ones) otherwise. Guards against running filesystem work — sweeps, copies, deletes
 * — against an unmounted NAS share, where the mount point exists as an empty local
 * directory and would otherwise look like "nothing to do" instead of "not actually
 * mounted". An empty `markers` list (no markers configured) is a no-op.
 */
export function ensureMounts(markers: string[]): void {
  const missing = markers.filter((m) => !existsSync(m));
  if (missing.length > 0) throw new MountError(missing);
}
