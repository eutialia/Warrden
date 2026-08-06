import { describe, expect, it, vi } from 'vitest';
import { LlmError, resolveModel, withFallback } from '../src/llm/generator.js';
import { baseConfig } from './helpers.js';

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

  it('without fallback: two attempts only', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withFallback(attempt, primary)).rejects.toThrow('down');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
