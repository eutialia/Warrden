import { z } from 'zod';

/** Placeholder `GET /api/config` (`src/server/app.ts`) substitutes for every secret value
 * (`llm.keys.*`, `arrs[].apiKey`) instead of the real one. Exported so the API layer (which
 * restores it back to the stored secret on `PUT`, and rejects it outright when there's
 * nothing stored to restore from — a renamed or brand-new arr instance) and this schema
 * (which refuses to ever accept it as a literal saved value, as a second line of defense)
 * share the one definition on the server side. There is no shared package between the
 * server and `web/` in Phase 1, though — `web/src/api.ts` hand-copies this exact same
 * character as its own `SECRET_PLACEHOLDER` constant, and the two must be kept in sync by
 * hand if this value ever changes. */
export const SECRET_PLACEHOLDER = '•••';

const ProviderSchema = z.enum(['openrouter', 'openai', 'anthropic', 'claude-code']);
const CallsiteModelSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  fallback: z.object({ provider: ProviderSchema, model: z.string().min(1) }).optional(),
});
const ArrInstanceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['sonarr', 'radarr']),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
});
const SubtitleSiteSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.url(),
  // Search page URL with `{query}` where the URL-encoded search term goes. Optional:
  // without it the agent must discover the search endpoint itself (recorded into the
  // site profile's search_url_patterns on success).
  searchUrlTemplate: z.string().min(1).optional(),
});
export type SubtitleSiteConfig = z.infer<typeof SubtitleSiteSchema>;
export const ConfigSchema = z
  .object({
    // Nested objects use .prefault() rather than .default(): in Zod v4, .default()
    // short-circuits and returns the literal default without running it through the
    // inner schema, so a missing top-level key would skip the field-level defaults
    // below it. .prefault() substitutes the value and then validates/defaults it.
    //
    // All object/array defaults use the factory form (`() => ({...})` / `() => [...]`)
    // rather than a literal. Zod v4 shallow-clones a literal default on every parse,
    // so the top-level object/array is fresh each time, but anything nested inside it
    // (e.g. `profiles.dev`) is the same shared reference across parses. Any default
    // with nested structure needs the factory form; used uniformly here so the safety
    // is structural rather than case-by-case.
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(9797),
        publicUrl: z.url().default('http://localhost:9797'), // used for webhook registration
      })
      .prefault({}),
    arrs: z.array(ArrInstanceSchema).default(() => []),
    // `.min(1)` on both sides: a blank `from`/`to` can never map anything and would silently
    // no-op `mapArrPath` for every path it's checked against — reject it rather than let a
    // half-filled row (e.g. one left over from a UI "Add" click) save as valid.
    pathMappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default(() => []),
    picking: z
      .object({
        tags: z.array(z.string()).default(() => []),
        seederFloor: z.number().int().min(0).default(3),
        minSizeMB: z.number().min(0).default(50),
        maxSizeMB: z.number().min(0).default(60000),
      })
      .prefault({})
      .check((ctx) => {
        // minSizeMB > maxSizeMB would make every candidate fail the size window
        // (src/pipelines/acquire/prefilter.ts) — an inverted window is never intentional.
        if (ctx.value.minSizeMB > ctx.value.maxSizeMB) {
          ctx.issues.push({
            code: 'custom',
            message: `picking.minSizeMB (${ctx.value.minSizeMB}) must be <= picking.maxSizeMB (${ctx.value.maxSizeMB})`,
            input: ctx.value,
            path: ['minSizeMB'],
          });
        }
      }),
    ingest: z
      .object({
        // Local (mapped) paths that must exist before any filesystem work — e.g. a marker
        // file at the root of each NAS mount. Empty list = no mount verification. `.min(1)`
        // per entry: a blank marker would trivially "exist" as a no-op check, defeating the
        // point of listing it at all.
        mountMarkers: z.array(z.string().min(1)).default(() => []),
        // ARR-side paths of the torrent clients' download roots. Used to derive a torrent's
        // root folder from an imported file's path, and as a hard "never sweep this dir
        // itself" guard. `.min(1)` per entry: a blank root would match every path's
        // longest-prefix check in `resolveSourceDirsDetailed`, corrupting bundle rescue.
        downloadRoots: z.array(z.string().min(1)).default(() => []),
      })
      .prefault({}),
    subtitle: z
      .object({
        // Target languages, most-wanted first (e.g. ['zh-Hans', 'zh-Hant']). An episode
        // "has subs" when it carries EVERY one of these as an embedded or external track.
        languages: z.array(z.string().min(1)).default(() => []),
        sites: z.array(SubtitleSiteSchema).default(() => []),
      })
      .prefault({}),
    browser: z
      .object({
        // Hard ceiling on LLM steps (tool calls) for one site-search agent run.
        stepBudget: z.number().int().min(1).default(20),
        // Polite re-hit floor per site; a site profile's own last-failure backoff can
        // push a site's next attempt further out, never sooner.
        siteCooldownSeconds: z.number().int().min(0).default(30),
      })
      .prefault({}),
    llm: z
      .object({
        activeProfile: z.enum(['dev', 'prod']).default('prod'),
        // profile -> callsite -> model config; Phase 1 callsite: 'release-pick'
        profiles: z
          .record(z.string(), z.record(z.string(), CallsiteModelSchema))
          .default(() => ({ dev: {}, prod: {} })),
        keys: z
          .object({
            openrouter: z.string().min(1).optional(),
            openai: z.string().min(1).optional(),
            anthropic: z.string().min(1).optional(),
          })
          .default(() => ({})),
      })
      .prefault({}),
    reconcileIntervalMinutes: z.number().int().min(1).default(15),
  })
  .superRefine((cfg, ctx) => {
    // Defense-in-depth against `SECRET_PLACEHOLDER` ever being saved as a real secret:
    // `src/server/app.ts`'s merge logic is the primary guard (it 400s before this schema
    // even runs), but this catches every other path into `saveConfig` too.
    cfg.arrs.forEach((arr, i) => {
      if (arr.apiKey === SECRET_PLACEHOLDER) {
        ctx.addIssue({
          code: 'custom',
          path: ['arrs', i, 'apiKey'],
          message: `"${SECRET_PLACEHOLDER}" is a placeholder, not a real secret — it must never be saved as one`,
        });
      }
    });
    for (const [key, value] of Object.entries(cfg.llm.keys)) {
      if (value === SECRET_PLACEHOLDER) {
        ctx.addIssue({
          code: 'custom',
          path: ['llm', 'keys', key],
          message: `"${SECRET_PLACEHOLDER}" is a placeholder, not a real secret — it must never be saved as one`,
        });
      }
    }

    // Arr instance names double as the key into `ctx.clients` (`Map<string, ArrApi>`) and
    // the job queue's `arr_instance` column — a duplicate silently clobbers one instance's
    // client/config with another's rather than failing loudly, so it's rejected here.
    const seen = new Set<string>();
    cfg.arrs.forEach((arr, i) => {
      if (seen.has(arr.name)) {
        ctx.addIssue({ code: 'custom', path: ['arrs', i, 'name'], message: `duplicate arr instance name "${arr.name}"` });
      } else {
        seen.add(arr.name);
      }
    });
  });
export type Config = z.infer<typeof ConfigSchema>;
export type ArrInstance = z.infer<typeof ArrInstanceSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
