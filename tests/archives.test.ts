import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { create as tarCreate } from 'tar';
import { describe, expect, it } from 'vitest';
import {
  entriesForFiles,
  extractArchive,
  isIngestibleSubtitlePayload,
  isLooseSubtitleFile,
  isSevenZipFamily,
  isSupportedArchive,
  UnsupportedArchiveError,
} from '../src/pipelines/subtitle/archives.js';
import { tmpDir } from './helpers.js';

function makeZip(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  const path = join(tmpDir(), 'pack.zip');
  zip.writeZip(path);
  return path;
}

/** A zip holding one `.ass`, returned as raw bytes so it can be nested inside another zip. */
function zipBytes(files: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, content);
  return zip.toBuffer();
}

/**
 * Writes `level1.zip`, a chain of `levels` zips each holding the next one, with a single
 * `deep.ass` at the bottom. `levels: 5` means five extractions are needed to reach the
 * subtitle.
 */
function nestedZipChain(levels: number): string {
  let data = zipBytes({ 'deep.ass': Buffer.from('dialogue') });
  for (let i = levels; i >= 2; i--) data = zipBytes({ [`level${i}.zip`]: data });
  const path = join(tmpDir(), 'level1.zip');
  writeFileSync(path, data);
  return path;
}

describe('isSupportedArchive', () => {
  it.each([
    ['a.zip', true], ['a.ZIP', true],
    ['a.tar', true], ['a.tar.gz', true], ['a.tgz', true],
    // rar/7z are attempted via 7z/unrar when present
    ['a.rar', true], ['a.7z', true],
    ['a.ass', false], ['a.mkv', false], ['a.zipx', false],
  ])('%s -> %s', (name, expected) => expect(isSupportedArchive(name)).toBe(expected));
});

describe('extractArchive', () => {
  it('extracts only subtitle files, keeping the directories they came from', async () => {
    const zipPath = makeZip({
      'S1/Show - 01.ass': 'a',
      'S1/Show - 02.zh-Hans.ass': 'b',
      'S1/font.ttf': 'c',
      'S1/Show - 01.mkv': 'd',
    });
    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);
    expect(files).toEqual([join(dest, 'S1', 'Show - 01.ass'), join(dest, 'S1', 'Show - 02.zh-Hans.ass')]);
  });

  it('drops a zip entry that tries to escape the destination dir', async () => {
    // AdmZip normalizes a traversal name passed to addFile, so the entry name is rewritten
    // on the built entry — which is exactly what a hand-rolled hostile zip does anyway.
    const zip = new AdmZip();
    zip.addFile('escape.ass', Buffer.from('a'));
    zip.addFile('S1/Show - 01.ass', Buffer.from('b'));
    zip.getEntries()[0]!.entryName = '../escape.ass';
    const zipPath = join(tmpDir(), 'traversal.zip');
    zip.writeZip(zipPath);

    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);
    expect(files).toEqual([join(dest, 'S1', 'Show - 01.ass')]);
  });

  it('skips 0-byte placeholder subtitle files', async () => {
    const zipPath = makeZip({
      'Show - 01.ass': 'dialogue',
      'Show - 02.ass': '',
    });
    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/Show - 01\.ass$/);
  });

  it('materializes a loose .ass download as a one-file pack', async () => {
    expect(isLooseSubtitleFile('x.ass')).toBe(true);
    expect(isIngestibleSubtitlePayload('x.ass')).toBe(true);
    const src = join(tmpDir(), 'Show.ass');
    writeFileSync(src, 'dialogue');
    const dest = tmpDir();
    const files = await extractArchive(src, dest);
    expect(files).toEqual([join(dest, 'Show.ass')]);
  });

  it('classifies rar/7z as seven-zip family and throws when no extractor binary works', async () => {
    expect(isSevenZipFamily('a.rar')).toBe(true);
    expect(isSevenZipFamily('a.7z')).toBe(true);
    // A non-archive path that only looks like rar: extract still attempts external tool
    // and surfaces UnsupportedArchiveError when 7z/unrar cannot open it (or are missing).
    const bogus = join(tmpDir(), 'empty.rar');
    writeFileSync(bogus, 'not-a-real-rar');
    await expect(extractArchive(bogus, tmpDir())).rejects.toBeInstanceOf(UnsupportedArchiveError);
  });

  /**
   * Builds a `.tar.gz` from a temp source dir populated by `seed`, then returns the
   * archive path. Uses the real `tar` package (same one `extractArchive` uses to unpack)
   * so the fixture exercises the genuine tar/gzip code path end to end.
   */
  function makeTarGz(seed: Record<string, string>): string {
    const src = tmpDir();
    for (const [rel, content] of Object.entries(seed)) {
      const full = join(src, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    const path = join(tmpDir(), 'pack.tar.gz');
    tarCreate({ gzip: true, file: path, cwd: src, sync: true }, Object.keys(seed));
    return path;
  }

  it('extracts only subtitles from tar.gz, keeping their directories', async () => {
    const tarPath = makeTarGz({
      'S1/Show - 01.ass': 'a',
      'S1/Show - 02.zh-Hans.ass': 'b',
      'S1/font.ttf': 'c',
      'S1/Show - 01.mkv': 'd',
    });
    const dest = tmpDir();
    const files = await extractArchive(tarPath, dest);
    expect(files).toEqual([join(dest, 'S1', 'Show - 01.ass'), join(dest, 'S1', 'Show - 02.zh-Hans.ass')]);
  });

  it('keeps same-named files from sibling dirs apart', async () => {
    const tarPath = makeTarGz({
      'A/01.ass': 'a',
      'B/01.ass': 'b',
    });
    const dest = tmpDir();
    const files = await extractArchive(tarPath, dest);
    expect(files).toEqual([join(dest, 'A', '01.ass'), join(dest, 'B', '01.ass')]);
  });

  it('unpacks an inner archive into a sibling dir named after it, then removes it', async () => {
    const inner = zipBytes({ 'Show - 03.chs.ass': Buffer.from('dialogue') });
    const zip = new AdmZip();
    zip.addFile('Show Season 2/inner.zip', inner);
    const zipPath = join(tmpDir(), 'outer.zip');
    zip.writeZip(zipPath);

    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);

    expect(files).toEqual([join(dest, 'Show Season 2', 'inner.zip.d', 'Show - 03.chs.ass')]);
    expect(existsSync(join(dest, 'Show Season 2', 'inner.zip'))).toBe(false);
  });

  it('unpacks up to four archives deep', async () => {
    const dest = tmpDir();
    const files = await extractArchive(nestedZipChain(4), dest);
    expect(files).toEqual([join(dest, 'level2.zip.d', 'level3.zip.d', 'level4.zip.d', 'deep.ass')]);
  });

  it('stops at the depth limit, leaving the fifth archive packed', async () => {
    const dest = tmpDir();
    const files = await extractArchive(nestedZipChain(5), dest);
    expect(files).toEqual([]);
    expect(existsSync(join(dest, 'level2.zip.d', 'level3.zip.d', 'level4.zip.d', 'level5.zip'))).toBe(true);
  });

  it('throws UnsupportedArchiveError for missing or unreadable rar/7z', async () => {
    await expect(extractArchive('/x/pack.rar', tmpDir())).rejects.toBeInstanceOf(UnsupportedArchiveError);
    await expect(extractArchive('/x/pack.7z', tmpDir())).rejects.toBeInstanceOf(UnsupportedArchiveError);
  });
});

describe('entriesForFiles', () => {
  it('annotates each file with lang and episode ref', () => {
    expect(entriesForFiles(['/d/Show - 01.ass', '/d/Show - 02.zh-Hans.ass'], '/d')).toEqual([
      { path: '/d/Show - 01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
      { path: '/d/Show - 02.zh-Hans.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
    ]);
  });

  it('fills a missing season from the directories above the file', () => {
    const path = '/d/[\u4e2d\u6587\u5b57\u5e55\u5168\u7248\u672c][\u5200\u5251\u795e\u57df \u7b2c\u4e8c\u5b63 Sword Art Online II][BD+TV][170512].7z.d/[Group][01].chs.ass';
    expect(entriesForFiles([path], '/d')).toEqual([
      { path, lang: 'zh-Hans', episodeRef: { season: 2, episode: 1 } },
    ]);
  });
});
