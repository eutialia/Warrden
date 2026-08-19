import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { APICallError, generateObject, InvalidPromptError, NoObjectGeneratedError } from 'ai';
import type { z } from 'zod';
import type { Config, Effort, Provider } from '../config/schema.js';
import { NOOP_HANDLE, NOOP_TRACER, type StepHandle, type Tracer } from '../trace/tracer.js';
import { errorMessage } from '../util/errors.js';
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
 * mutually-referencing cause chain can't spin.
 */
function isPermanentProviderError(err: unknown): boolean {
  const pending: unknown[] = [err];
  for (let seen = 0; seen < 5 && pending.length > 0; seen++) {
    const e = pending.shift();
    if (typeof e !== 'object' || e === null) continue;
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

/**
 * Builds the AI SDK language model for a resolved model, keyed from `cfg.llm.keys`.
 *
 * Reasoning effort rides on `extraBody` rather than the provider's typed
 * `providerOptions.openrouter.reasoning`: that type omits `'max'`, which the live API accepts
 * on 40+ models. `extraBody` is merged into the request body verbatim (and before call-level
 * providerOptions), so prompt-cache options set per call survive alongside it.
 */
function createModel(cfg: Config, ref: ModelRef, callsite: string): LanguageModel {
  const apiKey = cfg.llm.keys.openrouter;
  if (!apiKey) {
    // Keys come from `cfg.llm.keys` only (not the provider SDK's own env-var fallback) so
    // config.json stays the single source of truth for credentials.
    throw new LlmError('Missing API key for provider "openrouter" (llm.keys.openrouter)', callsite);
  }
  return createOpenRouter({ apiKey })(ref.model, reasoningSettings(ref.effort));
}

/**
 * Omitting `reasoning` is not the same as switching reasoning off: a model whose reasoning is
 * enabled by default still thinks (and bills for it) when the field is absent, so 'none' has
 * to send the explicit `enabled: false` toggle instead.
 */
function reasoningSettings(effort?: Effort): { extraBody?: Record<string, unknown> } {
  if (effort === undefined) return {};
  const reasoning = effort === 'none' ? { enabled: false } : { effort };
  // require_parameters keeps OpenRouter from routing to a provider that silently drops
  // the reasoning field: observed live as "effort high, 0 reasoning tokens" on a route
  // that ignored it.
  return { extraBody: { reasoning, provider: { require_parameters: true } } };
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
 */
export function buildGenerateOptions<T>(opts: GenerateOpts<T>, cache: PromptCachePlan) {
  return {
    schema: opts.schema,
    instructions: cache.systemProviderOptions
      ? { role: 'system' as const, content: opts.system, providerOptions: cache.systemProviderOptions }
      : opts.system,
    messages: [{ role: 'user' as const, content: opts.prompt }],
    ...(cache.callProviderOptions ? { providerOptions: cache.callProviderOptions } : {}),
    // Our own `withRetry` owns the retry count; the AI SDK's default internal retries would
    // otherwise multiply each attempt into up to 3 provider calls of its own.
    maxRetries: 0,
  };
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
    private readonly onEffortIgnored?: (info: { callsite: string; model: string; effort: Effort }) => void,
  ) {}

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    const model = resolveModel(this.getCfg());
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
      const result = await withRetry(() => this.attemptOnce(opts, model, call));
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

  private async attemptOnce<T>(opts: GenerateOpts<T>, ref: ModelRef, call: StepHandle): Promise<T> {
    const attempt: StepHandle = opts.trace
      ? this.trace.begin({
          jobId: opts.trace.jobId,
          parentSeq: call.seq ?? opts.trace.parentSeq,
          kind: 'llm.attempt',
          summary: `${ref.provider}/${ref.model}`,
        })
      : NOOP_HANDLE;
    try {
      const model = createModel(this.getCfg(), ref, opts.callsite);
      const cache = planPromptCache(opts.promptCache === true);
      const result = await generateObject({ model, ...buildGenerateOptions(opts, cache) });
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
      // nothing either way.
      if (ref.effort !== undefined && ref.effort !== 'none' && result.usage?.outputTokenDetails?.reasoningTokens === 0) {
        this.onEffortIgnored?.({ callsite: opts.callsite, model: ref.model, effort: ref.effort });
      }
      return result.object;
    } catch (err) {
      attempt.end('error', () => ({ provider: ref.provider, model: ref.model, error: errorMessage(err) }));
      throw err;
    }
  }
}
