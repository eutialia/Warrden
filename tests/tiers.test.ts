import { describe, expect, it } from 'vitest';
import { createRunTiers } from '../src/agent/run.js';
import { CookieJar, CurlTier, looksBlocked, makeTier } from '../src/agent/tiers.js';
import { tmpDir } from './helpers.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('looksBlocked', () => {
  it.each([
    [403, '<title>Attention Required! | Cloudflare</title>', true],
    [503, '<title>Just a moment...</title>', true],
    [403, 'cf-chl-bypass', true],
    [403, '<div id="cf-error-details">Error 1020</div>', true],
    [
      403,
      '<html><head><title>\u4e0b\u8f7d\u9875\u9762\u5df2\u5931\u6548</title>' +
        '<script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script></head>' +
        '<body><p>\u8bf7\u8fd4\u56de\u5b57\u5e55\u8be6\u60c5\u9875\u91cd\u65b0\u4e0b\u8f7d</p></body></html>',
      false,
    ],
    [404, 'not found', false],
    [200, '<html>real page</html>', false],
    [500, 'server error', false],
  ])('status %i -> %s', (status, body, expected) => {
    expect(looksBlocked(status, body)).toBe(expected);
  });
});

describe('CookieJar', () => {
  it('merges Set-Cookie lines from getSetCookie, including multi-cookie responses', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/; HttpOnly');
    headers.append('set-cookie', 'token=xyz; Path=/');
    jar.absorb(headers, 'site.example');
    expect(jar.header('site.example')).toBe('session=abc; token=xyz');
  });

  it('overwrites an existing cookie name on a later absorb', () => {
    const jar = new CookieJar();
    const first = new Headers();
    first.append('set-cookie', 'session=old');
    jar.absorb(first, 'site.example');
    const second = new Headers();
    second.append('set-cookie', 'session=new');
    jar.absorb(second, 'site.example');
    expect(jar.header('site.example')).toBe('session=new');
  });

  it('does not send cookies absorbed on host A to host B', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('set-cookie', 'session=secret');
    jar.absorb(headers, 'host-a.example');
    expect(jar.header('host-a.example')).toBe('session=secret');
    expect(jar.header('host-b.example')).toBe('');
  });

  it('deletes a cookie when Set-Cookie value is empty', () => {
    const jar = new CookieJar();
    const set = new Headers();
    set.append('set-cookie', 'session=abc');
    jar.absorb(set, 'site.example');
    const clear = new Headers();
    clear.append('set-cookie', 'session=');
    jar.absorb(clear, 'site.example');
    expect(jar.header('site.example')).toBe('');
  });
});

describe('CurlTier', () => {
  it('returns ok with body for a 200 text response', async () => {
    const tier = new CurlTier(async () => new Response('<html>ok</html>', { status: 200 }));
    const res = await tier.fetch('https://x');
    expect(res).toMatchObject({ ok: true, status: 200, body: '<html>ok</html>', blocked: false });
  });

  it('flags a cloudflare 403 as blocked, not ok', async () => {
    const tier = new CurlTier(async () => new Response('Attention Required! | Cloudflare', { status: 403 }));
    const res = await tier.fetch('https://x');
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
  });

  it('streams to destPath when given one', async () => {
    const dest = join(tmpDir(), 'dl.zip');
    const tier = new CurlTier(async () => new Response(new TextEncoder().encode('PK-bytes')));
    const res = await tier.fetch('https://x/pack.zip', { destPath: dest });
    expect(res).toMatchObject({ ok: true, filePath: dest });
    expect(readFileSync(dest, 'utf-8')).toBe('PK-bytes');
  });

  it('flags a cloudflare 403 on a destPath download as blocked and writes no file', async () => {
    const dest = join(tmpDir(), 'wall.zip');
    const tier = new CurlTier(
      async () => new Response('Attention Required! | Cloudflare', { status: 403 }),
    );
    const res = await tier.fetch('https://x/wall.zip', { destPath: dest });
    expect(res).toEqual({ ok: false, status: 403, blocked: true });
    expect(existsSync(dest)).toBe(false);
  });

  it('a network throw becomes ok:false, blocked:false', async () => {
    const tier = new CurlTier(async () => { throw new Error('ECONNREFUSED'); });
    const res = await tier.fetch('https://x');
    expect(res).toEqual({ ok: false, blocked: false });
  });

  it('absorbs Set-Cookie (including multi-cookie) and sends the merged Cookie on the next request', async () => {
    const seen: { cookie?: string | null }[] = [];
    let n = 0;
    const jar = new CookieJar();
    const tier = new CurlTier({
      cookieJar: jar,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ cookie: headers.get('cookie') });
        n += 1;
        if (n === 1) {
          const resHeaders = new Headers();
          resHeaders.append('set-cookie', 'session=abc; Path=/');
          resHeaders.append('set-cookie', 'tk_ip=1; Path=/');
          return new Response('<html>warm</html>', { status: 200, headers: resHeaders });
        }
        return new Response('ok', { status: 200 });
      },
    });

    await tier.fetch('https://site/home');
    await tier.fetch('https://site/api');
    expect(seen[0]!.cookie).toBeNull();
    expect(seen[1]!.cookie).toBe('session=abc; tk_ip=1');
  });

  it('cookie from a request step is sent on a later destPath download', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const jar = new CookieJar();
    const dest = join(tmpDir(), 'pack.zip');
    const tier = new CurlTier({
      cookieJar: jar,
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('cookie'));
        n += 1;
        if (n === 1) {
          const h = new Headers();
          h.append('set-cookie', 'sid=from-request');
          return new Response('ok', { status: 200, headers: h });
        }
        return new Response(new TextEncoder().encode('PK'), { status: 200 });
      },
    });
    await tier.fetch('https://site/api', { method: 'POST', body: '{}' });
    const res = await tier.fetch('https://site/dl.zip', { destPath: dest });
    expect(res.ok).toBe(true);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe('sid=from-request');
  });

  it('follows a 302 with Set-Cookie and returns the final body with the jar updated', async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    let n = 0;
    const jar = new CookieJar();
    const tier = new CurlTier({
      cookieJar: jar,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), cookie: new Headers(init?.headers).get('cookie') });
        n += 1;
        if (n === 1) {
          const h = new Headers();
          h.append('set-cookie', 'session=from-redirect');
          h.set('location', '/final');
          return new Response(null, { status: 302, headers: h });
        }
        return new Response('<html>landed</html>', { status: 200 });
      },
    });
    const res = await tier.fetch('https://site/start');
    expect(res).toMatchObject({ ok: true, status: 200, body: '<html>landed</html>' });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.cookie).toBeNull();
    expect(seen[1]!.url).toBe('https://site/final');
    expect(seen[1]!.cookie).toBe('session=from-redirect');
    expect(jar.header('site')).toBe('session=from-redirect');
  });

  /** The redirect chain is the one place a destination the agent never chose gets fetched,
   * so the guard has to run on every hop and not only on the URL handed in. */
  it.each([
    ['absolute Location on the cloud metadata address', 'http://169.254.169.254/latest/meta-data', 'http://169.254.169.254/latest/meta-data'],
    ['absolute Location on a LAN address', 'http://192.168.1.1/admin', 'http://192.168.1.1/admin'],
    ['Location resolved against a redirect that already moved host', 'http://[::1]/x', 'http://[::1]/x'],
  ])('refuses a redirect to a private destination without requesting it: %s', async (_name, location, refusedUrl) => {
    const seen: string[] = [];
    const tier = new CurlTier({
      fetchImpl: async (url) => {
        seen.push(String(url));
        const h = new Headers();
        h.set('location', location);
        return new Response(null, { status: 302, headers: h });
      },
    });
    const res = await tier.fetch('https://site/start');
    expect(res).toEqual({ ok: false, status: 302, blocked: false, refusedUrl, refusedReason: 'private' });
    // The public first hop happened; the private one never left the process.
    expect(seen).toEqual(['https://site/start']);
  });

  /** A `Location` that will not resolve fetches nothing either way, but reported as a plain
   * HTTP failure it is indistinguishable from a broken site — the hop has to reach the
   * transcript as the refusal it is. */
  it.each([
    ['a truncated IPv6 literal', '//[::1'],
    ['an IPv6 literal with too many groups', 'http://[:::1]/x'],
  ])('reports a Location it cannot parse (%s) as a refusal, not an anonymous failure', async (_name, location) => {
    const tier = new CurlTier({
      fetchImpl: async () => {
        const h = new Headers();
        h.set('location', location);
        return new Response(null, { status: 302, headers: h });
      },
    });
    expect(await tier.fetch('https://site/start')).toEqual({
      ok: false,
      status: 302,
      blocked: false,
      refusedUrl: location,
      refusedReason: 'unparseable',
    });
  });

  it('refuses a private URL handed in directly, without fetching it', async () => {
    let called = 0;
    const tier = new CurlTier({
      fetchImpl: async () => {
        called += 1;
        return new Response('secret', { status: 200 });
      },
    });
    expect(await tier.fetch('http://169.254.169.254/latest/meta-data')).toEqual({
      ok: false,
      blocked: false,
      refusedUrl: 'http://169.254.169.254/latest/meta-data',
      refusedReason: 'private',
    });
    expect(called).toBe(0);
  });

  it('still follows a legitimate multi-hop redirect between public hosts', async () => {
    const seen: string[] = [];
    const chain: Record<string, string> = {
      'https://site/start': 'https://mirror.example/step',
      'https://mirror.example/step': 'https://cdn.example/final',
    };
    const tier = new CurlTier({
      fetchImpl: async (url) => {
        seen.push(String(url));
        const next = chain[String(url)];
        if (next === undefined) return new Response('<html>landed</html>', { status: 200 });
        const h = new Headers();
        h.set('location', next);
        return new Response(null, { status: 302, headers: h });
      },
    });
    const res = await tier.fetch('https://site/start');
    expect(res).toMatchObject({ ok: true, status: 200, body: '<html>landed</html>' });
    expect(res.refusedUrl).toBeUndefined();
    expect(seen).toEqual(['https://site/start', 'https://mirror.example/step', 'https://cdn.example/final']);
  });

  it('returns ok:false when redirects exceed 5 hops', async () => {
    let n = 0;
    const tier = new CurlTier({
      fetchImpl: async () => {
        n += 1;
        const h = new Headers();
        h.set('location', `/hop-${n}`);
        return new Response(null, { status: 302, headers: h });
      },
    });
    const res = await tier.fetch('https://site/start');
    expect(res.ok).toBe(false);
    // Original + 5 followed hops attempted; 6th redirect aborts without a 7th fetch.
    expect(n).toBe(6);
  });

  it('does not re-send POST body when following a 302', async () => {
    const seen: { method?: string; body?: unknown }[] = [];
    let n = 0;
    const tier = new CurlTier({
      fetchImpl: async (_url, init) => {
        seen.push({ method: init?.method, body: init?.body });
        n += 1;
        if (n === 1) {
          const h = new Headers();
          h.set('location', '/after');
          return new Response(null, { status: 302, headers: h });
        }
        return new Response('done', { status: 200 });
      },
    });
    await tier.fetch('https://site/post', { method: 'POST', body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
    expect(seen[0]).toEqual({ method: 'POST', body: 'a=1' });
    expect(seen[1]).toEqual({ method: 'GET', body: undefined });
  });

  it('host-scoped jar: cookie from host A is not sent to host B', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const jar = new CookieJar();
    const tier = new CurlTier({
      cookieJar: jar,
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('cookie'));
        n += 1;
        if (n === 1) {
          const h = new Headers();
          h.append('set-cookie', 'session=only-a');
          return new Response('a', { status: 200, headers: h });
        }
        return new Response('b', { status: 200 });
      },
    });
    await tier.fetch('https://host-a.example/');
    await tier.fetch('https://host-b.example/');
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBeNull();
  });

  it.each([
    {
      name: 'POST with body, content-type, and referer',
      opts: { method: 'POST' as const, body: 'a=1', contentType: 'application/x-www-form-urlencoded', referer: 'https://site/page' },
      expect: { method: 'POST', body: 'a=1', contentType: 'application/x-www-form-urlencoded', referer: 'https://site/page' },
    },
    {
      name: 'GET with referer only',
      opts: { method: 'GET' as const, referer: 'https://site/page' },
      expect: { method: 'GET', body: undefined, contentType: null, referer: 'https://site/page' },
    },
    {
      name: 'GET ignores body and contentType if somehow passed',
      opts: { method: 'GET' as const, body: 'nope', contentType: 'application/json' },
      expect: { method: 'GET', body: undefined, contentType: null, referer: null },
    },
  ])('passes through $name', async ({ opts, expect: exp }) => {
    let seen: { method?: string; body?: unknown; contentType: string | null; referer: string | null } | undefined;
    const tier = new CurlTier({
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen = {
          method: init?.method,
          body: init?.body,
          contentType: headers.get('content-type'),
          referer: headers.get('referer'),
        };
        return new Response('ok', { status: 200 });
      },
    });
    await tier.fetch('https://site/api', opts);
    expect(seen).toEqual(exp);
  });

  it('makeTier(curl) reuses a provided cookieJar across instances', async () => {
    const jar = new CookieJar();
    const seen: (string | null)[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get('cookie'));
      n += 1;
      if (n === 1) {
        const h = new Headers();
        h.append('set-cookie', 'k=v');
        return new Response('1', { status: 200, headers: h });
      }
      return new Response('2', { status: 200 });
    };
    const a = makeTier('curl', { cookieJar: jar, fetchImpl });
    const b = makeTier('curl', { cookieJar: jar, fetchImpl });
    await a.fetch('https://x/1');
    await b.fetch('https://x/2');
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe('k=v');
  });

  it('two createRunTiers() factories do not share cookies', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get('cookie'));
      n += 1;
      if (n === 1) {
        const h = new Headers();
        h.append('set-cookie', 'session=from-run-1');
        return new Response('1', { status: 200, headers: h });
      }
      return new Response('2', { status: 200 });
    };
    const run1 = createRunTiers({ fetchImpl });
    const run2 = createRunTiers({ fetchImpl });
    await run1.make('curl').fetch('https://site/');
    await run2.make('curl').fetch('https://site/');
    expect(seen[0]).toBeNull();
    // Second factory has its own jar — no bleed from run 1.
    expect(seen[1]).toBeNull();
  });
});
