import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArrClient } from '../src/arr/client.js';
import { arrInstance } from './helpers.js';

/** Stubs the global `fetch` with a canned response/rejection and hands back the spy so a
 * test can assert on the exact URL and headers the client sent. */
function stubFetch(impl: () => Promise<Response>) {
  // Typed as `fetch` itself, not as the no-arg `impl`: that's what makes `mock.calls[0]`
  // come back as fetch's real argument tuple, so the URL/headers assertions below need
  // no cast to reach it.
  const spy = vi.fn<typeof fetch>(impl);
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
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://sonarr:8989/api/v3/system/status');
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('k-1');
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

describe('ArrClient.updateNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs the body to the notification id and returns the parsed response', async () => {
    const fetchSpy = stubFetch(async () => new Response(JSON.stringify({ id: 7, name: 'Warrden' }), { status: 202 }));
    const body = { id: 7, name: 'Warrden', fields: [{ name: 'url', value: 'http://warrden:9797/webhooks/sonarr' }] };

    const updated = await new ArrClient(arrInstance({ baseUrl: 'http://sonarr:8989', apiKey: 'k-1' })).updateNotification(body);

    expect(updated).toEqual({ id: 7, name: 'Warrden' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://sonarr:8989/api/v3/notification/7');
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('k-1');
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });
});

describe('ArrClient.searchSeason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs SeasonSearch with seriesId and seasonNumber', async () => {
    const fetchSpy = stubFetch(async () => new Response('', { status: 201 }));

    await new ArrClient(arrInstance({ baseUrl: 'http://sonarr:8989' })).searchSeason(142, 1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://sonarr:8989/api/v3/command');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'SeasonSearch', seriesId: 142, seasonNumber: 1 });
  });
});
