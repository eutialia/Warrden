import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** An arr-side -> Warrden-side path mapping, as configured in `config.pathMappings`. */
export interface PathMapping {
  from: string;
  to: string;
}

/**
 * Rewrites an arr-container path `p` into its Warrden-side (mounted) equivalent using
 * `mappings`, e.g. an arr reporting `/data/downloads/t/a.mkv` when Warrden sees that same
 * NAS share at `/mnt/nas/downloads`. A mapping applies when `p` equals its `from` exactly,
 * or starts with `from` followed by a path separator — a bare prefix match would wrongly
 * rewrite `/data/downloadsX` under a `/data/downloads` mapping. When more than one mapping
 * applies, the longest `from` wins (the more specific mapping). No applicable mapping
 * returns `p` unchanged. Trailing slashes on both `from` and `to` are stripped before use —
 * these mapped paths get stored/compared later (e.g. provenance rows), so a stray trailing
 * slash on either side would otherwise leak a `//` artifact into the result.
 */
export function mapArrPath(mappings: PathMapping[], p: string): string {
  let best: PathMapping | undefined;
  for (const mapping of mappings) {
    const from = mapping.from.replace(/\/+$/, '');
    const to = mapping.to.replace(/\/+$/, '');
    const applies = p === from || p.startsWith(from + '/');
    if (!applies) continue;
    if (!best || from.length > best.from.length) {
      best = { from, to };
    }
  }
  if (!best) return p;
  return best.to + p.slice(best.from.length);
}

/**
 * Turns a URL's last path segment into a filesystem-safe name. Every char outside
 * `[A-Za-z0-9._-]` becomes `_`, so a model-chosen or site-supplied segment can't escape the
 * directory it is joined into via `..` or a separator (`join('/data/dl', 'x-../../etc/passwd')`
 * would otherwise resolve outside it). Query strings are part of the tail and get flattened
 * into the name like any other text. Capped at 180 chars to stay under filename limits once a
 * caller prefixes it, and empty results fall back to `download`.
 */
export function safeUrlTailName(url: string): string {
  const rawName = url.split('/').pop() || 'download';
  return rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'download';
}

/** Make (and return) a directory under the data dir — used by `agent/siteKnowledge.ts`
 * (the site knowledge and seed directories). Not the single point every runtime-owned path
 * goes through: roughly ten direct `mkdirSync(join(dataDir, …))` calls remain across
 * `config/store.ts`, `db/db.ts`, the subtitle pipeline and `agent/tiers.ts`, none required
 * to route through here. */
export function ensureDataSubdir(dataDir: string, ...segments: string[]): string {
  const dir = join(dataDir, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}
