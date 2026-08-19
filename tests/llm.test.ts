import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, InvalidPromptError, NoObjectGeneratedError } from 'ai';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import type { Config, Effort } from '../src/config/schema.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { isPermanentError } from '../src/jobs/errors.js';
import { AiSdkGenerator, LlmError, resolveModel, withRetry, type EffortIgnoredInfo } from '../src/llm/generator.js';
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
} {
  const [opts] = generateObjectMock.mock.calls[index] as [
    {
      model: { settings: { extraBody?: Record<string, unknown> } };
      providerOptions?: { openrouter?: { cacheControl?: { type: string } } };
    },
  ];
  return { settings: opts.model.settings, providerOptions: opts.providerOptions };
}

describe('AiSdkGenerator provider-error classification', () => {
  const schema = z.object({ ok: z.boolean() });

  /** The shape the AI SDK actually throws for a non-2xx provider response. */
  function apiCallError(statusCode: number): APICallError {
    return new APICallError({
      message: `provider returned ${statusCode}`,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode,
    });
  }

  async function permanenceOf(thrown: unknown): Promise<boolean> {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValue(thrown);
    const cfg = keyedConfig();
    cfg.llm.model = { provider: 'openrouter', model: 'primary-model' };
    try {
      await new AiSdkGenerator(() => cfg).generate({ callsite: 'release-pick', schema, system: 's', prompt: 'p' });
    } catch (err) {
      return isPermanentError(err);
    }
    throw new Error('permanenceOf: generate() unexpectedly resolved');
  }

  it.each([400, 401, 403, 404, 422])('marks a %i from the provider permanent', async (status) => {
    expect(await permanenceOf(apiCallError(status))).toBe(true);
  });

  it.each([408, 429, 500, 503])('leaves a %i retryable', async (status) => {
    expect(await permanenceOf(apiCallError(status))).toBe(false);
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

  async function generateWith(model: Config['llm']['model'], promptCache = false): Promise<void> {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { ok: true } });
    const cfg = keyedConfig();
    cfg.llm.model = model;
    await new AiSdkGenerator(() => cfg).generate({
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
    expect(recordedCall().settings.extraBody).toBeUndefined();
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

type EffortIgnoredMock = Mock<(info: EffortIgnoredInfo) => void>;

describe('AiSdkGenerator ignored-effort detection', () => {
  const schema = z.object({ ok: z.boolean() });

  async function generateReporting(
    effort: Effort | undefined,
    reasoningTokens: number | undefined,
    opts?: { providerMetadata?: Record<string, unknown>; callback?: EffortIgnoredMock },
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
    await new AiSdkGenerator(() => cfg, NOOP_TRACER, onEffortIgnored).generate({
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
});
