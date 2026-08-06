import { z } from 'zod';

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
export const ConfigSchema = z.object({
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
          openrouter: z.string().optional(),
          openai: z.string().optional(),
          anthropic: z.string().optional(),
        })
        .default(() => ({})),
    })
    .prefault({}),
  reconcileIntervalMinutes: z.number().default(15),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ArrInstance = z.infer<typeof ArrInstanceSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
