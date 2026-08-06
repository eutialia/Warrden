import { z } from 'zod';

/** Placeholder `GET /api/config` (`src/server/app.ts`) substitutes for every secret value
 * (`llm.keys.*`, `arrs[].apiKey`) instead of the real one. Exported so the API layer (which
 * restores it back to the stored secret on `PUT`, and rejects it outright when there's
 * nothing stored to restore from — a renamed or brand-new arr instance) and this schema
 * (which refuses to ever accept it as a literal saved value, as a second line of defense)
 * share the one definition instead of duplicating the character. */
export const SECRET_PLACEHOLDER = '•••';

export const ProviderSchema = z.enum(['openrouter', 'openai', 'anthropic', 'claude-code']);
export const CallsiteModelSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  fallback: z.object({ provider: ProviderSchema, model: z.string().min(1) }).optional(),
});
export const ArrInstanceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['sonarr', 'radarr']),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
});
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
        port: z.number().int().default(9797),
        publicUrl: z.url().default('http://localhost:9797'), // used for webhook registration
      })
      .prefault({}),
    arrs: z.array(ArrInstanceSchema).default(() => []),
    pathMappings: z.array(z.object({ from: z.string(), to: z.string() })).default(() => []),
    picking: z
      .object({
        tags: z.array(z.string()).default(() => []),
        seederFloor: z.number().int().default(3),
        minSizeMB: z.number().default(50),
        maxSizeMB: z.number().default(60000),
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
    reconcileIntervalMinutes: z.number().default(15),
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
