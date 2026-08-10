/**
 * A subtitle site's human name and its filesystem/log key, both derived from its base URL.
 *
 * The URL is the site's only identity — it is unique by construction, where a hand-typed
 * name was not — so anything that used to read `site.name` reads this instead. The host is
 * what an operator recognises anyway ("opensubtitles.com", not "OpenSubtitles (main)").
 *
 * `www.` is dropped because it says nothing, and a malformed URL falls back to the raw
 * string rather than throwing: a bad value in config should show up in the dashboard as a
 * bad value, not take down the pipeline reading it.
 */
export function siteLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/^www\./, '');
  } catch {
    return baseUrl;
  }
}

/** The same name, reduced to what is safe in a path or a filename. */
export function siteKey(baseUrl: string): string {
  return siteLabel(baseUrl).replace(/[^a-z0-9.-]+/gi, '-');
}
