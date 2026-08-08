import { describe, expect, it } from 'vitest';
import { planPromptCache } from '../src/llm/promptCache.js';

describe('planPromptCache', () => {
  it('returns empty when promptCache is off', () => {
    expect(planPromptCache(false, 'anthropic', 'warrden:site-search')).toEqual({});
    expect(planPromptCache(false, 'openai', 'warrden:site-search')).toEqual({});
    expect(planPromptCache(false, 'openrouter', 'warrden:site-search')).toEqual({});
  });

  it('anthropic: message-level cacheControl only (explicit breakpoints)', () => {
    expect(planPromptCache(true, 'anthropic', 'warrden:site-search')).toEqual({
      systemProviderOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    });
  });

  it('openai: call-level promptCacheKey for sticky automatic caching (not anthropic options)', () => {
    const plan = planPromptCache(true, 'openai', 'warrden:site-search');
    expect(plan.systemProviderOptions).toBeUndefined();
    expect(plan.callProviderOptions).toEqual({
      openai: { promptCacheKey: 'warrden:site-search' },
    });
  });

  it('openrouter: both message-level (anthropic+openrouter) and top-level openrouter cacheControl', () => {
    const plan = planPromptCache(true, 'openrouter', 'warrden:site-search');
    expect(plan.systemProviderOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openrouter: { cacheControl: { type: 'ephemeral' } },
    });
    expect(plan.callProviderOptions).toEqual({
      openrouter: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('claude-code: no remote cache API', () => {
    expect(planPromptCache(true, 'claude-code', 'warrden:site-search')).toEqual({});
  });
});
