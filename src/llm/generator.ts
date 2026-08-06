import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { generateObject } from 'ai';
import { createClaudeCode } from 'ai-sdk-provider-claude-code';
import type { z } from 'zod';
import type { Config } from '../config/schema.js';

export interface GenerateOpts<T> {
  callsite: string; // e.g. 'release-pick'
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
}

export interface StructuredGenerator {
  generate<T>(opts: GenerateOpts<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    msg: string,
    public callsite: string,
  ) {
    super(msg);
    this.name = 'LlmError';
  }
}

/** A resolved provider + model id, e.g. from a callsite's config entry. */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Resolves a callsite (e.g. 'release-pick') to its configured model, plus optional
 * fallback, from `cfg.llm.profiles[cfg.llm.activeProfile]`. Throws `LlmError` when the
 * callsite has no entry in the active profile.
 */
export function resolveModel(cfg: Config, callsite: string): ModelRef & { fallback?: ModelRef } {
  const entry = cfg.llm.profiles[cfg.llm.activeProfile]?.[callsite];
  if (!entry) {
    throw new LlmError(
      `No model configured for callsite "${callsite}" in profile "${cfg.llm.activeProfile}"`,
      callsite,
    );
  }
  return entry;
}

/**
 * Runs `attempt` against `primary`, retrying once on failure, then against `fallback`
 * (if configured), retrying once more on failure, in that order: primary, primary,
 * fallback, fallback. Throws the last error once every attempt is exhausted. Pure and
 * AI-SDK-free so the retry/fallback ladder is unit-testable on its own.
 */
export async function withFallback<T>(
  attempt: (model: ModelRef) => Promise<T>,
  primary: ModelRef,
  fallback?: ModelRef,
): Promise<T> {
  const models = fallback ? [primary, primary, fallback, fallback] : [primary, primary];
  let lastError: unknown;
  for (const model of models) {
    try {
      return await attempt(model);
    } catch (err) {
      lastError = err;
    }
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
    case 'claude-code':
      // Subscription OAuth via the Claude Code CLI — no API key needed.
      return createClaudeCode()(ref.model);
    default:
      throw new LlmError(`Unknown LLM provider "${ref.provider}"`, callsite);
  }
}

function requireKey(cfg: Config, provider: 'openrouter' | 'openai' | 'anthropic', callsite: string): string {
  const key = cfg.llm.keys[provider];
  if (!key) {
    throw new LlmError(`Missing API key for provider "${provider}" (llm.keys.${provider})`, callsite);
  }
  return key;
}

/** `StructuredGenerator` backed by the Vercel AI SDK, with per-callsite model + fallback resolution. */
export class AiSdkGenerator implements StructuredGenerator {
  constructor(private readonly cfg: Config) {}

  async generate<T>(opts: GenerateOpts<T>): Promise<T> {
    const { fallback, ...primary } = resolveModel(this.cfg, opts.callsite);
    try {
      return await withFallback<T>(
        async (ref) => {
          const model = createModel(this.cfg, ref, opts.callsite);
          const { object } = await generateObject({
            model,
            schema: opts.schema,
            system: opts.system,
            prompt: opts.prompt,
          });
          return object;
        },
        primary,
        fallback,
      );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlmError(`Generation failed for callsite "${opts.callsite}": ${message}`, opts.callsite);
    }
  }
}
