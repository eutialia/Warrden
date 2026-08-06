import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TMP_PREFIX = '.warrden-tmp-';

/**
 * Recursively lists files under `dir` whose extension (case-insensitive) is in `exts`
 * (each given with its leading dot, e.g. `.srt`). Dotfiles and anything whose basename
 * starts with the atomic-copy temp prefix (`.warrden-tmp-`) are skipped — the latter is a
 * copy in flight, never a real sidecar. A missing `dir` returns `[]` rather than throwing,
 * since sweeping an ingest root that hasn't been created yet is a normal, not exceptional,
 * state. Returned paths are absolute and sorted for deterministic ordering.
 */
export function walkFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const results: string[] = [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (!wanted.has(ext)) continue;
    results.push(join(entry.parentPath, entry.name));
  }
  return results.sort();
}

/**
 * Copies `src` to `dest` without ever leaving a partially-written file at `dest`: writes to
 * a `.warrden-tmp-`-prefixed sibling first, then renames it into place (`rename` is atomic
 * on the same filesystem). The temp file is unlinked on any failure — including a failed
 * `copyFileSync` — so a crash mid-copy never leaves a `.warrden-tmp-*` file for `walkFiles`
 * (or a human) to trip over.
 */
export function atomicCopy(src: string, dest: string): void {
  const tmp = join(dirname(dest), TMP_PREFIX + basename(dest));
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

/** Thrown by `ensureMounts` when one or more expected mount markers are absent. */
export class MountError extends Error {
  missing: string[];

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
