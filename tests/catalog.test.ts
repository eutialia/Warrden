import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from '../src/llm/catalog.js';
import { baseConfig } from './helpers.js';

/** Stubs the global `fetch` with a canned response/rejection and hands back the spy so a
 * test can assert on the exact URL/headers sent, or on call count. Same idiom
 * `tests/arrClient.test.ts` uses for `ArrClient`. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn<typeof fetch>(impl as typeof fetch);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(data: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function upstreamModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'openai/gpt-5',
    canonical_slug: 'openai/gpt-5',
    name: 'GPT-5',
    description: 'a model',
    created: 0,
    context_length: 128_000,
    architecture: { modality: 'text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'x' },
    pricing: { prompt: '0.0000014', completion: '0.0000028' },
    top_provider: { context_length: 128_000, max_completion_tokens: 4096, is_moderated: false },
    supported_parameters: ['temperature'],
    reasoning: null,
    ...overrides,
  };
}

describe('ModelCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the public endpoint with no key configured', async () => {
    const spy = stubFetch(async () => jsonResponse([upstreamModel()]));
    const cfg = baseConfig();
    const catalog = new ModelCatalog(() => cfg);

    const result = await catalog.list();

    expect(result.models).toHaveLength(1);
    expect(result.stale).toBe(false);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('routes to /models/user with an Authorization header when a key is configured', async () => {
    const spy = stubFetch(async () => jsonResponse([upstreamModel()]));
    const cfg = baseConfig();
    cfg.llm.keys.openrouter = 'sk-test';
    const catalog = new ModelCatalog(() => cfg);

    await catalog.list();

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/models/user');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it.each([401, 500])('falls back to the public endpoint when /models/user fails with %i', async (status) => {
    const spy = stubFetch(async (url) => {
      if (url === 'https://openrouter.ai/api/v1/models/user') return new Response('nope', { status });
      return jsonResponse([upstreamModel()]);
    });
    const cfg = baseConfig();
    cfg.llm.keys.openrouter = 'sk-test';
    const catalog = new ModelCatalog(() => cfg);

    const result = await catalog.list();

    expect(result.models).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toBe('https://openrouter.ai/api/v1/models');
  });

  describe('reasoning shapes', () => {
    it.each([
      [
        'absent entirely',
        {},
        { supportedEfforts: [], mandatoryReasoning: false, reasoningCapable: false, hasDefaultEffort: false },
      ],
      [
        'explicitly null',
        { reasoning: null },
        { supportedEfforts: [], mandatoryReasoning: false, reasoningCapable: false, hasDefaultEffort: false },
      ],
      [
        'tiered with supported_efforts',
        { reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium' } },
        {
          supportedEfforts: ['low', 'medium', 'high'],
          mandatoryReasoning: false,
          reasoningCapable: true,
          hasDefaultEffort: true,
          defaultEffort: 'medium',
        },
      ],
      [
        'boolean-only (no supported_efforts key)',
        { reasoning: { mandatory: true } },
        { supportedEfforts: [], mandatoryReasoning: true, reasoningCapable: true, hasDefaultEffort: false },
      ],
      [
        'supported_efforts containing the literal "none" among real tiers',
        { reasoning: { mandatory: false, supported_efforts: ['none', 'low', 'high'] } },
        { supportedEfforts: ['low', 'high'], mandatoryReasoning: false, reasoningCapable: true, hasDefaultEffort: false },
      ],
    ] as const)('%s', async (_label, overrides, expected) => {
      stubFetch(async () => jsonResponse([upstreamModel(overrides)]));
      const catalog = new ModelCatalog(() => baseConfig());

      const result = await catalog.list();
      const model = result.models[0]!;

      expect(model.supportedEfforts).toEqual(expected.supportedEfforts);
      expect(model.mandatoryReasoning).toBe(expected.mandatoryReasoning);
      expect(model.reasoningCapable).toBe(expected.reasoningCapable);
      expect('defaultEffort' in model).toBe(expected.hasDefaultEffort);
      if ('defaultEffort' in expected) expect(model.defaultEffort).toBe(expected.defaultEffort);
    });
  });

  // The tier decides how `AiSdkGenerator` asks for JSON: an endpoint that doesn't declare
  // `structured_outputs` is dropped by `require_parameters` the moment a json_schema
  // response_format is sent, which is a 404 from OpenRouter, not a soft degrade.
  describe('structured-output tier', () => {
    it.each([
      ['structured_outputs declared', ['temperature', 'response_format', 'structured_outputs'], 'native'],
      ['response_format only', ['temperature', 'response_format'], 'json_object'],
      ['neither declared', ['temperature'], 'none'],
    ] as const)('%s', async (_label, supported, expected) => {
      stubFetch(async () => jsonResponse([upstreamModel({ supported_parameters: supported })]));
      const catalog = new ModelCatalog(() => baseConfig());

      const result = await catalog.list();

      expect(result.models[0]!.structuredOutput).toBe(expected);
    });

    it('assumes native when upstream reports no supported_parameters at all', async () => {
      stubFetch(async () => jsonResponse([upstreamModel({ supported_parameters: undefined })]));
      const catalog = new ModelCatalog(() => baseConfig());

      const result = await catalog.list();

      expect(result.models[0]!.structuredOutput).toBe('native');
    });
  });

  describe('capabilities', () => {
    it('returns the tier and reasoning mandate for a known model', async () => {
      stubFetch(async () =>
        jsonResponse([upstreamModel({ id: 'stealth/ox-alpha', supported_parameters: ['response_format'], reasoning: { mandatory: true } })]),
      );
      const catalog = new ModelCatalog(() => baseConfig());

      expect(await catalog.capabilities('stealth/ox-alpha')).toEqual({
        structuredOutput: 'json_object',
        mandatoryReasoning: true,
      });
    });

    it('serves from the same cache as list(), without a second fetch', async () => {
      const spy = stubFetch(async () => jsonResponse([upstreamModel()]));
      const catalog = new ModelCatalog(() => baseConfig());

      await catalog.list();
      await catalog.capabilities('openai/gpt-5');

      expect(spy).toHaveBeenCalledTimes(1);
    });

    // A generation must not fail because the catalog is unreachable: the caller reads
    // undefined as "assume native", which is the behaviour that predates the tiering.
    it('returns undefined instead of throwing when a cold-cache fetch fails', async () => {
      stubFetch(async () => new Response('down', { status: 500 }));
      const catalog = new ModelCatalog(() => baseConfig());

      await expect(catalog.capabilities('openai/gpt-5')).resolves.toBeUndefined();
    });

    it('returns undefined for a model id the catalog does not list', async () => {
      stubFetch(async () => jsonResponse([upstreamModel()]));
      const catalog = new ModelCatalog(() => baseConfig());

      await expect(catalog.capabilities('nobody/nothing')).resolves.toBeUndefined();
    });
  });

  it('drops a malformed entry without failing the whole batch', async () => {
    stubFetch(async () =>
      jsonResponse([upstreamModel({ id: 'good/model' }), { id: 42, name: null }, upstreamModel({ id: 'also-good/model' })]),
    );
    const catalog = new ModelCatalog(() => baseConfig());

    const result = await catalog.list();

    expect(result.models.map((m) => m.id)).toEqual(['good/model', 'also-good/model']);
  });

  it('projects id, name, contextLength and pricing straight through', async () => {
    stubFetch(async () => jsonResponse([upstreamModel({ id: 'x/y', name: 'X Y', context_length: 32_000, top_provider: { context_length: 16_000 }, pricing: { prompt: '0.000001', completion: '0.000002' } })]));
    const catalog = new ModelCatalog(() => baseConfig());

    const result = await catalog.list();

    expect(result.models[0]).toMatchObject({
      id: 'x/y',
      name: 'X Y',
      contextLength: 16_000, // top_provider.context_length preferred over the raw context_length
      pricing: { prompt: '0.000001', completion: '0.000002' },
    });
  });

  it('does not refetch within the TTL', async () => {
    const spy = stubFetch(async () => jsonResponse([upstreamModel()]));
    let now = 1_000;
    const catalog = new ModelCatalog(() => baseConfig(), () => now);

    await catalog.list();
    now += 5 * 60 * 1000; // 5 minutes later, still under the 10 minute TTL
    const result = await catalog.list();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.stale).toBe(false);
  });

  it('refetches once the TTL has expired', async () => {
    const spy = stubFetch(async () => jsonResponse([upstreamModel()]));
    let now = 1_000;
    const catalog = new ModelCatalog(() => baseConfig(), () => now);

    await catalog.list();
    now += 11 * 60 * 1000; // past the 10 minute TTL
    await catalog.list();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('serves the last good cache marked stale when a refetch fails', async () => {
    let fail = false;
    stubFetch(async () => {
      if (fail) return new Response('down', { status: 500 });
      return jsonResponse([upstreamModel()]);
    });
    let now = 1_000;
    const catalog = new ModelCatalog(() => baseConfig(), () => now);

    await catalog.list();
    fail = true;
    now += 11 * 60 * 1000;
    const result = await catalog.list();

    expect(result.stale).toBe(true);
    expect(result.models).toHaveLength(1);
  });

  it('throws when the fetch fails and there is no cache to fall back on', async () => {
    stubFetch(async () => new Response('down', { status: 500 }));
    const catalog = new ModelCatalog(() => baseConfig());

    await expect(catalog.list()).rejects.toThrow();
  });
});
