/**
 * OpenRouter prompt caching (as of AI SDK + OpenRouter docs): automatic for OpenAI/DeepSeek/
 * Grok/… routes, while Anthropic/Alibaba routes need explicit breakpoints. OpenRouter reads
 * `anthropic` *or* `openrouter` cacheControl on messages, plus a top-level `cache_control`,
 * so Warrden sets both message-level and call-level options and lets the route pick.
 *
 * Setting only `anthropic: { cacheControl }` works for Claude routes purely because OpenRouter
 * peeks at `anthropic.*`; the `openrouter.*` twin is what the docs actually promise.
 */

/** Narrow shapes the AI SDK accepts under providerOptions (JSON-serializable). */
export interface PromptCachePlan {
  /** Merged into the `instructions` message's `providerOptions`. */
  systemProviderOptions?: {
    anthropic?: { cacheControl: { type: 'ephemeral' } };
    openrouter?: { cacheControl: { type: 'ephemeral' } };
  };
  /** Passed as top-level `generateObject({ providerOptions })`. */
  callProviderOptions?: {
    openrouter?: { cacheControl: { type: 'ephemeral' } };
  };
}

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Builds cache-related AI SDK options for one generation.
 * Pure: safe to unit-test without providers.
 *
 * @param promptCache - caller opt-in (site-search multi-step loops)
 */
export function planPromptCache(promptCache: boolean): PromptCachePlan {
  if (!promptCache) return {};

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
}
