import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { APICallError, generateObject, InvalidPromptError, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import type { Config, Effort, Provider } from '../config/schema.js';
import { NOOP_HANDLE, NOOP_TRACER, type StepHandle, type Tracer } from '../trace/tracer.js';
import { errorMessage } from '../util/errors.js';
import type { ModelCapabilities, StructuredOutputTier } from './catalog.js';
import { type PromptCachePlan, planPromptCache } from './promptCache.js';

export interface GenerateOpts<T> {
  callsite: string; // e.g. 'release-pick'
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /**
   * Opt into prompt caching for multi-step loops (site-search) where the system prefix is
   * stable and the user half grows. See `planPromptCache` for what that means per route.
   */
  promptCache?: boolean;
  /** Opt into tracing this call: written under `jobId`, nested under `parentSeq` if given. */
  trace?: { jobId: number; parentSeq?: number };
}

export interface StructuredGenerator {
  generate<T>(opts: GenerateOpts<T>): Promise<T>;
}

export class LlmError extends Error {
  /** Read by the job runner (`isPermanentError`) to fail a job terminally instead of
   * retrying an error that can only fail the same way again. */
  public readonly permanent: boolean;

  constructor(
    msg: string,
    public callsite: string,
    options?: ErrorOptions & { permanent?: boolean },
  ) {
    super(msg, options);
    this.name = 'LlmError';
    this.permanent = options?.permanent ?? false;
  }
}

/**
 * Whether the failure can never succeed on a retry: a 4xx the provider already rejected the
 * request with (408/429 are the transient ones), a prompt the SDK itself refuses to send, or
 * a model that failed structured output on both in-call attempts. Retrying those costs a
 * full job re-run (for the acquire pipeline, another sweep of every indexer) to arrive at
 * the identical rejection.
 *
 * Traverses `cause` links AND `AggregateError.errors`, because `withRetry` parks the first
 * attempt's failure in an `AggregateError` on the last one's `cause`: a permanent error can
 * therefore sit either at the top or one hop into that aggregate. Bounded so a self- or
 * mutually-referencing cause chain can't spin. The bound counts real error nodes only, since
 * every node queues its own `cause` and the `undefined` ones at the end of each chain would
 * otherwise burn the budget before the error one hop further in is ever looked at.
 */
function isPermanentProviderError(err: unknown): boolean {
  const pending: unknown[] = [err];
  let seen = 0;
  while (seen < 5 && pending.length > 0) {
    const e = pending.shift();
    if (typeof e !== 'object' || e === null) continue;
    seen++;
    if (InvalidPromptError.isInstance(e) || NoObjectGeneratedError.isInstance(e)) return true;
    if (APICallError.isInstance(e) && isPermanentStatus(e.statusCode)) return true;
    if (e instanceof AggregateError) pending.push(...e.errors);
    pending.push((e as Error).cause);
  }
  return false;
}

function isPermanentStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A resolved provider + model id, as configured under `llm.model`. */
export interface ModelRef {
  provider: Provider;
  model: string;
  effort?: Effort;
  /** Operator-pinned request shape, overriding the catalog's for this model. */
  structuredOutput?: StructuredOutputTier;
}

/**
 * Resolves the one configured model from `cfg.llm.model`: every call-site runs on it.
 * Throws `LlmError` when nothing is configured (a fresh install, and the switch that keeps
 * every LLM feature off until an operator opts in). Returns a copy, not the live config
 * object, so callers can't accidentally mutate `cfg` through it.
 */
export function resolveModel(cfg: Config): ModelRef {
  const entry = cfg.llm.model;
  if (!entry) {
    throw new LlmError('No LLM model configured (set llm.model in settings)', 'llm.model');
  }
  return { ...entry };
}

/**
 * Runs `attempt`, retrying it once on failure. Throws the last error once both attempts
 * are exhausted. AI-SDK-free so the retry is unit-testable on its own. Not pure, though:
 * on total failure it mutates the thrown error's `cause` (see below).
 *
 * The first attempt's error is collected and, when the last one is an `Error` without a
 * `cause` of its own, attached as an `AggregateError` on its `cause`, so a second failure
 * with a less informative message doesn't silently mask what the first one actually failed
 * with. The thrown value is still exactly the last error (same reference, same type); only
 * its `cause` gains this extra context. The last error itself is excluded from that
 * `AggregateError`: it's already the thrown value, so including it too would make it
 * reference itself via `cause`.
 */
export async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let firstError: unknown;
  try {
    return await attempt();
  } catch (err) {
    firstError = err;
  }

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Error && err.cause === undefined) {
      err.cause = new AggregateError([firstError], 'preceding attempts');
    }
    throw err;
  }
}

/** Looks up what one model id can be asked for, `undefined` when nothing is known about it
 * (see `ModelCatalog.capabilities`). Injected as a function rather than the catalog itself so
 * a test can hand over one line instead of a fetch stub. */
export type CapabilityLookup = (modelId: string) => Promise<ModelCapabilities | undefined>;

/**
 * Builds the AI SDK language model for a resolved model, keyed from `cfg.llm.keys`.
 *
 * Reasoning effort rides on `extraBody` rather than the provider's typed
 * `providerOptions.openrouter.reasoning`: that type omits `'max'`, which the live API accepts
 * on 40+ models. `extraBody` is merged into the request body verbatim (and before call-level
 * providerOptions), so prompt-cache options set per call survive alongside it.
 */
function createModel(
  cfg: Config,
  ref: ModelRef,
  tier: StructuredOutputTier,
  capabilitiesKnown: boolean,
  callsite: string,
): LanguageModel {
  const apiKey = cfg.llm.keys.openrouter;
  if (!apiKey) {
    // Keys come from `cfg.llm.keys` only (not the provider SDK's own env-var fallback) so
    // config.json stays the single source of truth for credentials.
    throw new LlmError('Missing API key for provider "openrouter" (llm.keys.openrouter)', callsite);
  }
  return createOpenRouter({ apiKey })(ref.model, modelSettings(ref.effort, tier, capabilitiesKnown));
}

/** The three independent halves of the request body this build overrides, merged into the one
 * `extraBody` the provider accepts. Each can be empty; only when all are does the model get no
 * settings at all, which is what a no-effort call on an unknown model must still send.
 * `capabilitiesKnown` says whether the catalog answered for this model id at all (see
 * `routingGuardBody`). Exported so a test can put the exact production settings on a real
 * provider instance and read what they serialize to. */
export function modelSettings(
  effort: Effort | undefined,
  tier: StructuredOutputTier,
  capabilitiesKnown: boolean,
): { extraBody?: Record<string, unknown> } {
  const extraBody = { ...reasoningBody(effort), ...responseFormatBody(tier), ...routingGuardBody(effort, tier, capabilitiesKnown) };
  return Object.keys(extraBody).length > 0 ? { extraBody } : {};
}

/**
 * Omitting `reasoning` is not the same as switching reasoning off: a model whose reasoning is
 * enabled by default still thinks (and bills for it) when the field is absent, so 'none' has
 * to send the explicit `enabled: false` toggle instead.
 */
function reasoningBody(effort?: Effort): Record<string, unknown> {
  if (effort === undefined) return {};
  return { reasoning: effort === 'none' ? { enabled: false } : { effort } };
}

/**
 * require_parameters keeps OpenRouter from routing to an endpoint that silently drops a
 * parameter the request asked for: observed live as "effort high, 0 reasoning tokens" on a route
 * that ignored the reasoning field, and the same silent drop turns a `json_object` ask into
 * plain prose. It cuts both ways, since the filter can also leave no endpoint at all and
 * OpenRouter answers 404, which the job runner classifies permanent.
 *
 * So the flag is an assertion about what the routed endpoint declares, and it is only made when
 * the catalog actually declared something. Unknown capabilities (catalog unreachable, or a model
 * id upstream doesn't list) means the tier fallback to `native` is a guess: pairing a guess with
 * require_parameters is what produced the 404 this tiering exists to avoid, and unguarded but
 * functional beats terminally failed.
 *
 * With capabilities in hand, the flag rides on there being something droppable to protect: a
 * configured effort, or any tier that still sends a response_format. The `none` tier with no
 * effort asks for neither, so guarding there would only shrink the endpoint pool for nothing.
 */
function routingGuardBody(effort: Effort | undefined, tier: StructuredOutputTier, capabilitiesKnown: boolean): Record<string, unknown> {
  if (!capabilitiesKnown) return {};
  if (effort === undefined && tier === 'none') return {};
  return { provider: { require_parameters: true } };
}

/**
 * `generateObject` always asks for `response_format: {type: 'json_schema'}`, which under
 * `require_parameters` drops every endpoint that doesn't declare `structured_outputs`. For a
 * model like `stealth/ox-alpha`, whose only endpoint declares `response_format` alone, that is
 * every endpoint it has. So the ask is narrowed to what the endpoint actually declares and the
 * schema moves into the prompt (`schemaAppendix`) to make up the difference.
 *
 * `extraBody` is spread over the composed body inside the provider, so these win over the
 * `json_schema` the SDK put there. For `none` the key has to be absent, not null: an
 * `undefined` value survives the spread and is then dropped by `JSON.stringify`.
 */
function responseFormatBody(tier: StructuredOutputTier): Record<string, unknown> {
  switch (tier) {
    case 'native':
      return {};
    case 'json_object':
      return { response_format: { type: 'json_object' } };
    case 'none':
      return { response_format: undefined };
  }
}

/**
 * The schema restated in the system prompt, for the tiers where no provider will enforce it.
 * Deterministic (a pure projection of the schema at a fixed indent) so a `promptCache` loop's
 * system prefix stays byte-identical across steps and keeps hitting the cache breakpoint.
 */
function schemaAppendix(schema: z.ZodType<unknown>): string {
  return [
    'Reply with a single JSON object and nothing else: no prose, no code fence, no trailing commentary.',
    'The object must validate against this JSON Schema:',
    JSON.stringify(z.toJSONSchema(schema), null, 2),
  ].join('\n');
}

/**
 * The last line of the user half where no provider enforces the schema. The schema dump says
 * what the object must contain; this says that the answer is the object and nothing else,
 * which is the part ox-alpha kept losing between a long system prompt and its reply. No worked
 * example goes with it — the schema already shows the shape, and a second one only costs
 * tokens on every step of a 20-step loop.
 */
const JSON_ONLY_CONTRACT =
  'Answer with the JSON object only. It starts with { and ends with }. No code fence, no commentary.';

/**
 * Pulls a bare JSON object out of what a model actually sent when the prompt was the only
 * thing holding it to the schema: every fence marker goes, wherever it sits, and what is left
 * is cut from its first `{` to its last `}`.
 *
 * Nothing here is anchored, because the live failures were not. Job 75 came back with a
 * ```html fence spliced into the middle of a url string — twice, identically — which an
 * anchored strip left exactly as broken as it arrived. Returns null when no object survives,
 * which the SDK reads as "no repair": for job 74's page of transcript prose, letting the
 * original parse error stand is the honest answer.
 *
 * Pure and exported so the shapes can be tested without a model in the loop.
 */
export function repairObjectText(text: string): string | null {
  // One pattern covers both ends: the language tag is optional, so a bare closing ``` matches
  // it too, and the newline after an opening fence goes with the marker.
  const stripped = text.replace(/```[a-zA-Z]*[ \t]*\r?\n?/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const out = stripped.slice(start, end + 1);
  return out === text ? null : out;
}

/** `repairObjectText` in the shape the AI SDK's repair hook takes. */
async function repairText({ text }: { text: string }): Promise<string | null> {
  return repairObjectText(text);
}

/**
 * The `generateObject` options for one call, model aside.
 *
 * The system half rides on `instructions`, not a `role: 'system'` entry in `messages`: AI SDK
 * v7 validates the prompt client-side and rejects that shape before any request is sent.
 * `instructions` still takes a full `SystemModelMessage`, so the prompt-cache breakpoint that
 * used to hang off the system message survives the move.
 *
 * Extracted from `attemptOnce` so a test can hand the real SDK the exact shape production
 * sends. Tests that mock `generateObject` skip that validation entirely and would pass on a
 * prompt the SDK refuses.
 *
 * Below the `native` tier the provider enforces nothing, so the schema is restated in the
 * system half: the `schema` option still governs parsing here, it just no longer reaches the
 * endpoint as a constraint. It trails the caller's own system text, and the user half closes
 * with `JSON_ONLY_CONTRACT` — the two things a model reads last are then both about shape.
 *
 * Those same tiers get `repairText`: a model held to the schema by nothing but the prompt
 * still fences its answer or leads with a sentence often enough that the alternative is a
 * `NoObjectGeneratedError` and a second full-price call to ask again.
 */
export function buildGenerateOptions<T>(opts: GenerateOpts<T>, cache: PromptCachePlan, tier: StructuredOutputTier) {
  const system = tier === 'native' ? opts.system : `${opts.system}\n\n${schemaAppendix(opts.schema)}`;
  const prompt = tier === 'native' ? opts.prompt : `${opts.prompt}\n\n${JSON_ONLY_CONTRACT}`;
  return {
    schema: opts.schema,
    instructions: cache.systemProviderOptions
      ? { role: 'system' as const, content: system, providerOptions: cache.systemProviderOptions }
      : system,
    messages: [{ role: 'user' as const, content: prompt }],
    ...(cache.callProviderOptions ? { providerOptions: cache.callProviderOptions } : {}),
    // Only where nothing but the prompt asks for JSON. A native-tier endpoint that returns a
    // fence has a real problem worth surfacing, and the hook would hide it.
    ...(tier === 'native' ? {} : { repairText }),
    // Our own `withRetry` owns the retry count; the AI SDK's default internal retries would
    // otherwise multiply each attempt into up to 3 provider calls of its own.
    maxRetries: 0,
  };
}

/** What `AiSdkGenerator` reports when a requested reasoning effort came back unused. `route`
 * is the upstream provider OpenRouter actually picked (`providerMetadata.openrouter.provider`,
 * empty-string when the response carried none), `undefined` when nothing named one: the only
 * actionable half of the warning, since the model id alone doesn't say who dropped the field. */
export interface EffortIgnoredInfo {
  callsite: string;
  model: string;
  effort: Effort;
  route: string | undefined;
}

/**
 * What a failed parse leaves behind, for the trace payload. `errorMessage` alone reports that
 * the answer didn't validate and nothing about the answer, so a route that mangles its own
 * output reads exactly like a model that rambled. Empty for every other kind of failure,
 * which has no generated text to show.
 */
function parseFailureDetail(err: unknown): Record<string, unknown> {
  if (!NoObjectGeneratedError.isInstance(err)) return {};
  return { text: err.text, finishReason: err.finishReason, usage: err.usage };
}

/** The routed upstream provider out of one `generateObject` result's provider metadata. */
function routeOf(providerMetadata: unknown): string | undefined {
  const openrouter = (providerMetadata as { openrouter?: { provider?: unknown } } | undefined)?.openrouter;
  const provider = openrouter?.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined;
}

/** `StructuredGenerator` backed by the Vercel AI SDK, running every call-site on the one
 * configured model. Takes a getter rather than a `Config` so the model and API keys are
 * read fresh on every call: a `PUT /api/config` swaps `ctx.config` wholesale, and a
 * snapshot captured here at construction would keep serving the old one for the life of
 * the process. */
export class AiSdkGenerator implements StructuredGenerator {
  constructor(
    private readonly getCfg: () => Config,
    private readonly trace: Tracer = NOOP_TRACER,
    private readonly onEffortIgnored?: (info: EffortIgnoredInfo) => void,
    /** Defaults to knowing nothing, which is the native path: an unwired generator behaves
     * exactly as it did before tiering existed. */
    private readonly lookupCapabilities: CapabilityLookup = async () => undefined,
  ) {}

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    const model = resolveModel(this.getCfg());
    const capabilities = await this.lookupCapabilities(model.model);
    const call: StepHandle = opts.trace
      ? this.trace.begin({
          jobId: opts.trace.jobId,
          parentSeq: opts.trace.parentSeq,
          kind: 'llm.call',
          summary: `${opts.callsite} via ${model.provider}/${model.model}`,
          payload: () => ({ system: opts.system, prompt: opts.prompt }),
        })
      : NOOP_HANDLE;
    try {
      const result = await withRetry(() => this.attemptOnce(opts, model, capabilities, call));
      call.end('ok');
      return result;
    } catch (err) {
      // Carries system+prompt through: `end` REPLACES the payload written at begin, so a
      // failed call would otherwise lose the very inputs you need to debug it.
      call.end('error', () => ({ system: opts.system, prompt: opts.prompt, error: errorMessage(err) }));
      if (err instanceof LlmError) throw err;
      const message = errorMessage(err);
      throw new LlmError(`Generation failed for callsite "${opts.callsite}": ${message}`, opts.callsite, {
        cause: err,
        permanent: isPermanentProviderError(err),
      });
    }
  }

  private async attemptOnce<T>(
    opts: GenerateOpts<T>,
    ref: ModelRef,
    capabilities: ModelCapabilities | undefined,
    call: StepHandle,
  ): Promise<T> {
    // A pinned tier wins outright: it exists for the models whose declared shape is wrong, so
    // deferring to the catalog there would defeat it. Nothing known at all falls back to the
    // shape that works for the 336 models declaring structured_outputs. Safe only because
    // `routingGuardBody` refuses to assert require_parameters on a guess, and an override is
    // not catalog knowledge either: it says what to send, never what the endpoint declares.
    const tier = ref.structuredOutput ?? capabilities?.structuredOutput ?? 'native';
    const attempt: StepHandle = opts.trace
      ? this.trace.begin({
          jobId: opts.trace.jobId,
          parentSeq: call.seq ?? opts.trace.parentSeq,
          kind: 'llm.attempt',
          summary: `${ref.provider}/${ref.model}`,
        })
      : NOOP_HANDLE;
    try {
      const model = createModel(this.getCfg(), ref, tier, capabilities !== undefined, opts.callsite);
      const cache = planPromptCache(opts.promptCache === true);
      const result = await generateObject({ model, ...buildGenerateOptions(opts, cache, tier) });
      attempt.end('ok', () => ({
        provider: ref.provider,
        model: ref.model,
        request: result.request?.body,
        output: result.object,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        responseId: result.response?.id,
        responseModelId: result.response?.modelId,
        finishReason: result.finishReason,
        warnings: result.warnings,
      }));
      // A reported count of zero against a requested effort means the route answered without
      // reasoning at all; no count reported means the provider said nothing, which proves
      // nothing either way. A model that cannot have reasoning switched off is the exception:
      // ox-alpha returns a populated `reasoning` alongside `reasoning_tokens: 0`, so there the
      // zero is a reporting artefact and warning on it would cry wolf on every single call.
      if (
        ref.effort !== undefined &&
        ref.effort !== 'none' &&
        capabilities?.mandatoryReasoning !== true &&
        result.usage?.outputTokenDetails?.reasoningTokens === 0
      ) {
        // Swallowed deliberately: this attempt already succeeded and was already paid for, so
        // a reporting callback that throws must not escape into `withRetry` and buy a second
        // identical call.
        try {
          this.onEffortIgnored?.({ callsite: opts.callsite, model: ref.model, effort: ref.effort, route: routeOf(result.providerMetadata) });
        } catch {
          // nothing to report the reporter with
        }
      }
      return result.object;
    } catch (err) {
      attempt.end('error', () => ({ provider: ref.provider, model: ref.model, error: errorMessage(err), ...parseFailureDetail(err) }));
      throw err;
    }
  }
}
