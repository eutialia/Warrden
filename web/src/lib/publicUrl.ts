const VITE_DEV_PORTS = new Set(['5173', '4173']);

export function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1') return true;
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return Number(parts[0]) === 127;
}

export function isLoopbackPublicUrl(publicUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(publicUrl).hostname);
  } catch {
    return false;
  }
}

/** Mirror of `suggestPublicUrl` in `src/arr/publicUrl.ts`. Kept here because web has no
 * shared package with the server. */
export function suggestPublicUrl(input: { publicUrl: string; origin: string; listenPort: number }): string | null {
  let current: URL;
  let page: URL;
  try {
    current = new URL(input.publicUrl);
    page = new URL(input.origin);
  } catch {
    return null;
  }
  if (!isLoopbackHost(current.hostname)) return null;
  if (isLoopbackHost(page.hostname)) return null;
  if (VITE_DEV_PORTS.has(page.port)) {
    page.protocol = 'http:';
    page.port = String(input.listenPort);
  }
  return page.origin;
}
