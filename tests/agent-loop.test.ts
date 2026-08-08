import { describe, expect, it } from 'vitest';
import { runAgentLoop, TierBlockedError, type AgentAction } from '../src/agent/loop.js';
import type { FetchResult, FetchTier } from '../src/agent/tiers.js';
import type { SiteProfileRow } from '../src/db/siteProfiles.js';
import { FakeGenerator, tmpDir } from './helpers.js';

const PROFILE: SiteProfileRow = {
  name: 'acgrip', base_url: 'https://acg.rip', last_working_tier: null,
  search_url_patterns: [], notes: '', last_success_at: null, last_failure_at: null, fail_count: 0, created_at: 0,
};

function fakeTier(results: FetchResult[]): FetchTier & { urls: string[] } {
  const urls: string[] = [];
  return {
    tier: 'curl',
    urls,
    fetch: async (url: string) => { urls.push(url); return results.shift() ?? { ok: false, blocked: false }; },
    close: async () => {},
  };
}

const SITE = { name: 'acgrip', baseUrl: 'https://acg.rip', searchUrlTemplate: 'https://acg.rip/?term={query}' };

const OK_HTML = { ok: true, status: 200, body: '<html>results</html>', blocked: false };

describe('runAgentLoop', () => {
  it('downloads and returns the file path when the LLM walks search -> open -> download', async () => {
    const llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/?term=frieren', note: 'searching' },
      { action: 'open', url: 'https://acg.rip/t/123', note: 'found pack page' },
      { action: 'download', url: 'https://acg.rip/dl/123.zip', note: 'downloading batch' },
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML, { ok: true, status: 200, filePath: '/dl/pack.zip', blocked: false }]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'Frieren', destDir: tmpDir(), maxSteps: 10, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'downloaded', filePath: '/dl/pack.zip', url: 'https://acg.rip/dl/123.zip' });
    expect(tier.urls).toEqual(['https://acg.rip/?term=frieren', 'https://acg.rip/t/123', 'https://acg.rip/dl/123.zip']);
  });

  it('returns exhausted at the step budget', async () => {
    const llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/?term=x', note: 's' },
      { action: 'search', url: 'https://acg.rip/?term=y', note: 's' },
    ]);
    const tier = fakeTier([OK_HTML, OK_HTML]);
    const out = await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 2, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'exhausted' });
  });

  it('returns gave-up when the LLM does', async () => {
    const llm = new FakeGenerator([{ action: 'give_up', url: '', note: 'nothing here' }]);
    const out = await runAgentLoop({ llm, tier: fakeTier([]), site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} });
    expect(out).toEqual({ kind: 'gave-up' });
  });

  it('throws TierBlockedError when the tier reports a bot wall', async () => {
    const llm = new FakeGenerator([{ action: 'search', url: 'https://acg.rip/?term=x', note: 's' }]);
    const tier = fakeTier([{ ok: false, status: 403, body: 'Attention Required! | Cloudflare', blocked: true }]);
    await expect(
      runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: () => {} }),
    ).rejects.toBeInstanceOf(TierBlockedError);
  });

  it('emits a transcript entry per step', async () => {
    const llm = new FakeGenerator([
      { action: 'search', url: 'https://acg.rip/?term=x', note: 'searching' },
      { action: 'give_up', url: '', note: 'nope' },
    ]);
    const tier = fakeTier([OK_HTML]);
    const entries: unknown[] = [];
    await runAgentLoop({ llm, tier, site: SITE, profile: PROFILE, query: 'F', destDir: tmpDir(), maxSteps: 5, onTranscript: (e) => entries.push(e) });
    expect(entries).toHaveLength(2);
  });
});
