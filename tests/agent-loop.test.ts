import { describe, expect, it } from 'vitest';
import { AgentActionSchema, runAgentLoop, TierBlockedError } from '../src/agent/loop.js';
import type { FetchOpts, FetchResult, FetchTier } from '../src/agent/tiers.js';
import type { TranscriptEntry } from '../src/db/subtitleRuns.js';
import { defaultProfileRow, FakeGenerator, tmpDir } from './helpers.js';
import { parseFailure } from './llmFixtures.js';

const PROFILE = defaultProfileRow('https://acg.rip');

/** Fill required sentinel fields so FakeGenerator's schema.parse accepts partial actions. */
function act(
  partial: {
    action: 'search' | 'open' | 'download' | 'request' | 'give_up';
    url: string;
    note: string;
    reason?: string;
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
    reason: '',
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
    expect(out).toEqual({ kind: 'downloaded', steps: 3, filePath: '/dl/pack.zip', url: 'https://acg.rip/dl/123.zip', searchUrl: 'https://acg.rip/?term=frieren' });
    expect(tier.calls.map((c) => c.url)).toEqual(['https://acg.rip/?term=frieren', 'https://acg.rip/t/123', 'https://acg.rip/dl/123.zip']);
  });

  it('returns exhausted at the step budget', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }),
      act({ action: 'search', url: 'https://acg.rip/?term=y', note: 's' }),
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 2, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'exhausted', steps: 2 });
  });

  it('returns gave-up with the model own reason and the steps it took', async () => {
    const llm = new FakeGenerator([
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }),
      act({ action: 'give_up', url: '', note: 'nothing here', reason: 'the site lists nothing for this season yet' }),
    ]);
    const out = await runAgentLoop({ llm, tier: fakeTier([OK_HTML]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up', steps: 2, reason: 'the site lists nothing for this season yet' });
  });

  it('falls back to a stated-nothing reason when give_up carries no sentence', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nothing here' })]);
    const out = await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up', steps: 1, reason: 'no reason given' });
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

  it('records the error page text alongside the status when a request fails', async () => {
    const llm = new FakeGenerator([
      act({ action: 'request', url: 'https://acg.rip/down/uE7Rx2', note: 'protocol step', method: 'GET' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([
      {
        ok: false,
        status: 403,
        body: '<html><head><title>Download page expired</title></head><body><p>Go back to the detail page and download again.</p></body></html>',
        blocked: false,
      },
    ]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain(
      'request GET https://acg.rip/down/uE7Rx2 -> HTTP 403: Download page expired Go back to the detail page and download again.',
    );
    expect(secondPrompt).not.toContain('<title>');
    expect(secondPrompt).not.toContain('<p>');
  });

  it('records the error page text alongside the status when an open fails', async () => {
    const llm = new FakeGenerator([
      act({ action: 'open', url: 'https://acg.rip/t/123', note: 'opening' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([
      { ok: false, status: 403, body: '<div class="err">Session expired,\n  please sign in.</div>', blocked: false },
    ]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain('open https://acg.rip/t/123 -> HTTP 403: Session expired, please sign in.');
    expect(secondPrompt).not.toContain('<div');
  });

  it('records only the status when the failed response has no body text', async () => {
    const llm = new FakeGenerator([
      act({ action: 'open', url: 'https://acg.rip/t/123', note: 'opening' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([{ ok: false, status: 403, body: '', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    const secondPrompt = llm.calls[1]!.prompt;
    expect(secondPrompt).toContain('open https://acg.rip/t/123 -> HTTP 403');
    expect(secondPrompt).not.toContain('HTTP 403:');
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
    ['same site on a non-default port', { baseUrl: 'https://acg.rip' }, 'https://cdn.acg.rip:8443/api'],
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
    ['the bare TLD above the site', 'https://rip/api'],
  ])('request rejects a genuinely foreign destination: %s', async (_name, url) => {
    const llm = new FakeGenerator([
      act({ action: 'request', url, note: 'foreign probe', method: 'GET' }),
      act({ action: 'give_up', url: '', note: 'done' }),
    ]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
  });

  /** Every spelling of a private/loopback destination the guard must refuse. The IPv4
   * forms Node's URL parser rewrites (integer, octal, trailing dot) are here beside the
   * ones it leaves alone, because the guard sees the parser's output and not the text the
   * model wrote — and the IPv4-mapped IPv6 forms are here because that rewriting is what
   * once turned `[::ffff:169.254.169.254]` into a spelling no range test recognized. */
  const PRIVATE_URLS: [string, string][] = [
    ['loopback IPv4', 'http://127.0.0.1/x'],
    ['loopback IPv4, another /8 address', 'http://127.9.9.9/x'],
    ['loopback IPv4 as an integer', 'http://2130706433/x'],
    ['loopback IPv4 with a trailing dot', 'http://127.0.0.1./x'],
    ['loopback IPv6', 'http://[::1]/x'],
    ['unspecified IPv6', 'http://[::]/x'],
    ['all-zeroes IPv4', 'http://0.0.0.0/x'],
    ['localhost name', 'http://localhost/x'],
    ['localhost with a trailing dot', 'http://localhost./x'],
    ['subdomain of localhost', 'http://api.localhost/x'],
    ['LOCALHOST uppercased', 'http://LOCALHOST/x'],
    ['userinfo pointing at loopback', 'http://acg.rip@127.0.0.1/x'],
    ['private 10/8', 'http://10.0.0.5/x'],
    ['private 172.16/12', 'http://172.20.1.1/x'],
    ['private 192.168/16', 'http://192.168.1.1/x'],
    ['link-local 169.254/16', 'http://169.254.1.1/x'],
    ['cloud metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['unique-local IPv6', 'http://[fd00::1]/x'],
    ['unique-local IPv6, fc half of the /7', 'http://[fc00::1]/x'],
    ['link-local IPv6 fe80::/10', 'http://[fe80::1]/x'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/x'],
    ['IPv4-mapped IPv6 metadata address', 'http://[::ffff:169.254.169.254]/latest/meta-data'],
    ['IPv4-mapped IPv6 private 10/8', 'http://[::ffff:10.0.0.1]/x'],
    ['IPv4-mapped IPv6 private 192.168/16', 'http://[::ffff:192.168.0.1]/x'],
    ['IPv4-mapped IPv6 written in hex groups', 'http://[::ffff:7f00:1]/x'],
    ['IPv4-compatible IPv6', 'http://[::127.0.0.1]/x'],
    ['IPv4-translated IPv6', 'http://[::ffff:0:127.0.0.1]/x'],
    ['6to4 IPv6 wrapping a private IPv4', 'http://[2002:a00:1::]/x'],
    ['6to4 IPv6 wrapping the metadata address', 'http://[2002:a9fe:a9fe::]/x'],
    ['NAT64 well-known prefix over the metadata address', 'http://[64:ff9b::a9fe:a9fe]/x'],
    // The local-use prefix (RFC 8215) is what an operator-run NAT64 actually uses, and it
    // is refused whole — where the IPv4 address sits inside it is the gateway's choice.
    ['NAT64 local-use prefix over the metadata address', 'http://[64:ff9b:1::a9fe:a9fe]/x'],
    ['NAT64 local-use prefix, whatever it wraps', 'http://[64:ff9b:1:ffff::1]/x'],
    ['deprecated site-local IPv6', 'http://[fec0::1]/x'],
  ];

  it.each(
    (['search', 'open', 'request', 'download'] as const).flatMap((action) =>
      PRIVATE_URLS.map(([name, url]) => [action, name, url] as const),
    ),
  )('%s refuses %s and continues rather than throwing', async (action, _name, url) => {
    const llm = new FakeGenerator([act({ action, url, note: 'probe' }), act({ action: 'give_up', url: '', note: 'stopped' })]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', filePath: '/dl/x', blocked: false }]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toMatchObject({ kind: 'gave-up', steps: 2 });
    expect(tier.calls).toHaveLength(0);
    expect(llm.calls[1]!.prompt).toContain(`${action} refused: ${url} targets a private/loopback address`);
  });

  it.each([
    ['public host, not private', 'https://cdn.example.test/x'],
    ['acg.rip itself', 'https://acg.rip/x'],
    ['a public IPv4 address', 'http://8.8.8.8/x'],
    ['a public IPv6 address', 'http://[2606:4700::1111]/x'],
    ['a public IPv4 address mapped into IPv6', 'http://[::ffff:8.8.8.8]/x'],
    ['172.32/16, just past the private range', 'http://172.32.0.1/x'],
    ['192.169/16, just past the private range', 'http://192.169.0.1/x'],
    ['a host whose name merely ends in localhost', 'https://mylocalhost.test/x'],
    ['6to4 IPv6 wrapping a public IPv4', 'http://[2002:808:808::]/x'],
    ['NAT64 well-known prefix over a public IPv4', 'http://[64:ff9b::808:808]/x'],
  ])('open does not refuse %s', async (_name, url) => {
    const llm = new FakeGenerator([act({ action: 'open', url, note: 'probe' }), act({ action: 'give_up', url: '', note: 'stopped' })]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'fine', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(1);
  });

  it.each([
    ['a bare word', 'metadata'],
    ['a scheme-less host', 'acg.rip/t/1'],
  ])('refuses a URL that will not parse (%s) rather than handing it to the tier', async (_name, url) => {
    const llm = new FakeGenerator([act({ action: 'open', url, note: 'probe' }), act({ action: 'give_up', url: '', note: 'stopped' })]);
    const tier = fakeTier([{ ok: true, status: 200, body: 'should-not-see', blocked: false }]);
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(tier.calls).toHaveLength(0);
    expect(llm.calls[1]!.prompt).toContain(`open refused: ${url} is not a usable URL`);
  });

  /** A refusal that only shows up as "the step failed" reads like a clumsy model. It has
   * to be in the transcript as a refusal, and the private/loopback variant has to carry
   * the level that puts it in front of a human. */
  it.each([
    ['private/loopback destination', act({ action: 'open', url: 'http://169.254.169.254/latest/meta-data', note: 'probe' }), 'attention', 'targets a private/loopback address'],
    ['unparseable URL', act({ action: 'open', url: 'metadata', note: 'probe' }), undefined, 'is not a usable URL'],
    ['foreign host on request', act({ action: 'request', url: 'https://evil.test/api', note: 'probe', method: 'GET' }), undefined, 'is not on acg.rip'],
  ])('records the refusal of a %s in the transcript', async (_name, action, level, reason) => {
    const llm = new FakeGenerator([action, act({ action: 'give_up', url: '', note: 'stopped' })]);
    const entries: TranscriptEntry[] = [];
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
    const refusals = entries.filter((e) => e.action === 'refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.detail).toContain(reason);
    expect(refusals[0]!.level).toBe(level);
  });

  it.each(['search', 'open', 'download'] as const)(
    'reports a redirect hop the tier refused as a refusal of the %s step',
    async (action) => {
      const refusedUrl = 'http://169.254.169.254/latest/meta-data';
      const llm = new FakeGenerator([
        act({ action, url: 'https://acg.rip/t/1', note: 'probe' }),
        act({ action: 'give_up', url: '', note: 'stopped' }),
      ]);
      const tier = fakeTier([{ ok: false, blocked: false, refusedUrl }]);
      const entries: TranscriptEntry[] = [];
      const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
      expect(out).toMatchObject({ kind: 'gave-up', steps: 2 });
      const refusal = entries.find((e) => e.action === 'refused');
      expect(refusal?.level).toBe('attention');
      expect(refusal?.detail).toBe(
        `${action} refused: https://acg.rip/t/1 redirected to ${refusedUrl}, which targets a private/loopback address`,
      );
      // The step must not read as an ordinary failure in the next prompt either.
      expect(llm.calls[1]!.prompt).toContain(`redirected to ${refusedUrl}`);
      expect(llm.calls[1]!.prompt).not.toContain('-> FAILED');
    },
  );

  it('reports a Location the tier could not parse as a refusal of that step, without ending the run', async () => {
    const refusedUrl = '//[::1';
    const llm = new FakeGenerator([
      ...new Array(4).fill(null).map(() => act({ action: 'open', url: 'https://acg.rip/t/1', note: 'probe' })),
    ]);
    const tier = fakeTier(
      new Array(4).fill(null).map(() => ({ ok: false, blocked: false, refusedUrl, refusedReason: 'unparseable' as const })),
    );
    const entries: TranscriptEntry[] = [];
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 4, onTranscript: (e) => entries.push(e) });
    expect(out).toEqual({ kind: 'exhausted', steps: 4 });
    const refusals = entries.filter((e) => e.action === 'refused');
    expect(refusals).toHaveLength(4);
    expect(refusals[0]!.level).toBeUndefined();
    expect(refusals[0]!.detail).toBe(`open refused: https://acg.rip/t/1 redirected to ${refusedUrl}, which is not a usable URL`);
  });

  /** A refused URL is echoed into the next prompt, and a hostile site chooses its own
   * `Location` header — so it is bounded like every other thing a page puts there. */
  it('caps a refused redirect URL in the history line', async () => {
    const refusedUrl = `http://169.254.169.254/${'a'.repeat(5000)}`;
    const llm = new FakeGenerator([
      act({ action: 'open', url: 'https://acg.rip/t/1', note: 'probe' }),
      act({ action: 'give_up', url: '', note: 'stopped' }),
    ]);
    const tier = fakeTier([{ ok: false, blocked: false, refusedUrl, refusedReason: 'private' as const }]);
    const entries: TranscriptEntry[] = [];
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
    const detail = entries.find((e) => e.action === 'refused')!.detail;
    expect(detail).toContain('…[elided]');
    expect(detail).not.toContain('a'.repeat(300));
    expect(llm.calls[1]!.prompt).not.toContain('a'.repeat(300));
  });

  it('counts refused redirect hops toward the refusal limit', async () => {
    const llm = new FakeGenerator(
      new Array(5).fill(null).map(() => act({ action: 'open', url: 'https://acg.rip/t/1', note: 'probe' })),
    );
    const tier = fakeTier(new Array(5).fill(null).map(() => ({ ok: false, blocked: false, refusedUrl: 'http://[::1]/x' })));
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 20, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'refused-repeatedly', refusals: 3, steps: 3 });
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

  it('injects rendered knowledge into the prompt', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'done' })]);
    await runAgentLoop({
      llm,
      tier: fakeTier([]),
      site: SITE,
      profile: PROFILE,
      knowledge: 'Site knowledge:\n- IF searching THEN GET /s. (confirmed 2026-08-10)',
      query: 'F',
      destDir: tmpDir(),
      maxSteps: 1,
      onTranscript: () => {},
    });
    const { system } = llm.calls[0]!;
    expect(system).toContain('IF searching THEN GET /s.');
  });

  it('injects nothing when knowledge is empty (no stray heading)', async () => {
    // Discriminating against the same call with knowledge: the assertion is that the block
    // and its markdown heading are absent, not that some literal nobody emits is absent.
    const knowledge = '## Search\n- IF searching THEN GET /s. (confirmed 2026-08-10)';
    const run = async (k: string): Promise<string> => {
      const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'done' })]);
      await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: k, query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
      return llm.calls[0]!.system!;
    };

    const withKnowledge = await run(knowledge);
    const without = await run('');
    expect(withKnowledge).toContain('## Search');
    expect(without).not.toContain('## ');
    expect(without).not.toContain('undefined');
    // Nothing but the knowledge block differs between the two prompts.
    expect(withKnowledge.replace(`${knowledge}\n`, '')).toBe(without);
  });

  it('gives up on the site after three refused destinations instead of spending the budget', async () => {
    const llm = new FakeGenerator(
      new Array(5).fill(null).map(() => act({ action: 'open', url: 'http://169.254.169.254/latest/meta-data', note: 'probe' })),
    );
    const tier = fakeTier([]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 20, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'refused-repeatedly', refusals: 3, steps: 3 });
    expect(llm.calls).toHaveLength(3);
  });

  /** Ending a site run costs a failed site, a fail_count bump and backoff. Only the
   * refusals a human is shown (private/loopback) buy that; a model slip fails its own step
   * and the run keeps its budget. */
  it.each([
    ['a protocol-relative URL the guard cannot parse', act({ action: 'search', url: '//acg.rip/search?q=x', note: 'probe' })],
    ['a request aimed off-site', act({ action: 'request', url: 'https://evil.test/api', note: 'probe', method: 'GET' })],
  ])('does not end the run over %s', async (_name, action) => {
    const llm = new FakeGenerator(new Array(6).fill(null).map(() => action));
    const entries: TranscriptEntry[] = [];
    const out = await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 6, onTranscript: (e) => entries.push(e) });
    expect(out).toEqual({ kind: 'exhausted', steps: 6 });
    // Every step still refused, and every refusal still reached the transcript.
    expect(entries.filter((e) => e.action === 'refused')).toHaveLength(6);
  });

  it('tells the agent a fresh episode with nothing listed is a give_up, not a longer hunt', async () => {
    const llm = new FakeGenerator([act({ action: 'give_up', url: '', note: 'nope' })]);
    await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, knowledge: '', query: 'F', destDir: tmpDir(), maxSteps: 1, onTranscript: () => {} });
    expect(llm.calls[0]!.system).toContain(
      'When every missing episode aired within the last 7 days and the site shows nothing for them, give_up: subtitles for a fresh episode usually do not exist yet, and the next scheduled run will look again.',
    );
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

  it('treats a malformed reply as a bad step and carries on once the model recovers', async () => {
    const llm = new FakeGenerator([
      parseFailure(),
      act({ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }),
      parseFailure(),
      parseFailure(),
      act({ action: 'give_up', url: '', note: 'done', reason: 'nothing listed' }),
    ]);
    const transcript: TranscriptEntry[] = [];
    const out = await runAgentLoop({
      llm,
      tier: fakeTier([OK_HTML]),
      site: SITE,
      profile: PROFILE,
      knowledge: '',
      query: 'F',
      destDir: tmpDir(),
      maxSteps: 10,
      onTranscript: (e) => transcript.push(e),
    });
    expect(out).toEqual({ kind: 'gave-up', steps: 5, reason: 'nothing listed' });
    expect(transcript.filter((e) => e.action === 'malformed')).toHaveLength(3);
    // The correction rides in the next prompt, or the model has no idea what went wrong.
    const lastPrompt = llm.calls.at(-1)!.prompt;
    expect(lastPrompt).toContain('previous reply was not valid JSON');
  });

  it('stops the site after three consecutive malformed replies', async () => {
    const llm = new FakeGenerator([parseFailure(), parseFailure(), parseFailure(), act({ action: 'search', url: 'https://acg.rip/?t=x', note: 's' })]);
    const out = await runAgentLoop({
      llm,
      tier: fakeTier([OK_HTML]),
      site: SITE,
      profile: PROFILE,
      knowledge: '',
      query: 'F',
      destDir: tmpDir(),
      maxSteps: 10,
      onTranscript: () => {},
    });
    expect(out).toEqual({ kind: 'malformed-repeatedly', failures: 3, steps: 3 });
    // The fourth queued action was never asked for.
    expect(llm.calls).toHaveLength(3);
  });

  it('rethrows an error that is not a parse failure', async () => {
    const llm = new FakeGenerator([new Error('provider is down')]);
    await expect(
      runAgentLoop({
        llm,
        tier: fakeTier([]),
        site: SITE,
        profile: PROFILE,
        knowledge: '',
        query: 'F',
        destDir: tmpDir(),
        maxSteps: 10,
        onTranscript: () => {},
      }),
    ).rejects.toThrow('provider is down');
  });

  it('strict-mode schema requires every action field (no optional)', () => {
    // Zod 4: optional fields wrap as ZodOptional; required sentinels must parse without defaults.
    const shape = AgentActionSchema.shape;
    for (const key of ['action', 'url', 'note', 'method', 'body', 'contentType', 'referer', 'reason'] as const) {
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
        reason: '',
      }),
    ).toMatchObject({ action: 'give_up', method: 'GET', body: '' });
  });
});
