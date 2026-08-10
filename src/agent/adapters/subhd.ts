import { createWriteStream } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { siteLabel } from '../../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../../config/schema.js';
import type { DownloadResult, SiteAdapter, SubtitleCandidate } from './types.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://subhd.tv';
const TIMEOUT_MS = 30_000;
const LANG_LABELS: [string, string][] = [
  ['zh', '简体'],
  ['zt', '繁体'],
  ['en', '英语'],
  ['ja', '日语'],
];

/** Minimal cookie jar: name=value pairs merged from Set-Cookie headers. */
class CookieJar {
  private map = new Map<string, string>();

  /** Prefer `Headers.getSetCookie()` (Node/undici): `get('set-cookie')` is null/wrong for
   * multi-cookie responses, and subhd's warm-up depends on the IP-bound `tk_*` cookie. */
  absorb(headers: Headers): void {
    const lines =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (() => {
            const one = headers.get('set-cookie');
            return one ? [one] : [];
          })();
    for (const line of lines) {
      const pair = line.split(';')[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.map.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function httpGet(
  url: string,
  jar: CookieJar,
  opts?: { referer?: string },
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(opts?.referer ? { referer: opts.referer } : {}),
      ...(jar.header() ? { cookie: jar.header() } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  jar.absorb(res.headers);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function httpPostJson(
  url: string,
  jar: CookieJar,
  body: object,
  referer: string,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/json',
      referer,
      ...(jar.header() ? { cookie: jar.header() } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  jar.absorb(res.headers);
  return res.json();
}

/** Parse subhd search HTML into structured candidates (regex over static HTML). */
export function parseSubhdSearch(html: string): SubtitleCandidate[] {
  const results: SubtitleCandidate[] = [];
  const re = /<a class="link-dark align-middle" href='\/a\/([^']+)'>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]!;
    const title = m[2]!.trim();
    const win = html.slice(m.index, m.index + 2500);
    const langs = LANG_LABELS.filter(([, label]) => win.includes(`>${label}</span>`)).map(([c]) => c);
    const fmt = win.match(/class="p-1 text-secondary">([A-Z]+)</)?.[1];
    const size = win.match(/class='align-text-top me-3'>([0-9.]+[kKmMgG])</)?.[1];
    const dlRaw = win.match(/class="align-text-top me-3">(\d+)</)?.[1];
    const date = win.match(/class="align-text-top me-3">(20\d\d-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})</)?.[1];
    const upl = win.match(/class="fw-bold text-dark" href='\/u\/[^']+'[^>]*>([^<]+)<\/a>/)?.[1];
    const desc = win.match(/class='link-dark'>\s*([^<]+?)\s*<\/a>/)?.[1]?.trim();
    results.push({
      id: slug,
      title,
      langs,
      format: fmt,
      downloads: dlRaw ? Number(dlRaw) : null,
      date,
      uploader: upl,
      subtitle: desc && desc !== title ? `${desc}${size ? ` (${size})` : ''}` : size,
      url: `${BASE}/a/${slug}`,
    });
  }
  return results;
}

function siteLooksLikeSubhd(site: SubtitleSiteConfig): boolean {
  return siteLabel(site.baseUrl).toLowerCase().includes('subhd');
}

/**
 * subhd.tv adapter: static HTML search + cookie-warm download API with conditional captcha.
 */
export class SubhdAdapter implements SiteAdapter {
  readonly id = 'subhd';

  matches(site: SubtitleSiteConfig): boolean {
    return siteLooksLikeSubhd(site);
  }

  async search(query: string): Promise<SubtitleCandidate[]> {
    const jar = new CookieJar();
    const url = `${BASE}/search/${encodeURIComponent(query)}`;
    const { status, body } = await httpGet(url, jar);
    if (status < 200 || status >= 400) return [];
    return parseSubhdSearch(body);
  }

  async download(
    candidate: SubtitleCandidate,
    destDir: string,
    opts?: { captchaAnswer?: string; cookieJarPath?: string },
  ): Promise<DownloadResult> {
    const jar = new CookieJar();
    const slug = candidate.id;
    const detail = `${BASE}/a/${slug}`;
    const landing = `${BASE}/down/${slug}`;
    try {
      await httpGet(detail, jar);
      await httpGet(landing, jar, { referer: detail });
      const resp = (await httpPostJson(
        `${BASE}/api/sub/down`,
        jar,
        { sid: slug, cap: opts?.captchaAnswer ?? '' },
        landing,
      )) as { success?: boolean; pass?: boolean; url?: string; msg?: string };

      if (!resp.success) {
        return { kind: 'failed', message: resp.msg ?? 'subhd success=false' };
      }
      if (!resp.pass) {
        const svg = resp.msg ?? '';
        mkdirSync(destDir, { recursive: true });
        const svgPath = join(destDir, `captcha-${slug}.svg`);
        writeFileSync(svgPath, svg, 'utf8');
        return { kind: 'captcha', svg };
      }
      if (!resp.url) return { kind: 'failed', message: 'subhd missing download url' };

      const fname = resp.url.split('/').pop() || `${slug}.zip`;
      const safe = fname.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
      mkdirSync(destDir, { recursive: true });
      const destPath = join(destDir, `subhd-${Date.now()}-${safe}`);
      const fileRes = await fetch(resp.url, {
        headers: {
          'user-agent': UA,
          referer: landing,
          ...(jar.header() ? { cookie: jar.header() } : {}),
        },
        signal: AbortSignal.timeout(180_000),
      });
      if (!fileRes.ok || fileRes.body === null) {
        return { kind: 'failed', message: `download HTTP ${fileRes.status}` };
      }
      await pipeline(Readable.fromWeb(fileRes.body as import('stream/web').ReadableStream), createWriteStream(destPath));
      return { kind: 'file', filePath: destPath, url: resp.url };
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
