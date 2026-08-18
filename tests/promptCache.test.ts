import { describe, expect, it } from 'vitest';
import { planPromptCache } from '../src/llm/promptCache.js';

describe('planPromptCache', () => {
  it('returns empty when promptCache is off', () => {
    expect(planPromptCache(false)).toEqual({});
  });

  it('sets both message-level (anthropic+openrouter) and top-level openrouter cacheControl', () => {
    const plan = planPromptCache(true);
    expect(plan.systemProviderOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openrouter: { cacheControl: { type: 'ephemeral' } },
    });
    expect(plan.callProviderOptions).toEqual({
      openrouter: { cacheControl: { type: 'ephemeral' } },
    });
  });
});
