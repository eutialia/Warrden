import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { create as tarCreate } from 'tar';
import { describe, expect, it } from 'vitest';
import { entriesForFiles, extractArchive, isArchive, UnsupportedArchiveError } from '../src/pipelines/subtitle/archives.js';
import { tmpDir } from './helpers.js';

function makeZip(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  const path = join(tmpDir(), 'pack.zip');
  zip.writeZip(path);
  return path;
}

describe('isArchive', () => {
  it.each([
    ['a.zip', true], ['a.ZIP', true], ['a.rar', true], ['a.7z', true],
    ['a.tar', true], ['a.tar.gz', true], ['a.tgz', true],
    ['a.ass', false], ['a.mkv', false], ['a.zipx', false],
  ])('%s -> %s', (name, expected) => expect(isArchive(name)).toBe(expected));
});

describe('extractArchive', () => {
  it('extracts only subtitle files, flattening names', async () => {
    const zipPath = makeZip({
      'S1/Show - 01.ass': 'a',
      'S1/Show - 02.zh-Hans.ass': 'b',
      'S1/font.ttf': 'c',
      'S1/Show - 01.mkv': 'd',
    });
    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.ass'))).toBe(true);
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

  it('extracts only subtitles from tar.gz, flattening names', async () => {
    const tarPath = makeTarGz({
      'S1/Show - 01.ass': 'a',
      'S1/Show - 02.zh-Hans.ass': 'b',
      'S1/font.ttf': 'c',
      'S1/Show - 01.mkv': 'd',
    });
    const dest = tmpDir();
    const files = await extractArchive(tarPath, dest);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.ass'))).toBe(true);
    // flattened as sorted `<index>-<basename>` pairs, same contract as zip
    expect(files).toEqual(
      expect.arrayContaining([join(dest, '0-Show - 01.ass'), join(dest, '1-Show - 02.zh-Hans.ass')]),
    );
  });

  it('extracts same-named files from nested dirs without collision', async () => {
    const tarPath = makeTarGz({
      'A/01.ass': 'a',
      'B/01.ass': 'b',
    });
    const dest = tmpDir();
    const files = await extractArchive(tarPath, dest);
    expect(files).toHaveLength(2);
    expect(files).toEqual(expect.arrayContaining([join(dest, '0-01.ass'), join(dest, '1-01.ass')]));
  });

  it('throws UnsupportedArchiveError for rar/7z', async () => {
    await expect(extractArchive('/x/pack.rar', tmpDir())).rejects.toBeInstanceOf(UnsupportedArchiveError);
    await expect(extractArchive('/x/pack.7z', tmpDir())).rejects.toBeInstanceOf(UnsupportedArchiveError);
  });
});

describe('entriesForFiles', () => {
  it('annotates each file with lang and episode ref', () => {
    expect(entriesForFiles(['/d/0-Show - 01.ass', '/d/1-Show - 02.zh-Hans.ass'])).toEqual([
      { path: '/d/0-Show - 01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
      { path: '/d/1-Show - 02.zh-Hans.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
    ]);
  });
});
