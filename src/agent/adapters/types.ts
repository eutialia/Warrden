import type { SubtitleSiteConfig } from '../../config/schema.js';
import type { SearchHints } from '../../pipelines/subtitle/queries.js';

/** One structured pack listing from a site adapter (not raw HTML). */
export interface SubtitleCandidate {
  /** Site-stable id (slug, path, …) used for download. */
  id: string;
  title: string;
  /** Language codes/labels the listing claims (e.g. zh, zt, en). */
  langs: string[];
  format?: string;
  downloads?: number | null;
  date?: string;
  uploader?: string;
  /** Extra description line when the site provides one. */
  subtitle?: string;
  url: string;
}

export type DownloadResult =
  | { kind: 'file'; filePath: string; url: string }
  | { kind: 'captcha'; svg: string; pngPath?: string }
  | { kind: 'failed'; message: string };

/**
 * Protocol-faithful site integration. Matched sites skip the generic HTML agent for
 * search/download and use parse-then-pick instead. Unmatched sites keep the generic loop.
 */
export interface SiteAdapter {
  readonly id: string;
  matches(site: SubtitleSiteConfig): boolean;
  search(query: string): Promise<SubtitleCandidate[]>;
  download(
    candidate: SubtitleCandidate,
    destDir: string,
    opts?: { captchaAnswer?: string; cookieJarPath?: string },
  ): Promise<DownloadResult>;
}

export interface AdapterSearchContext {
  site: SubtitleSiteConfig;
  hints: SearchHints;
  destDir: string;
  /** Persist cookies / captcha artifacts under the job data dir. */
  workDir: string;
}
