import { mkdirSync, renameSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { extract as tarExtract } from 'tar';
import type { ArchiveCacheEntry } from '../../db/archiveCache.js';
import { parseEpisodeRef, parseLangTag } from '../ingest/sidecars.js';

export const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];

const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.tgz']);

export function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  return ARCHIVE_EXTS.has(extname(lower));
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

  if (lower.endsWith('.rar') || lower.endsWith('.7z')) throw new UnsupportedArchiveError(archivePath);

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

  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
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

  throw new UnsupportedArchiveError(archivePath);
}

export function entriesForFiles(files: string[]): ArchiveCacheEntry[] {
  return files.map((path) => {
    // Strip extractArchive's collision-safe `<index>-` prefix so parseEpisodeRef sees one
    // bare episode number. Without this, `0-Show - 01.ass` yields candidates [0, 1] → null.
    const name = basename(path).replace(/^\d+-/, '');
    return { path, lang: parseLangTag(name), episodeRef: parseEpisodeRef(name) };
  });
}
