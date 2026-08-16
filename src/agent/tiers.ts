import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { AccessTier } from '../db/siteProfiles.js';
import { refusedDestination, resolveRedirect, type RefusedDestination } from './destinationGuard.js';

export interface FetchResult {
  ok: boolean;
  status?: number;
  body?: string; // HTML/text, capped
  filePath?: string; // set when destPath was given and the download succeeded
  blocked: boolean;
  /** The destination `refusedDestination` refused, when that is why this fetch failed —
   * in practice a redirect hop, since the loop checks the URL it hands in beforehand. A
   * refusal is a failed result and never a throw, so the loop reports it as a refusal
   * instead of as an anonymous network error. */
  refusedUrl?: string;
  /** Why `refusedUrl` was refused, so the transcript says which of the two it was: a hop
   * onto a guarded address, or a `Location` header that is not a URL at all. */
  refusedReason?: RefusedDestination;
}

/** Options for a tier fetch — GET by default; POST/body/referer for protocol steps. */
export interface FetchOpts {
  destPath?: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  referer?: string;
}

export interface FetchTier {
  readonly tier: AccessTier;
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>;
  close(): Promise<void>;
}

/** v1's implemented rungs, cheapest first. The wider AccessTier union (`camoufox`,
 * `remote`) is the declared seam; the ladder walks THIS list, so adding a tier later is
 * appending here plus a `makeTier` case. */
export const TIER_ORDER = ['curl', 'chromium'] as const;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** Non-download HTTP requests (HTML/API). */
const TIMEOUT_MS = 30_000;
/** File downloads (destPath) — season packs can exceed the short request timeout mid-stream. */
const DOWNLOAD_TIMEOUT_MS = 180_000;
const BODY_CAP = 2 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

const BLOCK_MARKERS = ['cloudflare', 'cf-chl', 'captcha', 'attention required'];

/** Whether a response smells like a bot-wall rather than an ordinary failure — the signal
 * the ladder escalates on (a plain 404 is "wrong URL", not "wrong tier"). */
export function looksBlocked(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  if (status === 503 && lower.includes('just a moment')) return true;
  if ((status === 401 || status === 403) && BLOCK_MARKERS.some((m) => lower.includes(m))) return true;
  return false;
}

/**
 * Run-scoped, host-scoped cookie jar for CurlTier: name=value pairs keyed by request host.
 * Exact-host match only (no Domain-attribute parsing in v1). One jar per site-search run is
 * shared across every curl step; ChromiumTier keeps its own browser-context cookies and is
 * never synced with this jar.
 */
export class CookieJar {
  /** host → (cookie name → value) */
  private readonly byHost = new Map<string, Map<string, string>>();

  /** Prefer `Headers.getSetCookie()` (Node/undici): `get('set-cookie')` is null/wrong for
   * multi-cookie responses. Empty cookie values delete the entry for that host. */
  absorb(headers: Headers, host: string): void {
    const lines =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (() => {
            const one = headers.get('set-cookie');
            return one ? [one] : [];
          })();
    let map = this.byHost.get(host);
    if (!map) {
      map = new Map();
      this.byHost.set(host, map);
    }
    for (const line of lines) {
      const pair = line.split(';')[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '') {
        map.delete(name);
      } else {
        map.set(name, value);
      }
    }
  }

  /** Cookie header value for `host`, or empty string when that host has no cookies. */
  header(host: string): string {
    const map = this.byHost.get(host);
    if (!map || map.size === 0) return '';
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

type FetchImpl = typeof fetch;

export interface MakeTierOpts {
  /** Shared across every curl fetch in one site-search run. */
  cookieJar?: CookieJar;
  fetchImpl?: FetchImpl;
}

/** Host of a URL string, or '' when unparseable. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Tier 0: plain HTTP with a browser user-agent and a run-scoped cookie jar. Cheap and
 * sufficient for most public subtitle sites; a bot-wall response is reported as `blocked`
 * so the ladder escalates rather than retrying a wall. Redirects are followed manually so
 * Set-Cookie on 3xx hops is absorbed (fetch's `redirect: 'follow'` would discard them),
 * and because a followed hop is a destination in its own right: every one of them goes
 * through the same destination guard the agent loop uses, so a public URL cannot 302 the
 * agent onto a LAN service or a metadata endpoint the loop never got to see. */
export class CurlTier implements FetchTier {
  readonly tier = 'curl' as const;
  private readonly jar: CookieJar;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: MakeTierOpts | FetchImpl = {}) {
    // Back-compat: tests pass a bare fetch impl as the first arg.
    if (typeof opts === 'function') {
      this.fetchImpl = opts;
      this.jar = new CookieJar();
    } else {
      this.fetchImpl = opts.fetchImpl ?? fetch;
      this.jar = opts.cookieJar ?? new CookieJar();
    }
  }

  async fetch(url: string, opts?: FetchOpts): Promise<FetchResult> {
    try {
      const refusal = refusedDestination(url);
      if (refusal !== null) return { ok: false, blocked: false, refusedUrl: url, refusedReason: refusal };
      let currentUrl = url;
      let method: 'GET' | 'POST' = opts?.method ?? 'GET';
      // GET never carries a body — only POST forwards body/contentType.
      let sendBody = method === 'POST' ? opts?.body : undefined;
      const timeoutMs = opts?.destPath !== undefined ? DOWNLOAD_TIMEOUT_MS : TIMEOUT_MS;
      let hops = 0;

      while (true) {
        const host = urlHost(currentUrl);
        const headers: Record<string, string> = {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        };
        if (method === 'POST' && opts?.contentType) headers['content-type'] = opts.contentType;
        if (opts?.referer) headers.referer = opts.referer;
        const cookie = this.jar.header(host);
        if (cookie) headers.cookie = cookie;

        const res = await this.fetchImpl(currentUrl, {
          method,
          headers,
          body: method === 'POST' ? sendBody : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        this.jar.absorb(res.headers, host);

        // Manual redirect loop: absorb cookies per hop, re-send jar for the next host.
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) {
            return { ok: false, status: res.status, blocked: false };
          }
          hops += 1;
          if (hops > MAX_REDIRECT_HOPS) {
            return { ok: false, status: res.status, blocked: false };
          }
          // Guard the hop BEFORE it is requested: this is the only place that sees it.
          const next = resolveRedirect(location, currentUrl);
          if (next.refused !== null) {
            return { ok: false, status: res.status, blocked: false, refusedUrl: next.url, refusedReason: next.refused };
          }
          currentUrl = next.url;
          // POST bodies are not re-sent; 302/303 (and typical 301) follow with GET.
          if (method === 'POST' && (res.status === 301 || res.status === 302 || res.status === 303)) {
            method = 'GET';
            sendBody = undefined;
          } else if (method === 'POST') {
            // 307/308 would preserve method, but we still do not re-send the body.
            sendBody = undefined;
          }
          continue;
        }

        if (opts?.destPath !== undefined) {
          if (!res.ok || res.body === null) {
            const body = res.body ? (await res.text()).slice(0, BODY_CAP) : '';
            return { ok: false, status: res.status, blocked: looksBlocked(res.status, body) };
          }
          mkdirSync(dirname(opts.destPath), { recursive: true });
          await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(opts.destPath));
          return { ok: true, status: res.status, filePath: opts.destPath, blocked: false };
        }
        const body = (await res.text()).slice(0, BODY_CAP);
        return { ok: res.ok, status: res.status, body, blocked: looksBlocked(res.status, body) };
      }
    } catch {
      return { ok: false, blocked: false };
    }
  }

  async close(): Promise<void> {}
}

/** Tier 1: headless Chromium via Playwright — for sites whose HTML only appears after JS,
 * or whose bot-wall passes a real browser. One lazy browser + ONE context per instance so
 * cookies persist across steps within a run; `close()` must be called when the owning job
 * finishes (the agent runner owns this). */
class ChromiumTier implements FetchTier {
  readonly tier = 'chromium' as const;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /** Destination the route guard blocked during the fetch in flight (fetches are
   * sequential within a run, so one slot is enough); read and cleared by `fetch`. */
  private refusedHop: string | null = null;

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.browser ??= await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ userAgent: UA });
    // Playwright follows redirects inside the browser, so `page.goto()`'s return value
    // cannot show the hops it took. Request interception is the one place they ARE
    // visible, and aborting there stops the hop before it is sent. Aborting surfaces as a
    // navigation failure, which the catch below turns into a failed result, and
    // `refusedHop` is what tells the loop the failure was a refusal.
    //
    // The load-bearing ASSUMPTION: that this handler runs for every request the context
    // makes, redirect targets included. Playwright documents it that way, but nothing
    // here verifies it — checking it needs a real browser and a real redirect, which the
    // test suite does not have. CurlTier's per-hop check is the one that is proven.
    await this.context.route('**/*', async (route) => {
      const request = route.request();
      const target = request.url();
      if (refusedDestination(target) === null) {
        await route.continue().catch(() => {});
        return;
      }
      // Every refused request is aborted (defense in depth), but only a refused MAIN-FRAME
      // NAVIGATION — the main request or one of its redirect hops — is recorded as
      // `refusedHop`. `isNavigationRequest()` alone is not enough: it is also true for a
      // sub-frame document load, so an `<iframe src="http://127.0.0.1/">` on an otherwise
      // fine page would set `refusedHop`, abandon the real download, and count toward
      // REFUSAL_LIMIT. `refusedHop` is what abandons a download wait and what the loop
      // counts, and a blocked subframe is neither a refused download nor the navigation the
      // agent aimed — so the main frame (`parentFrame() === null`) is the only one that drives it.
      if (request.isNavigationRequest() && request.frame().parentFrame() === null) this.refusedHop = target;
      await route.abort('blockedbyclient').catch(() => {});
    });
    return this.context;
  }

  async fetch(url: string, opts?: FetchOpts): Promise<FetchResult> {
    const refusal = refusedDestination(url);
    if (refusal !== null) return { ok: false, blocked: false, refusedUrl: url, refusedReason: refusal };
    this.refusedHop = null;
    const res = await this.attempt(url, opts);
    return !res.ok && this.refusedHop !== null
      ? { ...res, refusedUrl: this.refusedHop, refusedReason: 'private' }
      : res;
  }

  private async attempt(url: string, opts?: FetchOpts): Promise<FetchResult> {
    try {
      const context = await this.getContext();
      const method = opts?.method ?? 'GET';
      // Headers are computed per request, not once per fetch, so a redirect that downgrades
      // POST to GET drops the content-type with the body — same semantics as CurlTier,
      // which rebuilds its headers on every hop for the same reason.
      const headersFor = (m: 'GET' | 'POST'): Record<string, string> => {
        const headers: Record<string, string> = {};
        // Body/content-type only on POST — a GET never carries a body on any tier.
        if (m === 'POST' && opts?.contentType) headers['content-type'] = opts.contentType;
        if (opts?.referer) headers.referer = opts.referer;
        return headers;
      };
      const extraHeaders = headersFor(method);

      if (opts?.destPath !== undefined) {
        const page = await context.newPage();
        try {
          if (Object.keys(extraHeaders).length > 0) {
            await page.setExtraHTTPHeaders(extraHeaders);
          }
          // The download arrives as a side effect of the navigation, so both start
          // together. When the route guard refuses a hop the navigation fails and NO
          // download will ever arrive: return then and there rather than sitting on the
          // download event until its timeout, which is three minutes of waiting for
          // something that cannot happen. Any other navigation outcome keeps waiting —
          // a download often starts while `goto` is still in flight, or after it fails
          // with "download initiated" — so the timeout still covers a slow server.
          const downloadEvent = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
          // When the refusal branch wins, this stays pending until `page.close()` below
          // rejects it with nobody waiting — handle it here so that is not an unhandled
          // rejection.
          downloadEvent.catch(() => {});
          const refusedNavigation = page
            .goto(url, { timeout: DOWNLOAD_TIMEOUT_MS })
            .catch(() => null)
            .then(() => (this.refusedHop !== null ? null : new Promise<never>(() => {})));
          const download = await Promise.race([downloadEvent, refusedNavigation]);
          if (download === null) return { ok: false, blocked: false };
          mkdirSync(dirname(opts.destPath), { recursive: true });
          await download.saveAs(opts.destPath);
          return { ok: true, filePath: opts.destPath, blocked: false };
        } finally {
          await page.close().catch(() => {});
        }
      }

      // Non-GET protocol steps only: API-style request, no JS settle needed.
      // (Previously GET-with-body also took this path and diverged from curl.)
      if (method !== 'GET') {
        // `maxRedirects: 0` so the chain is walked here rather than inside Playwright:
        // the API request context is not a page, so the route guard above may not see its
        // hops, and every hop still has to pass the destination guard. Same semantics as
        // CurlTier: bodies are never re-sent, and the chain is capped.
        let currentUrl = url;
        let currentMethod: 'GET' | 'POST' = method;
        let sendBody = opts?.body;
        for (let hops = 0; ; hops++) {
          const res = await context.request.fetch(currentUrl, {
            method: currentMethod,
            headers: headersFor(currentMethod),
            data: sendBody,
            maxRedirects: 0,
            timeout: TIMEOUT_MS,
          });
          const status = res.status();
          if (status < 300 || status >= 400) {
            const body = (await res.text()).slice(0, BODY_CAP);
            return { ok: res.ok(), status, body, blocked: looksBlocked(status, body) };
          }
          const location = res.headers()['location'];
          if (location === undefined || hops >= MAX_REDIRECT_HOPS) {
            return { ok: false, status, blocked: false };
          }
          const next = resolveRedirect(location, currentUrl);
          if (next.refused !== null) {
            return { ok: false, status, blocked: false, refusedUrl: next.url, refusedReason: next.refused };
          }
          currentUrl = next.url;
          // Same POST-downgrade rule as CurlTier: 301/302/303 continue with GET, 307/308
          // preserve the method. The body is never re-sent on any hop either way.
          if (currentMethod === 'POST' && (status === 301 || status === 302 || status === 303)) {
            currentMethod = 'GET';
          }
          sendBody = undefined;
        }
      }

      const page = await context.newPage();
      try {
        if (Object.keys(extraHeaders).length > 0) {
          await page.setExtraHTTPHeaders(extraHeaders);
        }
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        await page.waitForTimeout(5000); // settle: let JS render the listing
        const body = (await page.content()).slice(0, BODY_CAP);
        const status = res?.status() ?? 0;
        return { ok: status >= 200 && status < 400, status, body, blocked: looksBlocked(status, body) };
      } finally {
        await page.close().catch(() => {});
      }
    } catch {
      return { ok: false, blocked: false };
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

/** Builds a tier implementation by name. Unimplemented rungs throw — the ladder catches
 * that exactly like a tier failure (escalate/skip), so a half-configured site profile can
 * never wedge a run. Pass a shared `cookieJar` so every curl step in one site-search run
 * reuses the same cookies. */
export function makeTier(tier: AccessTier, opts: MakeTierOpts = {}): FetchTier {
  switch (tier) {
    case 'curl':
      return new CurlTier(opts);
    case 'chromium':
      return new ChromiumTier();
    default:
      throw new Error(`tier "${tier}" is a declared seam, not implemented in v1`);
  }
}
