import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import type { AccessTier } from '../db/siteProfiles.js';

export interface FetchResult {
  ok: boolean;
  status?: number;
  body?: string; // HTML/text, capped
  filePath?: string; // set when destPath was given and the download succeeded
  blocked: boolean;
}

export interface FetchTier {
  readonly tier: AccessTier;
  fetch(url: string, opts?: { destPath?: string }): Promise<FetchResult>;
  close(): Promise<void>;
}

/** v1's implemented rungs, cheapest first. The wider AccessTier union (`camoufox`,
 * `remote`) is the declared seam; the ladder walks THIS list, so adding a tier later is
 * appending here plus a `makeTier` case. */
export const TIER_ORDER = ['curl', 'chromium'] as const;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
const BODY_CAP = 2 * 1024 * 1024;

const BLOCK_MARKERS = ['cloudflare', 'cf-chl', 'captcha', 'attention required'];

/** Whether a response smells like a bot-wall rather than an ordinary failure — the signal
 * the ladder escalates on (a plain 404 is "wrong URL", not "wrong tier"). */
export function looksBlocked(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  if (status === 503 && lower.includes('just a moment')) return true;
  if ((status === 401 || status === 403) && BLOCK_MARKERS.some((m) => lower.includes(m))) return true;
  return false;
}

type FetchImpl = typeof fetch;

/** Tier 0: a plain HTTP GET with a browser user-agent. Cheap and sufficient for most
 * public subtitle sites; a bot-wall response is reported as `blocked` so the ladder
 * escalates rather than retrying a wall. */
export class CurlTier implements FetchTier {
  readonly tier = 'curl' as const;

  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async fetch(url: string, opts?: { destPath?: string }): Promise<FetchResult> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (opts?.destPath !== undefined) {
        if (!res.ok || res.body === null) return { ok: false, status: res.status, blocked: looksBlocked(res.status, '') };
        mkdirSync(dirname(opts.destPath), { recursive: true });
        await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(opts.destPath));
        return { ok: true, status: res.status, filePath: opts.destPath, blocked: false };
      }
      const body = (await res.text()).slice(0, BODY_CAP);
      return { ok: res.ok, status: res.status, body, blocked: looksBlocked(res.status, body) };
    } catch {
      return { ok: false, blocked: false };
    }
  }

  async close(): Promise<void> {}
}

/** Tier 1: headless Chromium via Playwright — for sites whose HTML only appears after JS,
 * or whose bot-wall passes a real browser. One lazy browser per instance; `close()` must be
 * called when the owning job finishes (the agent runner owns this). */
export class ChromiumTier implements FetchTier {
  readonly tier = 'chromium' as const;
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser;
  }

  async fetch(url: string, opts?: { destPath?: string }): Promise<FetchResult> {
    let context;
    try {
      context = await (await this.getBrowser()).newContext({ userAgent: UA });
      const page = await context.newPage();
      if (opts?.destPath !== undefined) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: TIMEOUT_MS }),
          page.goto(url, { timeout: TIMEOUT_MS }).catch(() => null),
        ]);
        mkdirSync(dirname(opts.destPath), { recursive: true });
        await download.saveAs(opts.destPath);
        return { ok: true, filePath: opts.destPath, blocked: false };
      }
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      await page.waitForTimeout(5000); // settle: let JS render the listing
      const body = (await page.content()).slice(0, BODY_CAP);
      const status = res?.status() ?? 0;
      return { ok: status >= 200 && status < 400, status, body, blocked: looksBlocked(status, body) };
    } catch {
      return { ok: false, blocked: false };
    } finally {
      await context?.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

/** Builds a tier implementation by name. Unimplemented rungs throw — the ladder catches
 * that exactly like a tier failure (escalate/skip), so a half-configured site profile can
 * never wedge a run. */
export function makeTier(tier: AccessTier): FetchTier {
  switch (tier) {
    case 'curl':
      return new CurlTier();
    case 'chromium':
      return new ChromiumTier();
    default:
      throw new Error(`tier "${tier}" is a declared seam, not implemented in v1`);
  }
}
