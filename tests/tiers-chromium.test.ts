import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { makeTier } from '../src/agent/tiers.js';
import { tmpDir } from './helpers.js';

/**
 * ChromiumTier against a fake Playwright, not a real browser: what is under test is this
 * file's own control flow — how a refused hop ends a download wait, and which headers each
 * hop of the API redirect chain carries — and neither needs a renderer. The browser is a
 * dependency that cannot be instantiated in a unit test, so it is mocked; what the real
 * Chromium does with the requests we hand it is out of scope here (and is the assumption
 * the tier's own comment marks as unverified).
 */
const state = vi.hoisted(() => ({
  /** Registered by `context.route('**\/*', handler)`. */
  routeHandler: null as ((route: FakeRoute) => Promise<void>) | null,
  /** A `goto` for this URL pretends the navigation redirected here, and offers that hop to
   * the route handler before failing (as an aborted navigation does). */
  redirectTo: null as string | null,
  /** Every `context.request.fetch` call, in order. */
  apiCalls: [] as { url: string; method?: string; headers?: Record<string, string> }[],
  /** Queue of `{status, location}` for the API path; the last entry repeats. */
  apiResponses: [] as { status: number; location?: string }[],
}));

interface FakeRoute {
  request: () => { url: () => string };
  continue: () => Promise<void>;
  abort: (reason: string) => Promise<void>;
}

vi.mock('playwright', () => {
  const page = {
    setExtraHTTPHeaders: async () => {},
    goto: async (url: string) => {
      if (state.redirectTo === null) return { status: () => 200 };
      let aborted = false;
      await state.routeHandler?.({
        request: () => ({ url: () => state.redirectTo! }),
        continue: async () => {},
        abort: async () => {
          aborted = true;
        },
      });
      // An aborted request surfaces as a navigation failure, exactly as in the browser.
      if (aborted) throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
      return { status: () => 200 };
    },
    // No download ever arrives in these tests: that is the point of the first one.
    waitForEvent: () => new Promise(() => {}),
    content: async () => '<html></html>',
    waitForTimeout: async () => {},
    close: async () => {},
  };
  const context = {
    route: async (_pattern: string, handler: (route: FakeRoute) => Promise<void>) => {
      state.routeHandler = handler;
    },
    newPage: async () => page,
    request: {
      fetch: async (url: string, opts: { method?: string; headers?: Record<string, string> }) => {
        state.apiCalls.push({ url, method: opts.method, headers: opts.headers });
        const next = state.apiResponses.length > 1 ? state.apiResponses.shift()! : state.apiResponses[0]!;
        return {
          status: () => next.status,
          ok: () => next.status < 400,
          headers: () => (next.location !== undefined ? { location: next.location } : {}),
          text: async () => 'body',
        };
      },
    },
    close: async () => {},
  };
  return {
    chromium: {
      launch: async () => ({ newContext: async () => context, close: async () => {} }),
    },
  };
});

beforeEach(() => {
  state.routeHandler = null;
  state.redirectTo = null;
  state.apiCalls = [];
  state.apiResponses = [];
});

describe('ChromiumTier', () => {
  /** A refused hop means no download will EVER arrive. Waiting for the download event to
   * time out costs three minutes per attempt, so the refusal has to end the wait itself.
   * The fake's download event never resolves: if the tier waits on it, this test times out.
   */
  it(
    'ends a download immediately when the route guard refuses a redirect hop',
    async () => {
      state.redirectTo = 'http://169.254.169.254/latest/meta-data';
      const tier = makeTier('chromium');
      const started = Date.now();
      const res = await tier.fetch('https://acg.rip/dl/1.zip', { destPath: join(tmpDir(), 'pack.zip') });
      expect(res).toEqual({
        ok: false,
        blocked: false,
        refusedUrl: 'http://169.254.169.254/latest/meta-data',
        refusedReason: 'private',
      });
      expect(Date.now() - started).toBeLessThan(2000);
      await tier.close();
    },
    5000,
  );

  /** CurlTier rebuilds its headers per hop, so a 302 that downgrades POST to GET drops the
   * content-type along with the body. The API path has to match: the two claim identical
   * semantics. */
  it('drops content-type on a redirect hop that downgrades POST to GET', async () => {
    state.apiResponses = [
      { status: 302, location: 'https://acg.rip/after' },
      { status: 200 },
    ];
    const tier = makeTier('chromium');
    await tier.fetch('https://acg.rip/api/dl', {
      method: 'POST',
      body: 'a=1',
      contentType: 'application/x-www-form-urlencoded',
      referer: 'https://acg.rip/t/1',
    });
    expect(state.apiCalls).toHaveLength(2);
    expect(state.apiCalls[0]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://acg.rip/t/1' },
    });
    expect(state.apiCalls[1]!.method).toBe('GET');
    expect(state.apiCalls[1]!.headers).toEqual({ referer: 'https://acg.rip/t/1' });
    await tier.close();
  });

  /** Same defect as CurlTier's, on the path that walks its own chain. */
  it('reports a Location it cannot parse as a refusal', async () => {
    state.apiResponses = [{ status: 302, location: '//[::1' }];
    const tier = makeTier('chromium');
    const res = await tier.fetch('https://acg.rip/api/dl', { method: 'POST', body: 'a=1' });
    expect(res).toEqual({ ok: false, status: 302, blocked: false, refusedUrl: '//[::1', refusedReason: 'unparseable' });
    expect(state.apiCalls).toHaveLength(1);
    await tier.close();
  });
});
