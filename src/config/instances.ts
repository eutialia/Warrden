import type { ArrInstance, Config } from './schema.js';

/** The configured `kind` for arr instance `name`, or `undefined` if it isn't in
 * `config.arrs` at all. Shared by `reconcile.ts` (which skips an instance its `ArrClient`
 * map still holds under a renamed/removed name — see its own doc for why guessing the kind
 * there is unsafe) and `managed/deleteObject.ts` (which skips the tag/release-profile-only
 * live checks for a `radarr`-kind instance, mirroring reconcile's own GC guard). */
export function instanceKind(config: Config, name: string): ArrInstance['kind'] | undefined {
  return config.arrs.find((a) => a.name === name)?.kind;
}
