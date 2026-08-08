import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuredGenerator } from '../../llm/generator.js';
import type { TranscriptEntry } from '../../db/subtitleRuns.js';
import type { AccessTier } from '../../db/siteProfiles.js';
import type { SearchHints } from '../../pipelines/subtitle/queries.js';
import { pickSubtitlePack, solveCaptchaOnce } from './pick.js';
import type { SiteAdapter } from './types.js';

const MAX_QUERIES = 4;

/**
 * Adapter path: for each query variant, search → structured pick → download
 * (one captcha OCR attempt). Returns a downloaded file or null when every query/candidate
 * fails — the caller may fall through to the generic HTML agent.
 */
export async function runAdapterSearch(input: {
  adapter: SiteAdapter;
  llm: StructuredGenerator;
  hints: SearchHints;
  destDir: string;
  workDir: string;
  tierLabel?: AccessTier;
  onTranscript: (e: TranscriptEntry) => void;
}): Promise<{ filePath: string; url: string; searchUrl: string | null } | null> {
  const { adapter, llm, hints, destDir, workDir, onTranscript } = input;
  const tier = input.tierLabel ?? 'curl';
  mkdirSync(workDir, { recursive: true });

  const queries = [hints.title, ...hints.alternateQueries].filter((q, i, arr) => {
    const key = q.trim().toLowerCase();
    return key.length > 0 && arr.findIndex((x) => x.trim().toLowerCase() === key) === i;
  }).slice(0, MAX_QUERIES);

  for (const query of queries) {
    onTranscript({
      ts: Date.now(),
      tier,
      action: 'adapter-search',
      detail: `${adapter.id}: search "${query}"`,
    });
    let candidates;
    try {
      candidates = await adapter.search(query);
    } catch (err) {
      onTranscript({
        ts: Date.now(),
        tier,
        action: 'adapter-search',
        detail: `${adapter.id}: search failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (candidates.length === 0) {
      onTranscript({
        ts: Date.now(),
        tier,
        action: 'adapter-search',
        detail: `${adapter.id}: no results for "${query}"`,
      });
      continue;
    }

    const picked = await pickSubtitlePack({ llm, candidates, hints });
    if (!picked) {
      onTranscript({
        ts: Date.now(),
        tier,
        action: 'adapter-pick',
        detail: `${adapter.id}: LLM picked none among ${candidates.length} candidates`,
      });
      continue;
    }
    onTranscript({
      ts: Date.now(),
      tier,
      action: 'adapter-pick',
      detail: `${adapter.id}: #${candidates.indexOf(picked.candidate) + 1} ${picked.candidate.title} (${picked.reasoning})`,
    });

    const searchUrl = `${adapter.id}:query=${encodeURIComponent(query)}`;
    let result = await adapter.download(picked.candidate, destDir, {
      cookieJarPath: join(workDir, `${adapter.id}-cookies.txt`),
    });

    if (result.kind === 'captcha') {
      onTranscript({
        ts: Date.now(),
        tier,
        action: 'adapter-captcha',
        detail: `${adapter.id}: captcha required — one automated solve attempt`,
      });
      const svg = result.svg;
      try {
        writeFileSync(join(workDir, `${adapter.id}-captcha.svg`), svg, 'utf8');
      } catch {
        /* ignore */
      }
      const answer = await solveCaptchaOnce({ llm, svg });
      if (answer) {
        result = await adapter.download(picked.candidate, destDir, {
          captchaAnswer: answer,
          cookieJarPath: join(workDir, `${adapter.id}-cookies.txt`),
        });
      }
      if (result.kind !== 'file') {
        onTranscript({
          ts: Date.now(),
          tier,
          action: 'adapter-captcha',
          detail: `${adapter.id}: captcha solve failed or re-download failed — try next query`,
        });
        continue;
      }
    }

    if (result.kind === 'file') {
      onTranscript({
        ts: Date.now(),
        tier,
        action: 'adapter-download',
        detail: `${adapter.id}: saved ${result.filePath}`,
      });
      return { filePath: result.filePath, url: result.url, searchUrl };
    }

    onTranscript({
      ts: Date.now(),
      tier,
      action: 'adapter-download',
      detail: `${adapter.id}: download failed: ${result.kind === 'failed' ? result.message : 'unknown'}`,
    });
  }

  return null;
}
