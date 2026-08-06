import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiSdkGenerator, LlmError, resolveModel, withFallback } from '../src/llm/generator.js';
import { baseConfig } from './helpers.js';

// AiSdkGenerator.generate composes resolveModel + withFallback around `ai`'s generateObject.
// Mocking just that call keeps these tests network-free while still exercising the real
// composition (unlike the pure resolveModel/withFallback tests below, which never touch it).
// `vi.mock` factories are hoisted above imports, so the mock fn must be created via
// `vi.hoisted` rather than a plain `const` — otherwise the factory would see a TDZ error.
const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});

describe('resolveModel', () => {
  it('resolves from the active profile', () => {
    const cfg = baseConfig();
    cfg.llm.profiles.prod['release-pick'] = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };
    expect(resolveModel(cfg, 'release-pick')).toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
    });
  });

  it('throws LlmError when callsite unconfigured', () => {
    expect(() => resolveModel(baseConfig(), 'release-pick')).toThrow(LlmError);
  });
});

describe('withFallback', () => {
  const primary = { provider: 'openrouter', model: 'a' };
  const fallback = { provider: 'openai', model: 'b' };

  it('returns first success without touching fallback', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    expect(await withFallback(attempt, primary, fallback)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries primary once then uses fallback', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('ok');
    expect(await withFallback(attempt, primary, fallback)).toBe('ok');
    expect(attempt).toHaveBeenNthCalledWith(3, fallback);
  });

  it('throws last error when everything fails', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withFallback(attempt, primary, fallback)).rejects.toThrow('down');
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('attaches every ladder error as an AggregateError cause on the thrown error, so a keyless-fallback failure does not mask the primary errors', async () => {
    const primaryError = new Error('primary rate limited');
    const fallbackError = new Error('fallback missing API key');
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(primaryError)
      .mockRejectedValueOnce(primaryError)
      .mockRejectedValueOnce(fallbackError)
      .mockRejectedValueOnce(fallbackError);
    let thrown: unknown;
    try {
      await withFallback(attempt, primary, fallback);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(fallbackError);
    expect((thrown as Error).cause).toBeInstanceOf(AggregateError);
    // The thrown error itself (the last attempt) is excluded — it's already the top-level
    // error, so including it in its own `cause` would make it reference itself.
    expect((thrown as Error & { cause: AggregateError }).cause.errors).toEqual([
      primaryError,
      primaryError,
      fallbackError,
    ]);
  });

  it('without fallback: two attempts only', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withFallback(attempt, primary)).rejects.toThrow('down');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('AiSdkGenerator', () => {
  const schema = z.object({ ok: z.boolean() });

  it('propagates LlmError from an unconfigured callsite without calling generateObject', async () => {
    generateObjectMock.mockReset();
    const generator = new AiSdkGenerator(baseConfig());
    await expect(
      generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' }),
    ).rejects.toThrow(LlmError);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it.each(['openrouter', 'openai', 'anthropic'] as const)(
    'throws LlmError without calling generateObject when the %s API key is missing',
    async (provider) => {
      generateObjectMock.mockReset();
      const cfg = baseConfig();
      cfg.llm.profiles.prod['release-pick'] = { provider, model: 'some-model' };
      const generator = new AiSdkGenerator(cfg);
      await expect(
        generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' }),
      ).rejects.toThrow(/Missing API key/);
      expect(generateObjectMock).not.toHaveBeenCalled();
    },
  );

  it('falls back to the configured fallback model after the primary fails twice', async () => {
    generateObjectMock.mockReset();
    generateObjectMock
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({ object: { ok: true } });
    const cfg = baseConfig();
    cfg.llm.profiles.prod['release-pick'] = {
      provider: 'claude-code',
      model: 'primary-model',
      fallback: { provider: 'claude-code', model: 'fallback-model' },
    };
    const generator = new AiSdkGenerator(cfg);
    const result = await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    expect(result).toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(3);
    // maxRetries: 0 on every call — the SDK's own retries must not multiply our ladder.
    expect(generateObjectMock.mock.calls.every(([opts]) => (opts as { maxRetries: number }).maxRetries === 0)).toBe(
      true,
    );
  });

  it('wraps the final failure into an LlmError carrying the callsite and the original error as cause', async () => {
    generateObjectMock.mockReset();
    const original = new Error('down');
    generateObjectMock.mockRejectedValue(original);
    const cfg = baseConfig();
    cfg.llm.profiles.prod['release-pick'] = { provider: 'claude-code', model: 'primary-model' };
    const generator = new AiSdkGenerator(cfg);
    expect.assertions(3);
    try {
      await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as InstanceType<typeof LlmError>).callsite).toBe('release-pick');
      expect((err as Error).cause).toBe(original);
    }
  });
});
