import { describe, expect, it } from 'vitest';
import { AgentActionSchema, runAgentLoop, TierBlockedError } from '../src/agent/loop.js';
import type { FetchOpts, FetchResult, FetchTier } from '../src/agent/tiers.js';
import type { SiteProfileRow } from '../src/db/siteProfiles.js';
import { FakeGenerator, tmpDir } from './helpers.js';

const PROFILE: SiteProfileRow = {
  base_url: 'https://acg.rip', last_working_tier: null,
  search_url_patterns: [], notes: '', last_success_at: null, last_failure_at: null, fail_count: 0, created_at: 0,
};

/** Fill required sentinel fields so FakeGenerator's schema.parse accepts partial actions. */
function act(
  partial: {
    action: 'search' | 'open' | 'download' | 'request' | 'give_up';
    url: string;
    note: string;
    method?: 'GET' | 'POST';
    body?: string;
    contentType?: string;
    referer?: string;
  },
) {
  return {
    method: 'GET' as const,
    body: '',
    contentType: '',
    referer: '',
    ...partial,
  };
}

function fakeTier(results: FetchResult[]): FetchTier & { calls: { url: string; opts?: FetchOpts }[] } {
  const calls: { url: string; opts?: FetchOpts }[] = [];
  return {
    tier: 'curl',
    calls,
    fetch: async (url: string, opts?: FetchOpts) => {
      calls.push({ url, opts });
      return results.shift() ?? { ok: false, blocked: false };
    },
    close: async () => {},
  };
}

const SITE = { baseUrl: 'https://acg.rip', searchUrlTemplate: 'https://acg.rip/?term={query}' };

const OK_HTML = { ok: true, status: 200, body: '<html>results</html>', blocked: false };

describe('runAgentLoop', () => {
  it('downloads and returns the file path when the LLM walks search -> open -> download', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=frieren', note: 'searching' }),
      act({ action: 'open', url: 'https://acg.rip/t/123', note: 'found pack page' }),
      act({ action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'downloading batch' }),
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML, { ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'Frieren', destDir: tmpDir(), maxSteps: 10, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'downloaded', filePath: '/dl/pack.zip', url: 'https://acg.rip/dl/123.zip', searchUrl: 'https://acg.rip/?term=frieren' });
    expect(tier.calls.map((c) => c.url)).toEqual(['https://acg.rip/?term=frieren', 'https://acg.rip/t/123', 'https://acg.rip/dl/123.zip']);
  });

  it('returns exhausted at the step budget', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }),
      act({ action: 'search', url: 'https://acg.rip/?term=y', note: 's' }),
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 2, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'exhausted' });
  });

  it('returns gave-up when the LLM does', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nothing here' })]);
    const out = await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up' });
  });

  it('throws TierBlockedError when the tier reports a bot wall', async () => {
    const llm = new FakeGenerator([act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' })]);
    const tier = fakeTier([{ ok: false, status: 403, body: 'Attention Required! | Cloudflare', blocked: true }]);
    await expect(
      runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} }),
    ).rejects.toBeInstanceOf(TierBlockedError);
  });

  it('emits a transcript entry per step', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 'searching' }),
      act({ action: 'give_up', url: '', note: 'nope' }),
    ]);
    const tier = fakeTier([OK_HTML]);
    const entries: unknown[] = [];
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
    expect(entries).toHaveLength(2);
  });

  it('passes request method, body, contentType, and referer to the tier and records the response body', async () => {
    const llm = new FakeGenerator([
      act({
        action: 'request',
        url: 'https://acg.rip/api/dl',
        note: 'protocol step',
        method: 'POST',
        body: '{"id":"s1"}',
        contentType: 'application/json',
        referer: 'https://acg.rip/a/s1',
      }),
      act({ action: 'give_up', url: '', note: 'done probing' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: '{"url":"https://cdn/x.zip"}', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(1);
    expect(tier.calls[0]).toEqual({
      url: 'https://acg.rip/api/dl',
      opts: {
        method: 'POST',
        body: '{"id":"s1"}',
        contentType: 'application/json',
        referer: 'https://acg.rip/a/s1',
      },
    });
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain('request POST https://acg.rip/api/dl -> OK:');
    expect(secondPrompt).toContain('{"url":"https://cdn/x.zip"}');
  });

  it('does not forward body or contentType on a GET request', async () => {
    const llm = new FakeGenerator([
      act({
        action: 'request',
        url: 'https://acg.rip/api/x',
        note: 'get step',
        method: 'GET',
        body: 'should-not-send',
        contentType: 'application/json',
      }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'ok', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls[0]!.opts).toEqual({ method: 'GET' });
  });

  it('refuses request to a foreign host without fetching', async () => {
    const llm = new FakeGenerator([
      act({ action: 'request', url: 'http://127.0.0.1:8080/admin', note: 'probe lan', method: 'POST', body: '{}' }),
      act({ action: 'give_up', url: '', note: 'stopped' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain('request refused: http://127.0.0.1:8080/admin is not on acg.rip');
  });

  it('passes referer on download to the tier', async () => {
    const llm = new FakeGenerator([
      act({
        action: 'download',
        url: 'https://acg.rip/dl/123.zip',
        note: 'dl with referer',
        referer: 'https://acg.rip/t/123',
      }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out.kind).toBe('downloaded');
    expect(tier.calls[0]!.opts).toMatchObject({ destPath: expect.any(String), referer: 'https://acg.rip/t/123' });
  });

  it('injects profile notes into the system prompt as site protocol notes', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nope' })]);
    const profile = { ...PROFILE, notes: 'POST /ajax with cookie from home page first' };
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile, query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
    expect(llm.calls[0]!.system).toContain('Site protocol notes');
    expect(llm.calls[0]!.system).toContain('POST /ajax with cookie from home page first');
  });

  it('joins action bullets as separate lines and states download/cookie/elision rules', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nope' })]);
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
    const system = llm.calls[0]!.system;
    expect(system).toContain('- search:');
    expect(system).toContain('\n- open:');
    expect(system).toContain('Only download saves a file');
    expect(system).toContain('Cookies persist automatically');
    expect(system).toContain('Older observations in the transcript are elided');
  });

  it('elides older observations in the rendered prompt while keeping the latest full', async () => {
    const longA = 'A'.repeat(1500);
    const longB = 'B'.repeat(1500);
    const longC = 'C'.repeat(1500);
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=1', note: 's1' }),
      act({ action: 'open', url: 'https://acg.rip/t/2', note: 's2' }),
      act({ action: 'open', url: 'https://acg.rip/t/3', note: 's3' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([
      { ok: true, status: 200, body: longA, blocked: false },
      { ok: true, status: 200, body: longB, blocked: false },
      { ok: true, status: 200, body: longC, blocked: false },
    ]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 10, onTranscript: () => {} });

    // After 3 steps the 4th prompt (give_up call) should elide steps 1–2 and keep step 3 full.
    const prompt = llm.calls[3]!.prompt;
    expect(prompt).toContain('…[elided]');
    // Latest observation (longC) appears in full.
    expect(prompt).toContain(longC);
    // Older long bodies are truncated — full 1500-char runs must not both appear.
    expect(prompt).not.toContain(longA);
    expect(prompt).not.toContain(longB);
    // Truncated prefixes of the older observations are still present.
    expect(prompt).toContain(longA.slice(0, 1000));
    expect(prompt).toContain(longB.slice(0, 1000));
  });

  it('strict-mode schema requires every action field (no optional)', () => {
    // Zod 4: optional fields wrap as ZodOptional; required sentinels must parse without defaults.
    const shape = AgentActionSchema.shape;
    for (const key of ['action', 'url', 'note', 'method', 'body', 'contentType', 'referer'] as const) {
      expect(shape[key].isOptional()).toBe(false);
      expect(shape[key].def.type).not.toBe('optional');
    }
    // Incomplete payload is rejected; complete sentinel payload is accepted.
    expect(() => AgentActionSchema.parse({ action: 'give_up', url: '', note: 'x' })).toThrow();
    expect(
      AgentActionSchema.parse({
        action: 'give_up',
        url: '',
        note: 'x',
        method: 'GET',
        body: '',
        contentType: '',
        referer: '',
      }),
    ).toMatchObject({ action: 'give_up', method: 'GET', body: '' });
  });
});
