import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
    // rar/7z are attempted via unrar/7z when present
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
    // and surfaces UnsupportedArchiveError when unrar/7z cannot open it (or are missing).
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

  it('skips an inner archive no extractor can open and keeps the rest of the pack', async () => {
    // AdmZip throws a plain Error on a file that is not a zip at all, so a corrupt inner
    // entry used to fail the whole pack instead of just itself.
    const zip = new AdmZip();
    zip.addFile('good.zip', zipBytes({ 'Show - 03.chs.ass': Buffer.from('dialogue') }));
    zip.addFile('broken.zip', Buffer.from('not a zip, just bytes'));
    const zipPath = join(tmpDir(), 'mixed.zip');
    zip.writeZip(zipPath);

    const dest = tmpDir();
    const files = await extractArchive(zipPath, dest);

    expect(files).toEqual([join(dest, 'good.zip.d', 'Show - 03.chs.ass')]);
    expect(existsSync(join(dest, 'broken.zip'))).toBe(true); // left on disk, nothing lost silently
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

/**
 * Routing tests for the rar/7z path: one decoder per format, no fallback. Real rar/7z
 * fixtures would need a real archiver on the machine running the suite, so the binaries
 * are shell stubs instead — which tool runs (and that no other one is consulted) is
 * entirely observable through exit codes and what lands in the destination dir.
 */
describe('external extractor routing', () => {
  /** Exits 1 after printing `reason` on stderr, like p7zip's "Unsupported Method". */
  function failingStub(reason: string): string {
    return `echo "${reason}" >&2\nexit 1`;
  }

  /** unrar's shape: `x -o+ <archive> <dest>/`, the destination as the last argument. */
  function unrarStub(fileName: string): string {
    return [
      'for dest in "$@"; do :; done',
      '[ -n "$dest" ] || exit 2',
      'mkdir -p "$dest"',
      `printf 'dialogue' > "$dest/${fileName}"`,
    ].join('\n');
  }

  /** 7z's shape: the destination is glued onto `-o`. */
  function sevenZipStub(fileName: string): string {
    return [
      'dest=""',
      'for arg in "$@"; do',
      '  case "$arg" in -o*) dest="${arg#-o}";; esac',
      'done',
      '[ -n "$dest" ] || exit 2',
      'mkdir -p "$dest"',
      `printf 'dialogue' > "$dest/${fileName}"`,
    ].join('\n');
  }

  /**
   * Writes `stubs` as executable shell scripts into a fresh dir and makes that dir the
   * entire PATH for `fn` — not a prefix, so a real `unrar`/`7z` installed on the machine
   * running the suite can never stand in for a binary the test means to be absent. Every
   * stub answers `--help` with exit 0, which is what `binAvailable` probes first.
   */
  async function withStubBins(stubs: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const dir = tmpDir();
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\n${body}\n`);
      chmodSync(path, 0o755);
    }
    const realPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await fn();
    } finally {
      process.env.PATH = realPath;
    }
  }

  /** A file with an archive extension; the stubs never read it, only the chain's routing does. */
  function fakeArchive(name: string): string {
    const path = join(tmpDir(), name);
    writeFileSync(path, 'bytes');
    return path;
  }

  it('a .rar goes to unrar, and nothing else is consulted', async () => {
    // A working 7z sits on PATH writing a different file; only unrar's output may appear.
    await withStubBins({ unrar: unrarStub('Show - 01.ass'), '7z': sevenZipStub('WRONG.ass') }, async () => {
      const dest = tmpDir();
      expect(await extractArchive(fakeArchive('pack.rar'), dest)).toEqual([join(dest, 'Show - 01.ass')]);
    });
  });

  it('a .7z goes to 7z, and nothing else is consulted', async () => {
    await withStubBins({ '7z': sevenZipStub('Show - 02.ass'), unrar: unrarStub('WRONG.ass') }, async () => {
      const dest = tmpDir();
      expect(await extractArchive(fakeArchive('pack.7z'), dest)).toEqual([join(dest, 'Show - 02.ass')]);
    });
  });

  it.each([
    ['pack.rar', 'unrar', { '7z': sevenZipStub('WRONG.ass') }],
    ['pack.7z', '7z', { unrar: unrarStub('WRONG.ass') }],
  ])("%s's own decoder failing is final — no second opinion from the other tool", async (name, bin, others) => {
    await withStubBins({ ...others, [bin]: failingStub('Unsupported Method') }, async () => {
      const dest = tmpDir();
      const err = await extractArchive(fakeArchive(name), dest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedArchiveError);
      expect((err as Error).message).toContain(`${bin} could not open ${name}: Unsupported Method`);
      expect(existsSync(join(dest, 'WRONG.ass'))).toBe(false);
    });
  });

  it.each([
    ['pack.rar', 'unrar', { '7z': sevenZipStub('WRONG.ass') }],
    ['pack.7z', '7z', { unrar: unrarStub('WRONG.ass') }],
  ])('names the one tool %s needs when it is not installed', async (name, bin, others) => {
    await withStubBins(others, async () => {
      const err = await extractArchive(fakeArchive(name), tmpDir()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedArchiveError);
      expect((err as Error).message).toContain(`requires ${bin} on PATH`);
    });
  });
});

describe('entriesForFiles', () => {
  it('annotates each file with lang and episode ref', () => {
    expect(entriesForFiles(['/d/Show - 01.ass', '/d/Show - 02.zh-Hans.ass'], '/d')).toEqual([
      { path: '/d/Show - 01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
      { path: '/d/Show - 02.zh-Hans.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
    ]);
  });

  it.each([
    // The real pack shape: one folder per language variant under a release folder that
    // advertises both, and filenames that carry no tag of their own.
    ['\u7b80\u4f53', '[YYDM-11FANS][Sword Art Online II][04][C40793FD].ass', 'zh-Hans'],
    ['\u7e41\u9ad4', '[YYDM-11FANS][Sword Art Online II][04][C40793FD].ass', 'zh-Hant'],
  ])('takes the language from the %s folder when the filename carries none', (dir, name, expected) => {
    const path = `/d/\u5f02\u57df/BD/[YYDM-11FANS][\u7b80\u7e41\u5916\u6302\u5b57\u5e55][01-24]/${dir}/${name}`;
    expect(entriesForFiles([path], '/d').map((e) => e.lang)).toEqual([expected]);
  });

  it('reads a bracketed folder tag too, and lets the filename overrule the folder', () => {
    const inFolder = '/d/DHR\u00d7\u767d\u6708/BD/\u7e41\u9ad4/[DHR][SUB][TC]/[DHR] Show - 04.ass';
    expect(entriesForFiles([inFolder], '/d').map((e) => e.lang)).toEqual(['zh-Hant']);
    // Same folder, a filename that names its own language: the file wins.
    const tagged = '/d/DHR\u00d7\u767d\u6708/BD/\u7e41\u9ad4/[DHR][SUB][TC]/[DHR] Show - 04.YY-SC.ass';
    expect(entriesForFiles([tagged], '/d').map((e) => e.lang)).toEqual(['zh-Hans']);
  });

  it('a folder claiming both variants keeps the scan going outward', () => {
    const path = '/d/\u7b80\u4f53/[YYDM][\u7b80\u7e41\u5916\u6302\u5b57\u5e55][01-24]/[YYDM] Show - 04.ass';
    expect(entriesForFiles([path], '/d').map((e) => e.lang)).toEqual(['zh-Hans']);
  });

  it('fills a missing season from the directories above the file', () => {
    const path = '/d/[\u4e2d\u6587\u5b57\u5e55\u5168\u7248\u672c][\u5200\u5251\u795e\u57df \u7b2c\u4e8c\u5b63 Sword Art Online II][BD+TV][170512].7z.d/[Group][01].chs.ass';
    expect(entriesForFiles([path], '/d')).toEqual([
      { path, lang: 'zh-Hans', episodeRef: { season: 2, episode: 1 } },
    ]);
  });
});
