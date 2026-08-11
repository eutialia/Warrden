import { describe, expect, it } from 'vitest';
import { AgentActionSchema, runAgentLoop, TierBlockedError } from '../src/agent/loop.js';
import type { FetchOpts, FetchResult, FetchTier } from '../src/agent/tiers.js';
import { defaultProfileRow, FakeGenerator, tmpDir } from './helpers.js';

const PROFILE = defaultProfileRow('https://acg.rip');

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
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'Frieren', destDir: tmpDir(), maxSteps: 10, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'downloaded', filePath: '/dl/pack.zip', url: 'https://acg.rip/dl/123.zip', searchUrl: 'https://acg.rip/?term=frieren' });
    expect(tier.calls.map((c) => c.url)).toEqual(['https://acg.rip/?term=frieren', 'https://acg.rip/t/123', 'https://acg.rip/dl/123.zip']);
  });

  it('returns exhausted at the step budget', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }),
      act({ action: 'search', url: 'https://acg.rip/?term=y', note: 's' }),
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 2, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'exhausted' });
  });

  it('returns gave-up when the LLM does', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nothing here' })]);
    const out = await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up' });
  });

  it('throws TierBlockedError when the tier reports a bot wall', async () => {
    const llm = new FakeGenerator([act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' })]);
    const tier = fakeTier([{ ok: false, status: 403, body: 'Attention Required! | Cloudflare', blocked: true }]);
    await expect(
      runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} }),
    ).rejects.toBeInstanceOf(TierBlockedError);
  });

  it('emits a transcript entry per step', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 'searching' }),
      act({ action: 'give_up', url: '', note: 'nope' }),
    ]);
    const tier = fakeTier([OK_HTML]);
    const entries: unknown[] = [];
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
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
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
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
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls[0]!.opts).toEqual({ method: 'GET' });
  });

  it('refuses request to a foreign host without fetching', async () => {
    const llm = new FakeGenerator([
      act({ action: 'request', url: 'https://evil.test/admin', note: 'probe foreign host', method: 'POST', body: '{}' }),
      act({ action: 'give_up', url: '', note: 'stopped' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain('request refused: https://evil.test/admin is not on acg.rip');
  });

  it.each([
    ['exact host match', { baseUrl: 'https://acg.rip' }, 'https://acg.rip/api'],
    ['sibling subdomain (cdn next to the bare site)', { baseUrl: 'https://acg.rip' }, 'https://cdn.acg.rip/api'],
    ['parent host of the site (www stripped)', { baseUrl: 'https://auth.acg.rip' }, 'https://acg.rip/api'],
    ['sibling host with www on the site side', { baseUrl: 'https://www.acg.rip' }, 'https://cdn.acg.rip/api'],
  ])('request accepts a same-site destination: %s', async (_name, site, url) => {
    const llm = new FakeGenerator([
      act({ action: 'request', url, note: 'same-site probe', method: 'GET' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'ok', blocked: false }]);
    await runAgentLoop({ llm, tier, site, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(1);
  });

  it.each([
    ['unrelated foreign host', 'https://evil.test/api'],
    ['host that merely contains the site name', 'https://acg.rip.evil.test/api'],
    ['different scheme, same host', 'http://acg.rip/api'],
  ])('request rejects a genuinely foreign destination: %s', async (_name, url) => {
    const llm = new FakeGenerator([
      act({ action: 'request', url, note: 'foreign probe', method: 'GET' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
  });

  it.each([
    ['search', 'search'],
    ['open', 'open'],
    ['request', 'request'],
    ['download', 'download'],
  ] as const)('%s refuses a private/loopback destination without fetching', async (_name, action) => {
    const llm = new FakeGenerator([
      act({ action, url: 'http://127.0.0.1:8080/admin', note: 'probe lan' }),
      act({ action: 'give_up', url: '', note: 'stopped' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', filePath: '/dl/x', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain(`${action} refused: http://127.0.0.1:8080/admin targets a private/loopback address`);
  });

  it.each([
    ['loopback IPv4', 'http://127.0.0.1/x'],
    ['loopback IPv6', 'http://[::1]/x'],
    ['localhost name', 'http://localhost/x'],
    ['private 10/8', 'http://10.0.0.5/x'],
    ['private 172.16/12', 'http://172.20.1.1/x'],
    ['private 192.168/16', 'http://192.168.1.1/x'],
    ['link-local 169.254/16', 'http://169.254.1.1/x'],
    ['cloud metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['unique-local IPv6', 'http://[fd00::1]/x'],
  ])('open refuses %s and continues rather than throwing', async (_name, url) => {
    const llm = new FakeGenerator([act({ action: 'open', url, note: 'probe' }), act({ action: 'give_up', url: '', note: 'stopped' })]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up' });
    expect(tier.calls).toHaveLength(0);
  });

  it.each([
    ['public host, not private', 'https://cdn.example.test/x'],
    ['acg.rip itself', 'https://acg.rip/x'],
  ])('open does not refuse %s', async (_name, url) => {
    const llm = new FakeGenerator([act({ action: 'open', url, note: 'probe' }), act({ action: 'give_up', url: '', note: 'stopped' })]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'fine', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(1);
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
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out.kind).toBe('downloaded');
    expect(tier.calls[0]!.opts).toMatchObject({ destPath: expect.any(String), referer: 'https://acg.rip/t/123' });
  });

  it('injects rendered knowledge and no longer reads profile notes', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'done' })]);
    const profile = { ...PROFILE, notes: 'SHOULD NOT APPEAR' };
    await runAgentLoop({
      llm,
      tier: fakeTier([]),
      site: SITE,
      profile,
      knowledge: 'Site knowledge:\n- IF searching THEN GET /s. (confirmed 2026-08-10)',
      query: 'F',
      destDir: tmpDir(),
      maxSteps: 1,
      onTranscript: () => {},
    });
    const { system } = llm.calls[0]!;
    expect(system).toContain('IF searching THEN GET /s.');
    expect(system).not.toContain('SHOULD NOT APPEAR');
  });

  it('injects nothing when knowledge is empty (no stray heading)', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'done' })]);
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
    const { system } = llm.calls[0]!;
    expect(system).not.toContain('Site knowledge');
    expect(system).not.toContain('undefined');
  });

  it('joins action bullets as separate lines and states download/cookie/elision rules', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nope' })]);
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
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
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 10, onTranscript: () => {} });

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
