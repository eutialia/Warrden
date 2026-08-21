import { z } from 'zod';
import type { Config } from '../config/schema.js';
import { errorMessage } from '../util/errors.js';

const PUBLIC_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const USER_MODELS_URL = 'https://openrouter.ai/api/v1/models/user';

// OpenRouter's own edge cache is `max-age=300, stale-while-revalidate=3600`; refreshing
// more often than that gains nothing but extra load on their API.
const TTL_MS = 10 * 60 * 1000;

/**
 * `reasoning` is the one field that's genuinely inconsistent across upstream model
 * entries: absent/null for a non-reasoning model, present with `supported_efforts` for a
 * tiered one, or present with only `mandatory` for a boolean-only one. Every field here is
 * optional/nullable on purpose: this schema's job is to accept whatever shape shows up,
 * not to enforce one.
 */
const UpstreamReasoningSchema = z
  .object({
    mandatory: z.boolean().optional(),
    default_enabled: z.boolean().optional(),
    supported_efforts: z.array(z.string()).optional(),
    default_effort: z.string().optional(),
  })
  .loose()
  .nullable()
  .optional();

// `.loose()` so unknown/extra upstream fields (architecture, per_request_limits, ...)
// round-trip harmlessly instead of tripping strict-object validation. Pricing values are
// strings upstream (e.g. "0.0000014"), not numbers.
const UpstreamModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    context_length: z.number().optional().catch(undefined),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
      })
      .loose()
      .optional()
      .catch(undefined),
    top_provider: z
      .object({
        context_length: z.number().optional(),
      })
      .loose()
      .optional()
      .catch(undefined),
    reasoning: UpstreamReasoningSchema,
    supported_parameters: z.array(z.string()).optional().catch(undefined),
  })
  .loose();

const UpstreamResponseSchema = z.object({
  data: z.array(z.unknown()),
});

export type UpstreamModel = z.infer<typeof UpstreamModelSchema>;

/**
 * How a model can be made to answer in JSON, worst case:
 * - `native`: the endpoint declares `structured_outputs`, so a `json_schema` response_format
 *   is honoured and the schema is enforced upstream.
 * - `json_object`: it declares `response_format` but not `structured_outputs`. Asking for
 *   `json_schema` gets every endpoint filtered out by `require_parameters` (a 404 from
 *   OpenRouter, not a fallback), so the schema has to travel in the prompt instead.
 * - `none`: neither is declared, so no response_format may be sent at all.
 */
export type StructuredOutputTier = 'native' | 'json_object' | 'none';

/** The slice of a `CatalogModel` that shapes an outgoing generation request. */
export interface ModelCapabilities {
  structuredOutput: StructuredOutputTier;
  mandatoryReasoning: boolean;
}

/** Missing `supported_parameters` means upstream told us nothing, not that the model is
 * limited: assume the full-fat path rather than degrading every request on absent data. */
function structuredOutputTier(supported: string[] | undefined): StructuredOutputTier {
  if (supported === undefined) return 'native';
  if (supported.includes('structured_outputs')) return 'native';
  return supported.includes('response_format') ? 'json_object' : 'none';
}

/** The trimmed shape the dashboard actually consumes: everything the UI needs to render a
 * model picker (with a reasoning-effort selector where applicable) and nothing else. */
export interface CatalogModel {
  id: string;
  name: string;
  supportedEfforts: string[];
  defaultEffort?: string;
  mandatoryReasoning: boolean;
  /** True whenever upstream describes reasoning at all, tiers or not. Without it an empty
   * `supportedEfforts` would read the same for a model that cannot reason and one that
   * reasons but takes no effort tiers, and those two need different picker rows. */
  reasoningCapable: boolean;
  structuredOutput: StructuredOutputTier;
  contextLength: number;
  pricing: { prompt: string; completion: string };
}

export interface CatalogResult {
  models: CatalogModel[];
  stale: boolean;
  fetchedAt: number;
}

/** Thrown for a non-2xx response from either OpenRouter models endpoint. The status is
 * folded into the message rather than kept as a field: every failure takes the same
 * fallback path, so nothing branches on it. */
export class CatalogFetchError extends Error {
  constructor(status: number, body: string) {
    super(`OpenRouter models request failed: ${status} ${body}`);
    this.name = 'CatalogFetchError';
  }
}

/** Drops the literal "none" tier: the UI treats "no reasoning effort" as the absence of a
 * selection, not as a tier a model "supports". */
function projectModel(m: UpstreamModel): CatalogModel {
  const reasoning = m.reasoning ?? null;
  const supportedEfforts = (reasoning?.supported_efforts ?? []).filter((e) => e !== 'none');
  return {
    id: m.id,
    name: m.name,
    supportedEfforts,
    ...(reasoning?.default_effort !== undefined ? { defaultEffort: reasoning.default_effort } : {}),
    mandatoryReasoning: reasoning?.mandatory === true,
    reasoningCapable: reasoning !== null,
    structuredOutput: structuredOutputTier(m.supported_parameters),
    // top_provider.context_length is the effective ceiling for the account's own request
    // limits; context_length is the model's raw training window. Prefer the former, fall
    // back to the latter, then 0 rather than an undefined the UI would have to guard.
    contextLength: m.top_provider?.context_length ?? m.context_length ?? 0,
    pricing: {
      prompt: m.pricing?.prompt ?? '0',
      completion: m.pricing?.completion ?? '0',
    },
  };
}

/** Parses the raw `{ data: [...] }` body into projected models, dropping (not throwing on)
 * any entry that doesn't match `UpstreamModelSchema`, because one malformed model must not fail
 * the whole batch. */
function parseCatalog(body: unknown): CatalogModel[] {
  const response = UpstreamResponseSchema.parse(body);
  const models: CatalogModel[] = [];
  for (const raw of response.data) {
    const parsed = UpstreamModelSchema.safeParse(raw);
    if (parsed.success) models.push(projectModel(parsed.data));
  }
  return models;
}

async function fetchCatalog(url: string, apiKey?: string): Promise<CatalogModel[]> {
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    throw new CatalogFetchError(res.status, await res.text().catch(() => ''));
  }
  return parseCatalog(await res.json());
}

/**
 * Fetches and caches OpenRouter's model list. In-memory, 10 minute TTL (see `TTL_MS`).
 *
 * Selection: with an OpenRouter key configured, calls the account-scoped `/models/user`
 * (only the models that key can actually reach); on any failure from that call, 401 or
 * otherwise, falls back to the public `/models`. With no key, goes straight to public.
 *
 * On a fetch failure with a warm cache, serves the last good list marked `stale: true`
 * rather than surfacing the error, since a transient OpenRouter outage shouldn't blank out a
 * model picker that was working a minute ago. Only a cold cache (nothing fetched yet)
 * propagates the error.
 *
 * `now` is injected (not read via `Date.now()` inline) so tests can drive TTL expiry with
 * a fake clock, same idiom as `cachedStorage` (`src/server/storageHealth.ts`).
 */
export class ModelCatalog {
  private cache: { models: CatalogModel[]; fetchedAt: number } | null = null;

  constructor(
    private readonly getCfg: () => Config,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<CatalogResult> {
    const nowMs = this.now();
    if (this.cache && nowMs - this.cache.fetchedAt < TTL_MS) {
      return { models: this.cache.models, stale: false, fetchedAt: this.cache.fetchedAt };
    }

    try {
      const models = await this.fetchFresh();
      this.cache = { models, fetchedAt: nowMs };
      return { models, stale: false, fetchedAt: nowMs };
    } catch (err) {
      if (this.cache) {
        return { models: this.cache.models, stale: true, fetchedAt: this.cache.fetchedAt };
      }
      throw new Error(`Failed to fetch OpenRouter model catalog (no cached list to fall back on): ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * One model's request-shaping capabilities, off the same cache `list()` serves.
   *
   * Never throws and never rejects: this sits in front of every generation, and a catalog
   * that's unreachable (or a model id upstream doesn't list, e.g. one typed into config by
   * hand) must not be the reason a generation fails. `undefined` means "nothing known",
   * which callers read as the native path.
   */
  async capabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    const models = await this.list().then(
      (r) => r.models,
      () => [] as CatalogModel[],
    );
    const model = models.find((m) => m.id === modelId);
    if (!model) return undefined;
    return { structuredOutput: model.structuredOutput, mandatoryReasoning: model.mandatoryReasoning };
  }

  private async fetchFresh(): Promise<CatalogModel[]> {
    const apiKey = this.getCfg().llm.keys.openrouter;
    if (!apiKey) {
      return fetchCatalog(PUBLIC_MODELS_URL);
    }
    try {
      return await fetchCatalog(USER_MODELS_URL, apiKey);
    } catch {
      // Any failure from the account-scoped endpoint (401, rate limit, network) falls
      // back to the public list rather than leaving the operator with nothing.
      return fetchCatalog(PUBLIC_MODELS_URL);
    }
  }
}
