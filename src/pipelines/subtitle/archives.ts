import { mkdirSync, renameSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { extract as tarExtract } from 'tar';
import type { ArchiveCacheEntry } from '../../db/archiveCache.js';
import { parseEpisodeRef, parseLangTag } from '../ingest/sidecars.js';

const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];

/** Whether `extractArchive` can unpack this path in v1 (zip/tar/tar.gz/tgz). Rar/7z and
 * every non-archive path return false so the pipeline can skip them without throwing. */
export function isSupportedArchive(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar');
}

export class UnsupportedArchiveError extends Error {
  constructor(archivePath: string) {
    super(`unsupported archive format: ${archivePath}`);
    this.name = 'UnsupportedArchiveError';
  }
}

export async function extractArchive(archivePath: string, destDir: string): Promise<string[]> {
  mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (!isSupportedArchive(archivePath)) throw new UnsupportedArchiveError(archivePath);

  const out: string[] = [];
  const keep = (name: string): boolean => SUBTITLE_EXTENSIONS.includes(extname(name).toLowerCase());
  const dest = (name: string): string => join(destDir, `${out.length}-${basename(name)}`);

  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !keep(entry.entryName)) continue;
      const target = dest(entry.entryName);
      zip.extractEntryTo(entry, destDir, false, true, false, `${out.length}-${basename(entry.entryName)}`);
      out.push(target);
    }
    return out.sort();
  }

  // isSupportedArchive already gated zip/tar/tar.gz/tgz — remaining path is tar family.
  await tarExtract({ file: archivePath, cwd: destDir, filter: (path) => keep(path) });
  const { walkFiles } = await import('../../fs/files.js');
  const kept = walkFiles(destDir, SUBTITLE_EXTENSIONS);
  for (const p of kept) {
    const target = dest(p);
    if (p !== target) renameSync(p, target);
    out.push(target);
  }
  return out.sort();
}

export function entriesForFiles(files: string[]): ArchiveCacheEntry[] {
  return files.map((path) => {
    // Strip extractArchive's collision-safe `<index>-` prefix so parseEpisodeRef sees one
    // bare episode number. Without this, `0-Show - 01.ass` yields candidates [0, 1] → null.
    const name = basename(path).replace(/^\d+-/, '');
    return { path, lang: parseLangTag(name), episodeRef: parseEpisodeRef(name) };
  });
}
