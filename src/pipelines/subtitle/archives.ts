import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { extract as tarExtract } from 'tar';
import type { ArchiveCacheEntry } from '../../db/archiveCache.js';
import { parseEpisodeRef, parseLangTag } from '../ingest/sidecars.js';

const execFileAsync = promisify(execFile);
const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];

/** Lone subtitle file (not an archive) — subhd and others occasionally serve .ass/.srt
 * directly; the pipeline must place these, not skip them as "unsupported archive". */
export function isLooseSubtitleFile(filePath: string): boolean {
  return SUBTITLE_EXTENSIONS.includes(extname(filePath).toLowerCase());
}

/** Whether this path looks like an archive we will *try* to extract (native or via 7z/unrar). */
export function isSupportedArchive(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.rar') ||
    lower.endsWith('.7z')
  );
}

/** True if the download can feed the place/match pipeline (archive or loose subtitle). */
export function isIngestibleSubtitlePayload(filePath: string): boolean {
  return isSupportedArchive(filePath) || isLooseSubtitleFile(filePath);
}

export function isNativeArchive(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')
  );
}

export function isSevenZipFamily(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.rar') || lower.endsWith('.7z');
}

export class UnsupportedArchiveError extends Error {
  constructor(archivePath: string, detail?: string) {
    super(detail ?? `unsupported archive format: ${archivePath}`);
    this.name = 'UnsupportedArchiveError';
  }
}

/**
 * Old Chinese fansub zips often store filenames as GBK bytes that JS sees as latin1
 * mojibake. When a re-decode as GBK yields CJK and the raw name does not, prefer GBK —
 * decoded via latin1 bytes + TextDecoder('gbk').
 */
export function decodeZipEntryName(name: string): string {
  if (/[\u4e00-\u9fff]/.test(name)) return name; // already has CJK
  try {
    const bytes = Buffer.from(name, 'latin1');
    const gbk = new TextDecoder('gbk').decode(bytes);
    if (/[\u4e00-\u9fff]/.test(gbk)) return gbk;
  } catch {
    // ICU without gbk — leave as-is
  }
  return name;
}

function isEmptyFile(path: string): boolean {
  try {
    return statSync(path).size === 0;
  } catch {
    return true;
  }
}

async function binAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--help'], { timeout: 5_000 });
    return true;
  } catch {
    try {
      // 7z on some distros wants no args / returns 0 on bare invoke differently
      await execFileAsync(bin, [], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Extract rar/7z via `7z` (p7zip) when present, else `unrar` for .rar only.
 * Throws UnsupportedArchiveError when no binary can handle the format, or the binary
 * rejects the archive (corrupt / not actually rar-7z) — callers treat that like skip.
 */
async function extractWithExternalTool(archivePath: string, destDir: string): Promise<void> {
  const lower = archivePath.toLowerCase();
  const run = async (bin: string, args: string[]): Promise<void> => {
    try {
      await execFileAsync(bin, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UnsupportedArchiveError(archivePath, `${bin} failed for ${basename(archivePath)}: ${msg}`);
    }
  };
  if (await binAvailable('7z')) {
    await run('7z', ['x', archivePath, `-o${destDir}`, '-y', '-bd']);
    return;
  }
  if (lower.endsWith('.rar') && (await binAvailable('unrar'))) {
    await run('unrar', ['x', '-o+', archivePath, destDir + '/']);
    return;
  }
  throw new UnsupportedArchiveError(
    archivePath,
    `rar/7z archive requires 7z or unrar on PATH: ${basename(archivePath)}`,
  );
}

async function collectSubtitleFiles(destDir: string, out: string[]): Promise<void> {
  const { walkFiles } = await import('../../fs/files.js');
  const kept = walkFiles(destDir, SUBTITLE_EXTENSIONS);
  const dest = (name: string): string => join(destDir, `${out.length}-${basename(name)}`);
  for (const p of kept) {
    if (isEmptyFile(p)) continue;
    // Already under destDir; re-prefix for stable numbered names when not already numbered.
    const base = basename(p);
    if (/^\d+-/.test(base) && p === join(destDir, base)) {
      out.push(p);
      continue;
    }
    const target = dest(p);
    if (p !== target) renameSync(p, target);
    out.push(target);
  }
}

/**
 * Copies a single .srt/.ass/.ssa into `destDir` with the same numbered-name contract as
 * extractArchive, so match/place can treat it like a one-file pack.
 */
export function materializeLooseSubtitle(filePath: string, destDir: string): string[] {
  mkdirSync(destDir, { recursive: true });
  if (!isLooseSubtitleFile(filePath)) {
    throw new UnsupportedArchiveError(filePath, `not a loose subtitle file: ${basename(filePath)}`);
  }
  const target = join(destDir, `0-${basename(filePath)}`);
  copyFileSync(filePath, target);
  return [target];
}

export async function extractArchive(archivePath: string, destDir: string): Promise<string[]> {
  mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (isLooseSubtitleFile(archivePath)) {
    return materializeLooseSubtitle(archivePath, destDir);
  }

  if (!isSupportedArchive(archivePath)) throw new UnsupportedArchiveError(archivePath);

  const out: string[] = [];
  const keep = (name: string): boolean => SUBTITLE_EXTENSIONS.includes(extname(name).toLowerCase());
  const dest = (name: string): string => join(destDir, `${out.length}-${basename(name)}`);

  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryName = decodeZipEntryName(entry.entryName);
      if (!keep(entryName)) continue;
      // Skip 0-byte placeholders fansub packs sometimes ship for missing episodes.
      const data = entry.getData();
      if (data.length === 0) continue;
      const target = dest(entryName);
      writeFileSync(target, data);
      out.push(target);
    }
    return out.sort();
  }

  if (isSevenZipFamily(archivePath)) {
    await extractWithExternalTool(archivePath, destDir);
    await collectSubtitleFiles(destDir, out);
    return out.sort();
  }

  // tar / tar.gz / tgz
  await tarExtract({ file: archivePath, cwd: destDir, filter: (path) => keep(path) });
  await collectSubtitleFiles(destDir, out);
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
