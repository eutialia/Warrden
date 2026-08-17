import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArrClient } from '../src/arr/client.js';
import { arrInstance } from './helpers.js';

/** Stubs the global `fetch` with a canned response/rejection and hands back the spy so a
 * test can assert on the exact URL and headers the client sent. */
function stubFetch(impl: () => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('ArrClient.ping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes /api/v3/system/status with the instance api key and reports ok on 2xx', async () => {
    const fetchSpy = stubFetch(async () => new Response(JSON.stringify({ version: '4.0.0' }), { status: 200 }));

    const status = await new ArrClient(arrInstance({ baseUrl: 'http://sonarr:8989/', apiKey: 'k-1' })).ping();

    expect(status).toBe('ok');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sonarr:8989/api/v3/system/status');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('k-1');
  });

  it.each([401, 403])('reports unauthorized on %i', async (status) => {
    stubFetch(async () => new Response('unauthorized', { status }));

    expect(await new ArrClient(arrInstance()).ping()).toBe('unauthorized');
  });

  it.each([404, 500, 502])('reports unreachable on %i', async (status) => {
    stubFetch(async () => new Response('nope', { status }));

    expect(await new ArrClient(arrInstance()).ping()).toBe('unreachable');
  });

  it('reports unreachable when the request never lands (network error or timeout abort)', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    expect(await new ArrClient(arrInstance()).ping()).toBe('unreachable');
  });
});
