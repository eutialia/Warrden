import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { generateObject } from 'ai';
import type { z } from 'zod';
import type { Config, Provider } from '../config/schema.js';
import { NOOP_HANDLE, NOOP_TRACER, type StepHandle, type Tracer } from '../trace/tracer.js';
import { errorMessage } from '../util/errors.js';
import { planPromptCache } from './promptCache.js';

export interface GenerateOpts<T> {
  callsite: string; // e.g. 'release-pick'
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /**
   * Opt into provider-aware prompt caching for multi-step loops (site-search) where the
   * system prefix is stable and the user half grows. Wiring differs by provider (see
   * `planPromptCache`) — not "Anthropic-only, ignore elsewhere".
   */
  promptCache?: boolean;
  /** Opt into tracing this call: written under `jobId`, nested under `parentSeq` if given. */
  trace?: { jobId: number; parentSeq?: number };
}

export interface StructuredGenerator {
  generate<T>(opts: GenerateOpts<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    msg: string,
    public callsite: string,
    options?: ErrorOptions,
  ) {
    super(msg, options);
    this.name = 'LlmError';
  }
}

/** A resolved provider + model id, as configured under `llm.model`. */
export interface ModelRef {
  provider: Provider;
  model: string;
}

/**
 * Resolves the one configured model, plus optional fallback, from `cfg.llm.model`: every
 * call-site runs on it. Throws `LlmError` when nothing is configured (a fresh install, and
 * the switch that keeps every LLM feature off until an operator opts in). Returns a copy,
 * not the live config object, so callers can't accidentally mutate `cfg` through it.
 */
export function resolveModel(cfg: Config): ModelRef & { fallback?: ModelRef } {
  const entry = cfg.llm.model;
  if (!entry) {
    throw new LlmError('No LLM model configured (set llm.model in settings)', 'llm.model');
  }
  return { ...entry, fallback: entry.fallback ? { ...entry.fallback } : undefined };
}

/**
 * Runs `attempt` against `primary`, retrying once on failure, then against `fallback`
 * (if configured), retrying once more on failure, in that order: primary, primary,
 * fallback, fallback. Throws the last error once every attempt is exhausted. AI-SDK-free
 * and generic over any `{provider, model}`-shaped ref (not just `ModelRef`'s strict
 * `Provider` union) so the retry/fallback ladder is unit-testable on its own — not pure,
 * though: on total failure it mutates the thrown error's `cause` (see below).
 *
 * Every *preceding* ladder attempt's error is collected and, when the last one is an
 * `Error` without a `cause` of its own, attached as an `AggregateError` on its `cause` —
 * so e.g. a keyless-fallback failure ("missing API key") doesn't silently mask what the
 * primary provider actually failed with. The thrown value is still exactly the last
 * error (same reference, same type); only its `cause` gains this extra context. The last
 * error itself is excluded from that `AggregateError` — it's already the thrown value,
 * so including it too would make it reference itself via `cause`.
 */
export async function withFallback<T, M extends { provider: string; model: string } = ModelRef>(
  attempt: (model: M) => Promise<T>,
  primary: M,
  fallback?: M,
): Promise<T> {
  const models = fallback ? [primary, primary, fallback, fallback] : [primary, primary];
  const errors: unknown[] = [];
  for (const model of models) {
    try {
      return await attempt(model);
    } catch (err) {
      errors.push(err);
    }
  }
  const lastError = errors[errors.length - 1];
  if (errors.length > 1 && lastError instanceof Error && lastError.cause === undefined) {
    lastError.cause = new AggregateError(errors.slice(0, -1), 'preceding ladder attempts');
  }
  throw lastError;
}

/** Builds the AI SDK language model for a resolved provider/model, keyed from `cfg.llm.keys`. */
function createModel(cfg: Config, ref: ModelRef, callsite: string): LanguageModel {
  switch (ref.provider) {
    case 'openrouter':
      return createOpenRouter({ apiKey: requireKey(cfg, 'openrouter', callsite) })(ref.model);
    case 'openai':
      return createOpenAI({ apiKey: requireKey(cfg, 'openai', callsite) })(ref.model);
    case 'anthropic':
      return createAnthropic({ apiKey: requireKey(cfg, 'anthropic', callsite) })(ref.model);
    default: {
      // Exhaustiveness check: fails to compile if `Provider` grows a case not handled above.
      const unreachable: never = ref.provider;
      throw new LlmError(`Unknown LLM provider "${String(unreachable)}"`, callsite);
    }
  }
}

// Keys come from `cfg.llm.keys` only (not provider SDKs' own env-var fallback) so config.json
// stays the single source of truth for credentials.
function requireKey(cfg: Config, provider: 'openrouter' | 'openai' | 'anthropic', callsite: string): string {
  const key = cfg.llm.keys[provider];
  if (!key) {
    throw new LlmError(`Missing API key for provider "${provider}" (llm.keys.${provider})`, callsite);
  }
  return key;
}

/** `StructuredGenerator` backed by the Vercel AI SDK, running every call-site on the one
 * configured model, with its optional fallback. */
export class AiSdkGenerator implements StructuredGenerator {
  constructor(
    private readonly cfg: Config,
    private readonly trace: Tracer = NOOP_TRACER,
  ) {}

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    const { fallback, ...primary } = resolveModel(this.cfg);
    const call: StepHandle = opts.trace
      ? this.trace.begin({
          jobId: opts.trace.jobId,
          parentSeq: opts.trace.parentSeq,
          kind: 'llm.call',
          summary: `${opts.callsite} via ${primary.provider}/${primary.model}`,
          payload: () => ({ system: opts.system, prompt: opts.prompt }),
        })
      : NOOP_HANDLE;
    try {
      const result = await withFallback<T>(
        async (ref) => this.attemptOnce(opts, ref, call),
        primary,
        fallback,
      );
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
      const model = createModel(this.cfg, ref, opts.callsite);
      const cache = planPromptCache(opts.promptCache === true, ref.provider, `warrden:${opts.callsite}`);
      // System-as-message: stable prefix for automatic caches (OpenAI/etc.) and a place
      // to hang explicit breakpoints (Anthropic / OpenRouter→Claude). User half varies.
      const result = await generateObject({
        model,
        schema: opts.schema,
        messages: [
          {
            role: 'system',
            content: opts.system,
            ...(cache.systemProviderOptions
              ? { providerOptions: cache.systemProviderOptions }
              : {}),
          },
          { role: 'user', content: opts.prompt },
        ],
        ...(cache.callProviderOptions
          ? { providerOptions: cache.callProviderOptions }
          : {}),
        // Our own primary/primary/fallback/fallback ladder owns the retry count;
        // the AI SDK's default internal retries would otherwise multiply each
        // ladder slot into up to 3 provider calls of its own.
        maxRetries: 0,
      });
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
      return result.object;
    } catch (err) {
      attempt.end('error', () => ({ provider: ref.provider, model: ref.model, error: errorMessage(err) }));
      throw err;
    }
  }
}
