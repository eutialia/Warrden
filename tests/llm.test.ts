import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../src/config/schema.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { AiSdkGenerator, LlmError, resolveModel, withRetry } from '../src/llm/generator.js';
import { SqlTracer } from '../src/trace/tracer.js';
import { baseConfig, freshDb } from './helpers.js';

// AiSdkGenerator.generate composes resolveModel + withRetry around `ai`'s generateObject.
// Mocking just that call keeps these tests network-free while still exercising the real
// composition (unlike the pure resolveModel/withRetry tests below, which never touch it).
// `vi.mock` factories are hoisted above imports, so the mock fn must be created via
// `vi.hoisted` rather than a plain `const` — otherwise the factory would see a TDZ error.
const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});

describe('resolveModel', () => {
  it('resolves the one configured model', () => {
    const cfg = baseConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };
    expect(resolveModel(cfg)).toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
    });
  });

  it('throws LlmError when no model is configured', () => {
    expect(() => resolveModel(baseConfig())).toThrow(LlmError);
  });

  it('returns a copy, so callers cannot mutate the config through it', () => {
    const cfg = baseConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'a' };
    const resolved = resolveModel(cfg);
    resolved.model = 'mutated';
    expect(cfg.llm.model).toEqual({ provider: 'openrouter', model: 'a' });
  });
});

describe('withRetry', () => {
  it('returns first success without a second attempt', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries once, returning the second attempt result', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    expect(await withRetry(attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exactly two attempts', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withRetry(attempt)).rejects.toThrow('down');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('attaches the first error as an AggregateError cause on the thrown error, so a vaguer second failure does not mask it', async () => {
    const firstError = new Error('rate limited');
    const lastError = new Error('socket hang up');
    const attempt = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(lastError);
    let thrown: unknown;
    try {
      await withRetry(attempt);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(lastError);
    expect((thrown as Error).cause).toBeInstanceOf(AggregateError);
    // The thrown error itself (the last attempt) is excluded — it's already the top-level
    // error, so including it in its own `cause` would make it reference itself.
    expect((thrown as Error & { cause: AggregateError }).cause.errors).toEqual([firstError]);
  });

  it('leaves an error that already carries its own cause untouched', async () => {
    const ownCause = new Error('root cause');
    const lastError = new Error('wrapped', { cause: ownCause });
    const attempt = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(lastError);
    await expect(withRetry(attempt)).rejects.toBe(lastError);
    expect(lastError.cause).toBe(ownCause);
  });
});

/** `baseConfig()` plus the key the fixtures below need to get past `requireKey` and reach
 * the mocked `generateObject`. */
function keyedConfig(): Config {
  const cfg = baseConfig();
  cfg.llm.keys.anthropic = 'test-key';
  return cfg;
}

describe('AiSdkGenerator', () => {
  const schema = z.object({ ok: z.boolean() });

  it('propagates LlmError from an unconfigured model without calling generateObject', async () => {
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
      cfg.llm.model = { provider, model: 'some-model' };
      const generator = new AiSdkGenerator(cfg);
      await expect(
        generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' }),
      ).rejects.toThrow(/Missing API key/);
      expect(generateObjectMock).not.toHaveBeenCalled();
    },
  );

  it('calls generateObject once when the first attempt succeeds', async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const generator = new AiSdkGenerator(cfg);
    const result = await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    expect(result).toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('retries the configured model once after a failure, with maxRetries: 0 on every call', async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const generator = new AiSdkGenerator(cfg);
    const result = await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    expect(result).toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    // maxRetries: 0 on every call — the SDK's own retries must not multiply ours.
    expect(generateObjectMock.mock.calls.every(([opts]) => (opts as { maxRetries: number }).maxRetries === 0)).toBe(
      true,
    );
  });

  it('gives up after two attempts, wrapping the last failure into an LlmError carrying the callsite and that error as cause', async () => {
    generateObjectMock.mockReset();
    const first = new Error('rate limited');
    const last = new Error('down');
    generateObjectMock.mockRejectedValueOnce(first).mockRejectedValueOnce(last);
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const generator = new AiSdkGenerator(cfg);
    expect.assertions(5);
    try {
      await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as InstanceType<typeof LlmError>).callsite).toBe('release-pick');
      expect((err as Error).cause).toBe(last);
      expect(generateObjectMock).toHaveBeenCalledTimes(2);
      expect((last.cause as AggregateError).errors).toEqual([first]);
    }
  });
});

describe('AiSdkGenerator tracing', () => {
  it('records a parent llm.call and one llm.attempt per attempt', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const gen = new AiSdkGenerator(cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        object: { pick: 'a' },
        usage: { inputTokens: 10, outputTokens: 2 },
        request: { body: '{"messages":[]}' },
        response: { id: 'resp_1', modelId: 'claude-x' },
        finishReason: 'stop',
        warnings: [],
        providerMetadata: {},
      });
    const result = await gen.generate({
      callsite: 'release-pick',
      schema: z.object({ pick: z.string() }),
      system: 'sys',
      prompt: 'user',
      trace: { jobId: 42 },
    });
    expect(result).toEqual({ pick: 'a' });
    const rows = new TraceEntries(db).listByJob(42);
    const call = rows.find((r) => r.kind === 'llm.call');
    const attempts = rows.filter((r) => r.kind === 'llm.attempt');
    expect(call?.status).toBe('ok');
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.parent_seq === call?.seq)).toBe(true);
    expect(attempts[0].status).toBe('error');
    const okPayload = JSON.parse(attempts[1].payload ?? '') as Record<string, unknown>;
    expect(okPayload.responseId).toBe('resp_1');
    expect(okPayload.finishReason).toBe('stop');
    expect(okPayload.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('keeps system+prompt in the llm.call payload when every attempt fails', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const gen = new AiSdkGenerator(cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock.mockRejectedValue(new Error('down'));

    await expect(
      gen.generate({
        callsite: 'release-pick',
        schema: z.object({ pick: z.string() }),
        system: 'sys',
        prompt: 'user',
        trace: { jobId: 7 },
      }),
    ).rejects.toThrow();

    const call = new TraceEntries(db).listByJob(7).find((r) => r.kind === 'llm.call');
    expect(call?.status).toBe('error');
    expect(JSON.parse(call?.payload ?? '')).toMatchObject({ system: 'sys', prompt: 'user', error: expect.stringContaining('down') });
  });

  it('writes nothing without a trace option', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'anthropic', model: 'primary-model' };
    const gen = new AiSdkGenerator(cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock.mockResolvedValueOnce({ object: { pick: 'a' } });
    await gen.generate({ callsite: 'release-pick', schema: z.object({ pick: z.string() }), system: 's', prompt: 'p' });
    expect(new TraceEntries(db).summaries()).toHaveLength(0);
  });
});
