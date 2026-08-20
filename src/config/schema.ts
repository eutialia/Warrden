import { z } from 'zod';

const ProviderSchema = z.enum(['openrouter']);
// Optional on a model: not every model accepts every level, and leaving it unset means the
// request carries no reasoning field at all, so the model's own default stands. That default
// is not "no thinking" on models that reason by default, which is what 'none' is for: it
// sends an explicit off switch rather than omitting the field.
const EffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LlmModelSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  effort: EffortSchema.optional(),
});
const ArrInstanceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['sonarr', 'radarr']),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
});
const SubtitleSiteSchema = z.object({
  // The base URL is the site's identity: unique by construction, where the name beside it
  // used to be a second identity nothing enforced. `siteLabel()` derives what to show.
  baseUrl: z.url(),
  // Search page URL with `{query}` where the URL-encoded search term goes. Optional:
  // without it the agent must discover the search endpoint itself (recorded into the
  // site profile's search_url_patterns on success).
  searchUrlTemplate: z.string().min(1).optional(),
});
export type SubtitleSiteConfig = z.infer<typeof SubtitleSiteSchema>;
const LlmKeysSchema = z
  .object({
    openrouter: z.string().min(1).optional(),
  })
  .default(() => ({}));
// The one model every call-site runs on. Optional: a fresh install has no provider
// configured, and `resolveModel` turns that into a clear error at the first call.
const LlmSchema = z.object({ model: LlmModelSchema.optional(), keys: LlmKeysSchema }).prefault({});
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
    // is the same shared reference across parses. Any default with nested structure
    // needs the factory form; used uniformly here so the safety is structural rather
    // than case-by-case.
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(9797),
        publicUrl: z.url().default('http://localhost:9797'), // webhook address advertised to the arrs; first boot overwrites via defaultPublicUrl
      })
      .prefault({}),
    arrs: z.array(ArrInstanceSchema).default(() => []),
    // `.min(1)` on both sides: a blank `from`/`to` can never map anything and would silently
    // no-op `mapArrPath` for every path it's checked against — reject it rather than let a
    // half-filled row (e.g. one left over from a UI "Add" click) save as valid.
    pathMappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default(() => []),
    picking: z
      .object({
        prefer: z.array(z.string()).default(() => []),
        avoid: z.array(z.string()).default(() => []),
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
        // Legacy/test override only. Empty = use the four standard mounts
        // (/tv, /anime, /movies, /downloads — see `standardMounts.ts`). The web UI never edits this.
        // `.min(1)` per entry: a blank marker would trivially "exist" as a no-op check.
        mountMarkers: z.array(z.string().min(1)).default(() => []),
        // Legacy/test override only. Empty = derive from pathMappings targeting the
        // standard Downloads mount, else `/downloads`. The web UI never edits this.
        // `.min(1)` per entry: a blank root would match every path's longest-prefix check
        // in `resolveSourceDirsDetailed`, corrupting bundle rescue.
        downloadRoots: z.array(z.string().min(1)).default(() => []),
      })
      .prefault({}),
    subtitle: z
      .object({
        // Target languages, most-wanted first (e.g. ['zh-Hans', 'zh-Hant']). An episode
        // "has subs" when it carries EVERY one of these as an embedded or external track.
        languages: z.array(z.string().min(1)).default(() => []),
        // Soft rank boost for fansub/release groups when browsing packs — never exclusive;
        // if none of these appear, the agent keeps searching other groups (design decision
        // log 2026-08-08). Same spirit as acquire pins, but not a hard filter.
        preferredGroups: z.array(z.string().min(1)).default(() => []),
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
    llm: LlmSchema,
    reconcileIntervalMinutes: z.number().int().min(1).default(15),
    /** How long the event log is kept. `0` means keep everything, for anyone who would
     * rather grow a table than lose the history. The dashboard offers a fixed set of
     * spans; the schema takes any non-negative number so a hand-edited config stays
     * valid. */
    eventRetentionDays: z.number().int().min(0).default(30),
    debug: z
      .object({
        enabled: z.boolean().default(false),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
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
/**
 * `ConfigSchema`, but tolerant of an `llm.model` it can't make sense of. Used by `loadConfig`
 * and nowhere else: a config.json carrying a value this build no longer knows (a dropped
 * provider like `claude-code`, a blank id) would otherwise fail at boot, and a server that
 * won't start can't serve the settings UI that would fix it. Degrading lands on the same
 * documented unset state, AI features off, editable from the UI.
 *
 * A `PUT /api/config` body gets no such mercy: there the operator is right there watching,
 * and a 400 naming the field beats a green toast over a silently dropped model.
 */
export const BootConfigSchema = ConfigSchema.safeExtend({
  llm: z.object({ model: LlmModelSchema.optional().catch(undefined), keys: LlmKeysSchema }).prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ArrInstance = z.infer<typeof ArrInstanceSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Effort = z.infer<typeof EffortSchema>;
