import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { extract as tarExtract } from 'tar';
import type { ArchiveCacheEntry } from '../../db/archiveCache.js';
import { walkFiles } from '../../fs/files.js';
import { parseEpisodeRefWithHint, parseLangTagWithHint } from '../ingest/sidecars.js';

const execFileAsync = promisify(execFile);
const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];

/** Extensions `walkFiles` must surface so nested archives can be found and opened. `.gz`
 * is here for `.tar.gz`; a bare `.gz` fails `isSupportedArchive` and is ignored. */
const ARCHIVE_EXTENSIONS: readonly string[] = ['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z'];

/** How many archives deep one download may nest before unpacking stops. Real packs go
 * three: an outer 7z holding a 7z per season, one of which holds a rar. Four leaves room
 * for one more surprise while still bounding a zip bomb. */
const MAX_ARCHIVE_DEPTH = 4;

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
 * Extracts a rar/7z archive with whichever external binary is on PATH. For .rar, rarlab's
 * `unrar` goes first: p7zip rejects the newer RAR methods fansub packs ship with, so `7z`
 * is only the fallback there. Everything else goes to `7z`.
 * Throws UnsupportedArchiveError when neither binary is installed, or the one that ran
 * rejected the archive (corrupt, or not actually rar/7z); callers treat that like skip.
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
  // rarlab's unrar goes first for .rar: p7zip rejects the newer RAR methods fansub packs
  // ship with ("Unsupported Method"), so 7z is only the fallback when unrar is absent.
  const haveUnrar = lower.endsWith('.rar') && (await binAvailable('unrar'));
  if (haveUnrar) {
    await run('unrar', ['x', '-o+', archivePath, destDir + '/']);
    return;
  }
  if (await binAvailable('7z')) {
    await run('7z', ['x', archivePath, `-o${destDir}`, '-y', '-bd']);
    return;
  }
  throw new UnsupportedArchiveError(
    archivePath,
    `rar/7z archive requires 7z or unrar on PATH: ${basename(archivePath)}`,
  );
}

/**
 * Copies a single .srt/.ass/.ssa into `destDir` under its own name, so match/place can
 * treat it like a one-file pack.
 */
export function materializeLooseSubtitle(filePath: string, destDir: string): string[] {
  mkdirSync(destDir, { recursive: true });
  if (!isLooseSubtitleFile(filePath)) {
    throw new UnsupportedArchiveError(filePath, `not a loose subtitle file: ${basename(filePath)}`);
  }
  const target = join(destDir, basename(filePath));
  copyFileSync(filePath, target);
  return [target];
}

/**
 * Turns one zip entry name into a path relative to the extraction dir, or `null` when the
 * entry tries to leave it: an absolute path (POSIX or `C:\`-style) or any `..` segment.
 * A hostile or merely sloppy archive must not be able to write outside the cache dir.
 */
function safeRelativeEntryPath(entryName: string): string | null {
  if (/^([A-Za-z]:)?[/\\]/.test(entryName)) return null;
  const parts = entryName.split(/[/\\]/).filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return join(...parts);
}

/** True for what `extractInto` bothers writing out: subtitles, plus archives that may hold
 * more of them. */
function worthExtracting(name: string): boolean {
  return isLooseSubtitleFile(name) || isSupportedArchive(name);
}

/** Unpacks one archive into `destDir`, preserving the paths inside it. Nothing else: the
 * caller walks the result and decides what to do with what landed. */
async function extractInto(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  if (archivePath.toLowerCase().endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryName = decodeZipEntryName(entry.entryName);
      if (!worthExtracting(entryName)) continue;
      const rel = safeRelativeEntryPath(entryName);
      if (rel === null) continue;
      // Skip 0-byte placeholders fansub packs sometimes ship for missing episodes.
      const data = entry.getData();
      if (data.length === 0) continue;
      const target = join(destDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
    return;
  }

  if (isSevenZipFamily(archivePath)) {
    await extractWithExternalTool(archivePath, destDir);
    return;
  }

  // tar / tar.gz / tgz
  await tarExtract({ file: archivePath, cwd: destDir, filter: (path) => worthExtracting(path) });
}

/**
 * Walks `dir`, appending every non-empty subtitle file to `out` exactly where it sits, and
 * unpacking every archive it finds into a sibling `<name>.d/` before descending into that
 * too. `depth` counts the extractions already done along this branch, and nothing past
 * `MAX_ARCHIVE_DEPTH` is opened — the archive just stays on disk, unread.
 *
 * An inner archive that fails to extract is skipped, not fatal: the rest of the pack is
 * still worth having, and the file is left in place rather than deleted so nothing is lost
 * silently. Any failure counts, not just `UnsupportedArchiveError`: AdmZip throws a plain
 * Error on a corrupt .zip and tar throws on a truncated one, and one bad member should not
 * cost the pack. Only the outermost archive failing to open reaches the caller as an error.
 */
async function collectFrom(dir: string, out: string[], depth: number): Promise<void> {
  const nested: string[] = [];
  for (const path of walkFiles(dir, [...SUBTITLE_EXTENSIONS, ...ARCHIVE_EXTENSIONS])) {
    if (isLooseSubtitleFile(path)) {
      if (!isEmptyFile(path)) out.push(path);
    } else if (isSupportedArchive(path)) {
      nested.push(path);
    }
  }
  if (depth >= MAX_ARCHIVE_DEPTH) return;

  for (const archive of nested) {
    const innerDir = `${archive}.d`;
    try {
      await extractInto(archive, innerDir);
    } catch {
      continue;
    }
    rmSync(archive, { force: true });
    await collectFrom(innerDir, out, depth + 1);
  }
}

/**
 * Unpacks `archivePath` into `destDir` and returns the absolute path of every subtitle
 * file inside, sorted. Directory structure is preserved rather than flattened, because a
 * fansub pack's folder names are load-bearing: they're where the season and often the
 * group live, and the episode-number-only filenames underneath mean nothing without them.
 * Archives nested inside the pack are unpacked in place (into `<name>.d/`) up to
 * `MAX_ARCHIVE_DEPTH`, so a season-per-7z bundle resolves to one flat list of real files.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<string[]> {
  mkdirSync(destDir, { recursive: true });

  if (isLooseSubtitleFile(archivePath)) return materializeLooseSubtitle(archivePath, destDir);
  if (!isSupportedArchive(archivePath)) throw new UnsupportedArchiveError(archivePath);

  await extractInto(archivePath, destDir);

  const out: string[] = [];
  await collectFrom(destDir, out, 1);
  return out.sort();
}

/**
 * Pre-annotates each extracted file for the cache: its language tag, and the episode it
 * refers to. `rootDir` is the extraction root, so the directories between it and the file
 * can supply what the filename itself omits — a season (`parseEpisodeRefWithHint`) and, in
 * packs that split one release into a folder per variant, the language
 * (`parseLangTagWithHint`). Both hints read the same segment list, since both facts live in
 * the same folder names.
 */
export function entriesForFiles(files: string[], rootDir: string): ArchiveCacheEntry[] {
  return files.map((path) => {
    const name = basename(path);
    const segments = dirname(relative(rootDir, path)).split(sep).filter((s) => s.length > 0 && s !== '.');
    return { path, lang: parseLangTagWithHint(name, segments), episodeRef: parseEpisodeRefWithHint(name, segments) };
  });
}
