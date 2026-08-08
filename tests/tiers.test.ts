import { describe, expect, it } from 'vitest';
import { CurlTier, looksBlocked } from '../src/agent/tiers.js';

describe('looksBlocked', () => {
  it.each([
    [403, '<title>Attention Required! | Cloudflare</title>', true],
    [503, '<title>Just a moment...</title>', true],
    [403, 'cf-chl-bypass', true],
    [404, 'not found', false],
    [200, '<html>real page</html>', false],
    [500, 'server error', false],
  ])('status %i -> %s', (status, body, expected) => {
    expect(looksBlocked(status, body)).toBe(expected);
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
    const { tmpDir } = await import('./helpers.js');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dest = join(tmpDir(), 'dl.zip');
    const tier = new CurlTier(async () => new Response(new TextEncoder().encode('PK-bytes')));
    const res = await tier.fetch('https://x/pack.zip', { destPath: dest });
    expect(res).toMatchObject({ ok: true, filePath: dest });
    expect(readFileSync(dest, 'utf-8')).toBe('PK-bytes');
  });

  it('a network throw becomes ok:false, blocked:false', async () => {
    const tier = new CurlTier(async () => { throw new Error('ECONNREFUSED'); });
    const res = await tier.fetch('https://x');
    expect(res).toEqual({ ok: false, blocked: false });
  });
});
