import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildGenerateOptions } from '../src/llm/generator.js';
import { planPromptCache } from '../src/llm/promptCache.js';

// Deliberately does NOT mock `ai`. AI SDK v7 validates the prompt shape client-side and
// throws before any request is sent, so the mocked-generateObject tests in llm.test.ts pass
// on prompts the SDK refuses. This file feeds the real SDK the exact options production
// builds, which is the only place that regression can be caught.

const SCHEMA = z.object({ pick: z.string() });

function stubFetch(capture: { body?: Record<string, unknown> }): typeof fetch {
  return async (_url, init) => {
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'resp_1',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ pick: 'a' }) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
}

describe('buildGenerateOptions against the real AI SDK', () => {
  it.each([true, false])('is accepted by generateObject with promptCache=%s', async (promptCache) => {
    const capture: { body?: Record<string, unknown> } = {};
    const model = createOpenRouter({ apiKey: 'k', fetch: stubFetch(capture) })('deepseek/deepseek-v4-flash');
    const options = buildGenerateOptions(
      { callsite: 'test', schema: SCHEMA, system: 'Pick one option.', prompt: 'Choose: a or b', promptCache },
      planPromptCache(promptCache),
    );

    const result = await generateObject({ model, ...options });

    expect(result.object).toEqual({ pick: 'a' });
    const messages = capture.body?.messages as { role: string; content: unknown }[];
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(String(JSON.stringify(messages[0].content))).toContain('Pick one option.');
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('sends no system role inside the caller-supplied messages array', () => {
    const options = buildGenerateOptions(
      { callsite: 'test', schema: SCHEMA, system: 's', prompt: 'p' },
      planPromptCache(false),
    );
    expect(options.messages.every((m) => m.role === 'user')).toBe(true);
    expect(options.instructions).toBe('s');
  });

  it('keeps the prompt-cache breakpoint on the instructions message', () => {
    const options = buildGenerateOptions(
      { callsite: 'test', schema: SCHEMA, system: 's', prompt: 'p', promptCache: true },
      planPromptCache(true),
    );
    expect(options.instructions).toMatchObject({
      role: 'system',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    });
  });
});
