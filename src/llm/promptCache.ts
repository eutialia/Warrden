import type { Provider } from '../config/schema.js';

/**
 * Provider differences for prompt caching (as of AI SDK + OpenRouter docs):
 *
 * | Path | How caching works | What Warrden must do |
 * | --- | --- | --- |
 * | **Anthropic direct** | Explicit only: `cache_control` on a content block | Set message `providerOptions.anthropic.cacheControl` |
 * | **OpenAI direct** | Automatic for stable prefixes (≥~1024 tokens on many models). Optional sticky key | Keep system prefix stable; set call `providerOptions.openai.promptCacheKey` |
 * | **OpenRouter** | Auto for OpenAI/DeepSeek/Grok/…; Anthropic/Alibaba need breakpoints. Reads `anthropic` *or* `openrouter` cacheControl on messages; also top-level `cache_control` | Set both message-level and top-level openrouter options so Anthropic-via-OR works |
 *
 * Putting only `anthropic: { cacheControl }` is NOT universal: OpenAI ignores it, and
 * OpenRouter works for Claude routes only because it also peeks at `anthropic.*`.
 */

/** Narrow shapes the AI SDK accepts under providerOptions (JSON-serializable). */
export interface PromptCachePlan {
  /** Merged into the system message's `providerOptions`. */
  systemProviderOptions?: {
    anthropic?: { cacheControl: { type: 'ephemeral' } };
    openrouter?: { cacheControl: { type: 'ephemeral' } };
  };
  /** Passed as top-level `generateObject({ providerOptions })`. */
  callProviderOptions?: {
    openai?: { promptCacheKey: string };
    openrouter?: { cacheControl: { type: 'ephemeral' } };
  };
}

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Builds cache-related AI SDK options for one generation.
 * Pure: safe to unit-test without providers.
 *
 * @param promptCache - caller opt-in (site-search multi-step loops)
 * @param provider - resolved ModelRef.provider for this attempt
 * @param cacheKey - stable key for OpenAI sticky routing (e.g. `warrden:site-search`)
 */
export function planPromptCache(
  promptCache: boolean,
  provider: Provider,
  cacheKey: string,
): PromptCachePlan {
  if (!promptCache) return {};

  switch (provider) {
    case 'anthropic':
      // Explicit breakpoint on the system message — AI SDK maps this to block-level cache_control.
      return {
        systemProviderOptions: {
          anthropic: { cacheControl: EPHEMERAL },
        },
      };

    case 'openrouter':
      // Message-level: OpenRouter converts openrouter/anthropic cacheControl → cache_control
      // on the block (needed for Claude + Alibaba via OR).
      // Call-level: top-level cache_control for Anthropic automatic caching + sticky routing.
      return {
        systemProviderOptions: {
          anthropic: { cacheControl: EPHEMERAL },
          openrouter: { cacheControl: EPHEMERAL },
        },
        callProviderOptions: {
          openrouter: { cacheControl: EPHEMERAL },
        },
      };

    case 'openai':
      // Automatic prefix caching: no breakpoint required. A stable promptCacheKey improves
      // multi-step hit rates (same agent loop, same system, growing user history).
      return {
        callProviderOptions: {
          openai: { promptCacheKey: cacheKey },
        },
      };

    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return {};
    }
  }
}
