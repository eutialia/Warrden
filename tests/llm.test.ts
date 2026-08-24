import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, InvalidPromptError, NoObjectGeneratedError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import type { Config, Effort } from '../src/config/schema.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { isPermanentError, isRateLimitedError } from '../src/jobs/errors.js';
import type { ModelCapabilities, StructuredOutputTier } from '../src/llm/catalog.js';
import {
  AiSdkGenerator,
  LlmError,
  modelSettings,
  RATE_LIMIT_RETRY_MS,
  repairObjectText,
  resolveModel,
  withRetry,
  type EffortIgnoredInfo,
} from '../src/llm/generator.js';
import { NOOP_TRACER, SqlTracer } from '../src/trace/tracer.js';
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

/** The shape the AI SDK actually throws for a non-2xx provider response. */
function apiCallError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });
}

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

describe('LlmError permanence marker', () => {
  it('satisfies isPermanentError when built with permanent: true', () => {
    expect(isPermanentError(new LlmError('bad request', 'release-pick', { permanent: true }))).toBe(true);
  });

  it('does not satisfy it by default', () => {
    expect(isPermanentError(new LlmError('socket hang up', 'release-pick'))).toBe(false);
  });
});

describe('LlmError rate-limit marker', () => {
  it('satisfies isRateLimitedError when built with rateLimited: true', () => {
    expect(isRateLimitedError(new LlmError('slow down', 'release-pick', { rateLimited: true }))).toBe(true);
  });

  it('does not satisfy it by default', () => {
    expect(isRateLimitedError(new LlmError('socket hang up', 'release-pick'))).toBe(false);
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

// A 429 answered by firing the second attempt half a second later is not a retry, it's a
// second helping of the same rate limit (job #78 burned six calls in fifteen minutes that
// way). Every case here drives an injected sleep, so nothing actually waits.
describe('withRetry rate-limit backoff', () => {
  const NOW = Date.parse('2026-08-22T21:40:00.000Z');
  const CAP_MS = 60_000;

  /** The delays `withRetry` asked for before its second attempt. */
  async function delaysBefore(firstError: unknown): Promise<number[]> {
    const slept: number[] = [];
    const attempt = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValue('ok');
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    expect(await withRetry(attempt, { sleep, now: () => NOW })).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
    return slept;
  }

  const httpDate = (offsetMs: number): Record<string, string> => ({ 'Retry-After': new Date(NOW + offsetMs).toUTCString() });

  it.each([
    ['no Retry-After at all', undefined, RATE_LIMIT_RETRY_MS],
    ['Retry-After in whole seconds', { 'retry-after': '7' }, 7_000],
    ['Retry-After as an HTTP-date', httpDate(30_000), 30_000],
    ['a Retry-After longer than the cap', { 'retry-after': '600' }, CAP_MS],
    ['an HTTP-date past the cap', httpDate(600_000), CAP_MS],
    ['an HTTP-date already in the past', httpDate(-5_000), RATE_LIMIT_RETRY_MS],
    ['an unparsable Retry-After', { 'retry-after': 'shortly' }, RATE_LIMIT_RETRY_MS],
  ])('waits out a 429 with %s', async (_case, headers, expected) => {
    expect(await delaysBefore(apiCallError(429, headers))).toEqual([expected]);
  });

  it('finds the 429 the provider wrapped one level down', async () => {
    expect(await delaysBefore(new Error('request failed', { cause: apiCallError(429) }))).toEqual([RATE_LIMIT_RETRY_MS]);
  });

  it.each([
    ['a 500', apiCallError(500)],
    ['a 400', apiCallError(400)],
    ['an ordinary transport error', new Error('socket hang up')],
  ])('retries %s immediately, without sleeping', async (_case, err) => {
    expect(await delaysBefore(err)).toEqual([]);
  });
});

/** `baseConfig()` plus the key the fixtures below need to get past `requireKey` and reach
 * the mocked `generateObject`. */
function keyedConfig(): Config {
  const cfg = baseConfig();
  cfg.llm.keys.openrouter = 'test-key';
  return cfg;
}

describe('AiSdkGenerator', () => {
  const schema = z.object({ ok: z.boolean() });

  it('propagates LlmError from an unconfigured model without calling generateObject', async () => {
    generateObjectMock.mockReset();
    const generator = new AiSdkGenerator(() => baseConfig());
    await expect(
      generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' }),
    ).rejects.toThrow(LlmError);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('throws LlmError without calling generateObject when the openrouter API key is missing', async () => {
    generateObjectMock.mockReset();
    const cfg = baseConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'some-model' };
    const generator = new AiSdkGenerator(() => cfg);
    await expect(
      generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' }),
    ).rejects.toThrow(/Missing API key/);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('calls generateObject once when the first attempt succeeds', async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const generator = new AiSdkGenerator(() => cfg);
    const result = await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    expect(result).toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('retries the configured model once after a failure, with maxRetries: 0 on every call', async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const generator = new AiSdkGenerator(() => cfg);
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
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const generator = new AiSdkGenerator(() => cfg);
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

  it('reads the config live, so a model saved after construction is used on the very next call (no restart)', async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    let cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'first-model' };
    const generator = new AiSdkGenerator(() => cfg);

    await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });

    // Reassigned wholesale, exactly like `applyConfig` swaps `ctx.config` on a config PUT —
    // mutating the same object in place would pass even against a captured-at-construction
    // snapshot, and so would prove nothing.
    cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'second-model' };
    await generator.generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });

    const modelIds = generateObjectMock.mock.calls.map(([opts]) => (opts as { model: { modelId: string } }).model.modelId);
    expect(modelIds).toEqual(['first-model', 'second-model']);
  });
});

/** The recorded generateObject call: the OpenRouter chat model keeps the settings it was
 * built with on the instance, so what will end up in the request body is inspectable here
 * without a network round trip. */
function recordedCall(index = 0): {
  settings: { extraBody?: Record<string, unknown> };
  providerOptions?: { openrouter?: { cacheControl?: { type: string } } };
  instructions: string | { content: string };
  messages: { role: string; content: string }[];
} {
  const [opts] = generateObjectMock.mock.calls[index] as [
    {
      model: { settings: { extraBody?: Record<string, unknown> } };
      providerOptions?: { openrouter?: { cacheControl?: { type: string } } };
      instructions: string | { content: string };
      messages: { role: string; content: string }[];
    },
  ];
  return { settings: opts.model.settings, providerOptions: opts.providerOptions, instructions: opts.instructions, messages: opts.messages };
}

describe('AiSdkGenerator provider-error classification', () => {
  const schema = z.object({ ok: z.boolean() });

  // Fake timers because a 429 case now parks on the rate-limit backoff between attempts;
  // advancing past the cap below is what lets `generate` reach its second attempt at once.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function failureFrom(thrown: unknown): Promise<unknown> {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValue(thrown);
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const settled = new AiSdkGenerator(() => cfg)
      .generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' })
      .then(
        () => {
          throw new Error('failureFrom: generate() unexpectedly resolved');
        },
        (err: unknown) => err,
      );
    await vi.advanceTimersByTimeAsync(60_000);
    return await settled;
  }

  const permanenceOf = async (thrown: unknown): Promise<boolean> => isPermanentError(await failureFrom(thrown));

  it.each([400, 401, 403, 404, 422])('marks a %i from the provider permanent', async (status) => {
    expect(await permanenceOf(apiCallError(status))).toBe(true);
  });

  it.each([408, 429, 500, 503])('leaves a %i retryable', async (status) => {
    expect(await permanenceOf(apiCallError(status))).toBe(false);
  });

  it.each([
    [429, true],
    [408, false],
    [500, false],
  ])('marks a %i rate-limited=%s, so the runner can push its retry out', async (status, rateLimited) => {
    expect(isRateLimitedError(await failureFrom(apiCallError(status)))).toBe(rateLimited);
  });

  it('marks a prompt the SDK refuses to send permanent', async () => {
    expect(await permanenceOf(new InvalidPromptError({ prompt: {}, message: 'unsupported message role' }))).toBe(true);
  });

  it('marks structured-output exhaustion permanent', async () => {
    const err = new NoObjectGeneratedError({
      message: 'no object generated',
      text: 'not json',
      response: { id: 'r1', timestamp: new Date(0), modelId: 'primary-model' },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      },
      finishReason: 'stop',
    });
    expect(await permanenceOf(err)).toBe(true);
  });

  it('finds a permanent error the provider wrapped one level down', async () => {
    expect(await permanenceOf(new Error('request failed', { cause: apiCallError(400) }))).toBe(true);
  });

  it('leaves an ordinary transport error retryable', async () => {
    expect(await permanenceOf(new Error('socket hang up'))).toBe(false);
  });

  // The exact shape withRetry builds: the last attempt's error, with the first attempt's
  // parked underneath it in an AggregateError. Walking it queues the `cause` of every node,
  // including the undefined ones at the ends of each chain, and those are not nodes worth
  // spending the traversal budget on.
  it('finds a permanent error under the AggregateError withRetry parks on the cause, past the undefined cause hops in between', async () => {
    const firstAttempt = new Error('attempt 1 failed', { cause: new Error('wrapped', { cause: apiCallError(400) }) });
    const lastAttempt = new Error('attempt 2 failed', { cause: new AggregateError([firstAttempt], 'preceding attempts') });
    expect(await permanenceOf(lastAttempt)).toBe(true);
  });
});

describe('AiSdkGenerator reasoning effort', () => {
  const schema = z.object({ ok: z.boolean() });

  // Every case here wires a capability lookup that answers: require_parameters is an assertion
  // about what the routed endpoint declares, and the generator only makes it when the catalog
  // actually told it something. An unwired lookup means "nothing known" and sends no guard.
  async function generateWith(model: Config['llm']['model'], promptCache = false): Promise<void> {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = model;
    const known: ModelCapabilities = { structuredOutput: 'native', mandatoryReasoning: false };
    await new AiSdkGenerator(
      () => cfg,
      NOOP_TRACER,
      undefined,
      async () => known,
    ).generate({
      callsite: 'site-search',
      schema,
      system: 's',
      prompt: 'p',
      promptCache,
    });
  }

  // `max` is the one that matters most: the provider package's typed reasoning option omits
  // it, while the live API accepts it, which is why effort goes through extraBody.
  it.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends effort "%s" through unchanged as an extraBody reasoning field',
    async (effort) => {
      await generateWith({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', effort });
      expect(recordedCall().settings.extraBody).toEqual({
        reasoning: { effort },
        provider: { require_parameters: true },
      });
    },
  );

  it('sends no reasoning key at all when no effort is configured', async () => {
    await generateWith({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' });
    expect(recordedCall().settings.extraBody?.reasoning).toBeUndefined();
  });

  // Omitting the field leaves a default-on model thinking, so 'none' has to say so out loud.
  it('sends reasoning enabled false for effort "none"', async () => {
    await generateWith({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', effort: 'none' });
    expect(recordedCall().settings.extraBody).toEqual({
      reasoning: { enabled: false },
      provider: { require_parameters: true },
    });
  });

  // Without require_parameters OpenRouter is free to route to a provider that drops the
  // reasoning field, which is exactly how a live "effort high" run came back with 0
  // reasoning tokens.
  it('restricts routing to providers that honour the reasoning field whenever reasoning is configured', async () => {
    await generateWith({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', effort: 'high' });
    expect(recordedCall().settings.extraBody?.provider).toEqual({ require_parameters: true });
  });

  it('keeps the prompt-cache options and the reasoning body together on one call', async () => {
    await generateWith({ provider: 'openrouter', model: 'anthropic/claude-opus-5', effort: 'max' }, true);
    const call = recordedCall();
    expect(call.settings.extraBody).toEqual({
      reasoning: { effort: 'max' },
      provider: { require_parameters: true },
    });
    expect(call.providerOptions).toEqual({ openrouter: { cacheControl: { type: 'ephemeral' } } });
  });
});

describe('AiSdkGenerator structured-output tiers', () => {
  const schema = z.object({ ok: z.boolean() });

  async function generateOn(
    capabilities: ModelCapabilities | undefined,
    effort?: Effort,
  ): Promise<ReturnType<typeof recordedCall>> {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'stealth/ox-alpha', effort };
    await new AiSdkGenerator(() => cfg, NOOP_TRACER, undefined, async () => capabilities).generate({
      callsite: 'release-pick',
      schema,
      system: 'Pick one option.',
      prompt: 'p',
    });
    return recordedCall();
  }

  const native: ModelCapabilities = { structuredOutput: 'native', mandatoryReasoning: false };
  const jsonObject: ModelCapabilities = { structuredOutput: 'json_object', mandatoryReasoning: false };
  const noFormat: ModelCapabilities = { structuredOutput: 'none', mandatoryReasoning: false };

  // A model whose endpoint declares structured_outputs must keep sending exactly what it sent
  // before tiering existed: the json_schema response_format the SDK sets, untouched.
  it('leaves the request untouched for a native model', async () => {
    const call = await generateOn(native, 'high');
    expect(call.settings.extraBody).toEqual({ reasoning: { effort: 'high' }, provider: { require_parameters: true } });
    expect(call.instructions).toBe('Pick one option.');
  });

  // Nothing known is not the same as "structured_outputs is supported". The native path is still
  // the right guess for the request shape, but asserting require_parameters on top of a
  // json_schema ask is how an unlisted model earns a 404, which the runner then calls permanent.
  it('stays on the native path but sends no provider block when nothing is known about the model', async () => {
    const call = await generateOn(undefined, 'high');
    expect(call.settings.extraBody).toEqual({ reasoning: { effort: 'high' } });
    expect(call.instructions).toBe('Pick one option.');
  });

  it('overrides response_format to json_object alongside the reasoning body', async () => {
    const call = await generateOn(jsonObject, 'high');
    expect(call.settings.extraBody).toEqual({
      reasoning: { effort: 'high' },
      provider: { require_parameters: true },
      response_format: { type: 'json_object' },
    });
  });

  it('blanks response_format for a model that declares neither parameter', async () => {
    const call = await generateOn(noFormat, 'high');
    expect(call.settings.extraBody).toMatchObject({ reasoning: { effort: 'high' } });
    expect(call.settings.extraBody?.response_format).toBeUndefined();
  });

  // Reasoning is droppable too, so an effort on the none tier still needs the guard even though
  // no response_format is being asked for.
  it('guards routing on the none tier when an effort is configured', async () => {
    const call = await generateOn(noFormat, 'high');
    expect(call.settings.extraBody?.provider).toEqual({ require_parameters: true });
  });

  // Nothing is being asked for that an endpoint could drop, so there is nothing to guard and no
  // reason to shrink the endpoint pool.
  it('sends no provider block on the none tier with no effort', async () => {
    const call = await generateOn(noFormat);
    expect(call.settings.extraBody).toEqual({ response_format: undefined });
  });

  // The whole point of the json_object tier: it has to work on a model configured with no
  // reasoning effort at all, and most models on this tier take no reasoning efforts. The guard
  // rides on the response_format ask, not on reasoning, or the endpoint is free to drop it and
  // answer prose.
  it('sends the response_format override and the guard with no effort configured', async () => {
    const call = await generateOn(jsonObject);
    expect(call.settings.extraBody).toEqual({
      response_format: { type: 'json_object' },
      provider: { require_parameters: true },
    });
  });

  it.each([
    ['json_object', jsonObject],
    ['none', noFormat],
  ])('appends the JSON Schema after the caller system text on the %s tier', async (_label, capabilities) => {
    const call = await generateOn(capabilities);
    const system = String(call.instructions);
    expect(system.startsWith('Pick one option.')).toBe(true);
    expect(system).toContain('single JSON object');
    expect(system).toContain(JSON.stringify(z.toJSONSchema(schema), null, 2));
  });

  it.each([
    ['json_object', jsonObject],
    ['none', noFormat],
  ])('closes the user half with the JSON-only contract on the %s tier', async (_label, capabilities) => {
    const call = await generateOn(capabilities);
    const user = String(call.messages.at(-1)?.content);
    expect(user.startsWith('p')).toBe(true);
    expect(user.endsWith('Answer with the JSON object only. It starts with { and ends with }. No code fence, no commentary.')).toBe(true);
  });

  it('leaves the native tier prompt untouched', async () => {
    const call = await generateOn(undefined);
    expect(String(call.instructions)).toBe('Pick one option.');
    expect(String(call.messages.at(-1)?.content)).toBe('p');
  });

  // The promptCache breakpoint only pays off while the system prefix is byte-identical across
  // a loop's steps, so the appendix must not carry anything that varies per call.
  it('renders a byte-identical appendix for the same schema twice', async () => {
    expect(String((await generateOn(jsonObject)).instructions)).toBe(String((await generateOn(jsonObject)).instructions));
  });
});

describe('AiSdkGenerator configured structured-output override', () => {
  const schema = z.object({ ok: z.boolean() });

  async function generateWithOverride(
    capabilities: ModelCapabilities | undefined,
    structuredOutput?: StructuredOutputTier,
  ): Promise<ReturnType<typeof recordedCall>> {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'stealth/ox-alpha', ...(structuredOutput ? { structuredOutput } : {}) };
    await new AiSdkGenerator(() => cfg, NOOP_TRACER, undefined, async () => capabilities).generate({
      callsite: 'release-pick',
      schema,
      system: 'Pick one option.',
      prompt: 'p',
    });
    return recordedCall();
  }

  const jsonObject: ModelCapabilities = { structuredOutput: 'json_object', mandatoryReasoning: false };

  // The reason the override exists: ox-alpha's route declares response_format, so the catalog
  // says json_object, and under that shape it strips every literal "json" out of the answer.
  it('sends no response_format and restates the schema when the config pins "none" over a json_object catalog entry', async () => {
    const call = await generateWithOverride(jsonObject, 'none');
    expect('response_format' in (call.settings.extraBody ?? {})).toBe(true);
    expect(call.settings.extraBody?.response_format).toBeUndefined();
    const system = String(call.instructions);
    expect(system.startsWith('Pick one option.')).toBe(true);
    expect(system).toContain(JSON.stringify(z.toJSONSchema(schema), null, 2));
  });

  it('leaves the catalog tier in charge when nothing is pinned', async () => {
    const call = await generateWithOverride(jsonObject);
    expect(call.settings.extraBody?.response_format).toEqual({ type: 'json_object' });
  });

  it('pins the request shape over a catalog that would have sent json_schema', async () => {
    const native: ModelCapabilities = { structuredOutput: 'native', mandatoryReasoning: false };
    const call = await generateWithOverride(native, 'json_object');
    expect(call.settings.extraBody?.response_format).toEqual({ type: 'json_object' });
  });

  // An override says what to send, not what the endpoint declares. require_parameters is an
  // assertion about the latter, so pinning a tier must not start making it.
  it('still sends no routing guard when the catalog knows nothing about the model', async () => {
    const call = await generateWithOverride(undefined, 'json_object');
    expect(call.settings.extraBody?.provider).toBeUndefined();
  });
});

type EffortIgnoredMock = Mock<(info: EffortIgnoredInfo) => void>;

describe('AiSdkGenerator ignored-effort detection', () => {
  const schema = z.object({ ok: z.boolean() });

  async function generateReporting(
    effort: Effort | undefined,
    reasoningTokens: number | undefined,
    opts?: { providerMetadata?: Record<string, unknown>; callback?: EffortIgnoredMock; capabilities?: ModelCapabilities },
  ): Promise<EffortIgnoredMock> {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 10, outputTokens: 2, outputTokenDetails: { textTokens: 2, reasoningTokens } },
      providerMetadata: opts?.providerMetadata,
    });
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', effort };
    const onEffortIgnored = opts?.callback ?? vi.fn<(info: EffortIgnoredInfo) => void>();
    await new AiSdkGenerator(() => cfg, NOOP_TRACER, onEffortIgnored, async () => opts?.capabilities).generate({
      callsite: 'site-search',
      schema,
      system: 's',
      prompt: 'p',
    });
    return onEffortIgnored;
  }

  it('reports callsite, model and effort when a requested effort came back with zero reasoning tokens', async () => {
    expect(await generateReporting('high', 0)).toHaveBeenCalledWith({
      callsite: 'site-search',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'high',
      route: undefined,
    });
  });

  // Which upstream OpenRouter actually routed to is the only actionable half of the warning:
  // the model id alone doesn't name the provider that dropped the reasoning field.
  it('names the routed upstream provider when OpenRouter reported one', async () => {
    const cb = await generateReporting('high', 0, { providerMetadata: { openrouter: { provider: 'DeepInfra' } } });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ route: 'DeepInfra' }));
  });

  it.each([
    { name: 'the provider field is the empty string the SDK falls back to', metadata: { openrouter: { provider: '' } } },
    { name: 'no openrouter metadata came back at all', metadata: { anthropic: {} } },
  ])('leaves route undefined when $name', async ({ metadata }) => {
    const cb = await generateReporting('high', 0, { providerMetadata: metadata });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ route: undefined }));
  });

  // The attempt already succeeded and was paid for: a reporting callback that throws must not
  // turn it into a retry (and a second billed call).
  it('survives a throwing callback: the generation still resolves, on one provider call', async () => {
    const thrower: EffortIgnoredMock = vi.fn(() => {
      throw new Error('event log is down');
    });
    await expect(generateReporting('high', 0, { callback: thrower })).resolves.toBe(thrower);
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the model actually reasoned', async () => {
    expect(await generateReporting('high', 77)).not.toHaveBeenCalled();
  });

  it('stays quiet for effort "none", where zero reasoning tokens is the point', async () => {
    expect(await generateReporting('none', 0)).not.toHaveBeenCalled();
  });

  it('stays quiet when no effort was requested', async () => {
    expect(await generateReporting(undefined, 0)).not.toHaveBeenCalled();
  });

  // ox-alpha reasons (the response carries `reasoning`) and still reports 0 reasoning tokens.
  // Reasoning can't be switched off there, so the count is a reporting artefact and warning on
  // it would fire on every single call.
  it('stays quiet for a model whose reasoning is mandatory, where a zero count proves nothing', async () => {
    const capabilities: ModelCapabilities = { structuredOutput: 'json_object', mandatoryReasoning: true };
    expect(await generateReporting('high', 0, { capabilities })).not.toHaveBeenCalled();
  });

  it('still fires for a model that could have honoured the effort and reported zero', async () => {
    const capabilities: ModelCapabilities = { structuredOutput: 'native', mandatoryReasoning: false };
    expect(await generateReporting('high', 0, { capabilities })).toHaveBeenCalled();
  });

  // No count reported is not a count of zero: there is nothing to conclude about the route.
  it('stays quiet when the provider reported no reasoning-token count at all', async () => {
    expect(await generateReporting('high', undefined)).not.toHaveBeenCalled();
  });
});

describe('OpenRouter request body', () => {
  it('carries reasoning and the routing restriction from extraBody and cache_control from call providerOptions in the same body', async () => {
    // Pins the escape hatch this build relies on: extraBody is merged into the request body
    // verbatim, and call-level providerOptions are merged on top of it rather than replacing
    // it. A provider upgrade that changes either merge order breaks here, not in production.
    let body: Record<string, unknown> = {};
    const fetchStub: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const model = createOpenRouter({ apiKey: 'k', fetch: fetchStub })('deepseek/deepseek-v4-flash-0731', {
      extraBody: { reasoning: { effort: 'max' }, provider: { require_parameters: true } },
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'p' }] }],
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    });

    expect(body.reasoning).toEqual({ effort: 'max' });
    // The routing restriction has to reach the wire intact, or reasoning silently becomes
    // best-effort again.
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });

  // extraBody is spread AFTER the provider's own body, which is the only reason a tier can
  // override the json_schema response_format `generateObject` always asks for. Asserting on
  // the serialized body is the only way to prove the override survives to the wire, and for
  // the `none` tier that the key is absent rather than null.
  describe('structured-output tier overrides', () => {
    async function sentBody(tier: StructuredOutputTier, effort?: Effort, known = true): Promise<Record<string, unknown>> {
      let body: Record<string, unknown> = {};
      const fetchStub: typeof fetch = async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      };
      const model = createOpenRouter({ apiKey: 'k', fetch: fetchStub })('stealth/ox-alpha', modelSettings(effort, tier, known));
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'p' }] }],
        responseFormat: { type: 'json', schema: { type: 'object' } },
      });
      return body;
    }

    it('leaves the json_schema response_format in place on the native tier', async () => {
      const body = await sentBody('native', 'high');
      expect((body.response_format as { type: string }).type).toBe('json_schema');
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.provider).toEqual({ require_parameters: true });
    });

    it('replaces it with json_object, keeping reasoning and the routing restriction', async () => {
      const body = await sentBody('json_object', 'high');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.provider).toEqual({ require_parameters: true });
    });

    it('drops the key entirely on the none tier', async () => {
      const body = await sentBody('none', 'high');
      expect('response_format' in body).toBe(false);
    });

    // Defect 1 on the wire: 29 of the 36 models on this tier take no reasoning efforts at all, so
    // an unguarded json_object ask is the common case for them, and an endpoint that doesn't
    // declare response_format answers prose instead of JSON.
    it('keeps the guard on the json_object tier with no effort configured', async () => {
      const body = await sentBody('json_object');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.provider).toEqual({ require_parameters: true });
      expect('reasoning' in body).toBe(false);
    });

    it('sends no provider block for a model nothing is known about, even with an effort', async () => {
      const body = await sentBody('native', 'high', false);
      expect(body.provider).toBeUndefined();
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect((body.response_format as { type: string }).type).toBe('json_schema');
    });

    // The SDK still asks for json_schema here, which is droppable, so a known-native model gets
    // the guard even with no reasoning to protect.
    it('guards the json_schema ask for a known native model with no effort', async () => {
      const body = await sentBody('native');
      expect(body.provider).toEqual({ require_parameters: true });
      expect((body.response_format as { type: string }).type).toBe('json_schema');
    });
  });
});

describe('AiSdkGenerator tracing', () => {
  it('records a parent llm.call and one llm.attempt per attempt', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
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
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
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
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock.mockResolvedValueOnce({ object: { pick: 'a' } });
    await gen.generate({ callsite: 'release-pick', schema: z.object({ pick: z.string() }), system: 's', prompt: 'p' });
    expect(new TraceEntries(db).summaries()).toHaveLength(0);
  });

  // A parse failure is the one error where the useful evidence is the answer itself: without
  // the raw text there is no way to tell a truncated response from a route that mangled it.
  it('carries the unparseable text, finish reason and usage into the failed llm.attempt payload', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'stealth/ox-alpha' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
    const usage = {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
    };
    generateObjectMock.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'no object generated',
        text: '{"contentType": "application/"}',
        response: { id: 'r1', timestamp: new Date(0), modelId: 'stealth/ox-alpha' },
        usage,
        finishReason: 'stop',
      }),
    );

    await expect(
      gen.generate({ callsite: 'release-pick', schema: z.object({ pick: z.string() }), system: 's', prompt: 'p', trace: { jobId: 9 } }),
    ).rejects.toThrow();

    const attempt = new TraceEntries(db).listByJob(9).find((r) => r.kind === 'llm.attempt');
    expect(JSON.parse(attempt?.payload ?? '')).toMatchObject({
      provider: 'openrouter',
      model: 'stealth/ox-alpha',
      text: '{"contentType": "application/"}',
      finishReason: 'stop',
      usage,
    });
  });

  // Everything else throws without a `text` to report, and the payload must not sprout empty
  // keys for it.
  it('leaves the raw-text fields off the payload for an error that is not a parse failure', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      gen.generate({ callsite: 'release-pick', schema: z.object({ pick: z.string() }), system: 's', prompt: 'p', trace: { jobId: 11 } }),
    ).rejects.toThrow();

    const attempt = new TraceEntries(db).listByJob(11).find((r) => r.kind === 'llm.attempt');
    const payload = JSON.parse(attempt?.payload ?? '') as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['error', 'model', 'provider']);
  });

  // Job #78's trace recorded the provider's words and not its status code, so nothing in it
  // said "429" and the backoff bug stayed invisible.
  it('records the provider status code on the failed llm.attempt payload', async () => {
    generateObjectMock.mockReset();
    const db = freshDb();
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    const gen = new AiSdkGenerator(() => cfg, new SqlTracer(db, new EventLog(db), () => true));
    generateObjectMock.mockRejectedValue(apiCallError(502));

    await expect(
      gen.generate({ callsite: 'release-pick', schema: z.object({ pick: z.string() }), system: 's', prompt: 'p', trace: { jobId: 13 } }),
    ).rejects.toThrow();

    const attempt = new TraceEntries(db).listByJob(13).find((r) => r.kind === 'llm.attempt');
    expect(JSON.parse(attempt?.payload ?? '')).toMatchObject({ provider: 'openrouter', model: 'primary-model', statusCode: 502 });
  });
});


describe('repairObjectText', () => {
  it('strips a ```json fence', () => {
    expect(repairObjectText('```json\n{"ok": true}\n```')).toBe('{"ok": true}');
  });

  it('strips a bare ``` fence, whatever the casing of its tag', () => {
    expect(repairObjectText('```JSON\n{"ok": true}\n```')).toBe('{"ok": true}');
    expect(repairObjectText('```\n{"ok": true}\n```')).toBe('{"ok": true}');
  });

  it('cuts the object out of a sentence of preamble', () => {
    expect(repairObjectText('Here is the answer: {"ok": true} — hope that helps.')).toBe('{"ok": true}');
  });

  it('handles a fence that also carries preamble inside it', () => {
    expect(repairObjectText('```json\nSure thing:\n{"ok": true}\n```')).toBe('{"ok": true}');
  });

  // Null is the SDK's "no repair", which leaves the original parse error to speak for itself.
  it('returns null for a clean object', () => {
    expect(repairObjectText('{"ok": true}')).toBeNull();
  });

  it('returns null when there is no brace pair to find', () => {
    expect(repairObjectText('I cannot answer that.')).toBeNull();
    expect(repairObjectText('{ but never closed')).toBeNull();
  });

  // Job 75: the fence landed INSIDE a string value, so nothing about it was anchored and an
  // anchored strip left the object exactly as broken as it arrived.
  it.each([
    [
      'a fence spliced inside a string value',
      '{"action": "open", "url": "https://acg.rip/t/12```html\n345", "note": "n"}',
      '{"action": "open", "url": "https://acg.rip/t/12345", "note": "n"}',
    ],
    [
      'an unclosed opening fence',
      '```json\n{"ok": true}',
      '{"ok": true}',
    ],
    [
      'a fence after the object',
      '{"ok": true}\n```',
      '{"ok": true}',
    ],
    [
      'prose either side of a fenced object',
      'Sure:\n```json\n{"ok": true}\n```\nLet me know.',
      '{"ok": true}',
    ],
  ])('recovers the object from %s', (_label, text, expected) => {
    expect(repairObjectText(text)).toBe(expected);
  });

  // Job 74: the model narrated the transcript back instead of answering. There is no object
  // in it, and inventing one would be worse than letting the parse error stand.
  it('returns null for a transcript-prose reply', () => {
    expect(repairObjectText('open https://acg.rip/t/123 -> OK\nopen https://acg.rip/t/124 -> OK')).toBeNull();
  });
});

describe('AiSdkGenerator object repair', () => {
  const schema = z.object({ ok: z.boolean() });

  /** A `generateObject` stand-in that answers with `text` and parses it the way the real SDK
   * does: try it, and on failure hand it to the call's own `repairText` hook before giving
   * up. Enough of the SDK's contract to prove the hook is wired and does the job. */
  function modelAnswering(text: string): (opts: unknown) => Promise<{ object: unknown }> {
    return async (opts) => {
      const { schema: callSchema, repairText } = opts as {
        schema: z.ZodType<unknown>;
        repairText?: (input: { text: string; error: Error }) => Promise<string | null>;
      };
      const error = new Error('could not parse the response');
      const repaired = (await repairText?.({ text, error })) ?? text;
      try {
        return { object: callSchema.parse(JSON.parse(repaired)) };
      } catch {
        throw error;
      }
    };
  }

  async function generateOnTier(tier: StructuredOutputTier, text: string): Promise<unknown> {
    generateObjectMock.mockReset();
    generateObjectMock.mockImplementation(modelAnswering(text));
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'stealth/ox-alpha', structuredOutput: tier };
    return new AiSdkGenerator(() => cfg).generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
  }

  it('recovers a fenced answer on the json_object tier without a second attempt', async () => {
    await expect(generateOnTier('json_object', '```json\n{"ok": true}\n```')).resolves.toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a fenced answer on the none tier without a second attempt', async () => {
    await expect(generateOnTier('none', '```json\n{"ok": true}\n```')).resolves.toEqual({ ok: true });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  // A route that declares structured outputs and still fences its answer has a problem worth
  // seeing, so nothing is quietly patched up there.
  it('sends no repair hook on the native tier', async () => {
    await expect(generateOnTier('native', '```json\n{"ok": true}\n```')).rejects.toThrow(LlmError);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });
});
