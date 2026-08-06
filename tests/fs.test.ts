import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { mapArrPath } from '../src/fs/paths.js';
import { walkFiles, atomicCopy, ensureMounts, MountError } from '../src/fs/files.js';
import { tmpDir } from './helpers.js';

describe('mapArrPath', () => {
  const MAPPINGS = [
    { from: '/data/downloads', to: '/mnt/nas/downloads' },
    { from: '/data', to: '/mnt/nas/data' },
  ];

  it.each([
    { mappings: MAPPINGS, input: '/data/downloads/t/a.mkv', expected: '/mnt/nas/downloads/t/a.mkv' }, // longest prefix wins
    { mappings: MAPPINGS, input: '/data/library/Show/a.mkv', expected: '/mnt/nas/data/library/Show/a.mkv' },
    { mappings: MAPPINGS, input: '/elsewhere/a.mkv', expected: '/elsewhere/a.mkv' }, // no mapping → unchanged
    { mappings: MAPPINGS, input: '/data/downloadsX/a.mkv', expected: '/mnt/nas/data/downloadsX/a.mkv' }, // prefix must end at a path segment
    { mappings: MAPPINGS, input: '/data/downloads', expected: '/mnt/nas/downloads' }, // exact dir match
    {
      mappings: [{ from: '/data/downloads/', to: '/mnt/nas/downloads' }],
      input: '/data/downloads/t/a.mkv',
      expected: '/mnt/nas/downloads/t/a.mkv',
    }, // trailing slash on `from` is stripped before matching
    {
      mappings: [{ from: '/data', to: '/mnt/nas/data/' }],
      input: '/data/x.mkv',
      expected: '/mnt/nas/data/x.mkv',
    }, // trailing slash on `to` is stripped too (avoid a `//` artifact in the result)
  ])('maps $input -> $expected', ({ mappings, input, expected }) => {
    expect(mapArrPath(mappings, input)).toBe(expected);
  });
});

describe('walkFiles', () => {
  it('finds matching extensions recursively, case-insensitively', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.srt'), '');
    writeFileSync(join(dir, 'sub', 'b.ASS'), '');
    writeFileSync(join(dir, 'ignored.txt'), '');

    const result = walkFiles(dir, ['.srt', '.ass']);
    expect(result).toEqual([join(dir, 'a.srt'), join(dir, 'sub', 'b.ASS')]);
  });

  it('skips dotfiles and .warrden-tmp- prefixed files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.hidden.srt'), '');
    writeFileSync(join(dir, '.warrden-tmp-a.srt'), '');
    writeFileSync(join(dir, 'visible.srt'), '');

    expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'visible.srt')]);
  });

  it('skips files under dot-directories (NAS housekeeping trees like .Trashes/.zfs/.AppleDouble)', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.recycle'), { recursive: true });
    writeFileSync(join(dir, '.recycle', 'ghost.srt'), '');
    writeFileSync(join(dir, 'visible.srt'), '');

    expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'visible.srt')]);
  });

  it('returns paths in sorted order even when recursive readdir order is not lexicographic', () => {
    // Node's recursive readdirSync yields top-level entries before descending into
    // subdirectories, so `b.srt` (top level) is visited before `a/z.srt` (nested) —
    // the opposite of lexicographic order. Without an explicit sort, walkFiles would
    // return [b.srt, a/z.srt] here instead of the sorted [a/z.srt, b.srt].
    const dir = tmpDir();
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'z.srt'), '');
    writeFileSync(join(dir, 'b.srt'), '');

    expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'a', 'z.srt'), join(dir, 'b.srt')]);
  });

  it('returns an empty array for a missing directory', () => {
    const dir = join(tmpDir(), 'does-not-exist');
    expect(walkFiles(dir, ['.srt'])).toEqual([]);
  });

  it('returns absolute paths even when given a relative directory', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'a.srt'), '');
    const relDir = relative(process.cwd(), dir);

    const result = walkFiles(relDir, ['.srt']);

    expect(result).toEqual([join(dir, 'a.srt')]);
    expect(result.every((p) => isAbsolute(p))).toBe(true);
  });
});

describe('atomicCopy', () => {
  it('copies file content to the destination', () => {
    const dir = tmpDir();
    const src = join(dir, 'src.txt');
    const dest = join(dir, 'dest.txt');
    writeFileSync(src, 'hello world');

    atomicCopy(src, dest);

    expect(readFileSync(dest, 'utf8')).toBe('hello world');
  });

  it('never leaves a .warrden-tmp-* file behind after returning', () => {
    const dir = tmpDir();
    const src = join(dir, 'src.txt');
    const dest = join(dir, 'dest.txt');
    writeFileSync(src, 'content');

    atomicCopy(src, dest);

    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.warrden-tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('replaces the content of an existing destination', () => {
    const dir = tmpDir();
    const src = join(dir, 'src.txt');
    const dest = join(dir, 'dest.txt');
    writeFileSync(src, 'new content');
    writeFileSync(dest, 'old content');

    atomicCopy(src, dest);

    expect(readFileSync(dest, 'utf8')).toBe('new content');
  });

  it('leaves dest absent when the copy fails (missing src)', () => {
    const dir = tmpDir();
    const src = join(dir, 'does-not-exist.txt');
    const dest = join(dir, 'dest.txt');

    expect(() => atomicCopy(src, dest)).toThrow();

    expect(existsSync(dest)).toBe(false);
  });

  it('does not leave a temp file behind when the rename into place fails', () => {
    const dir = tmpDir();
    const src = join(dir, 'src.txt');
    // `dest` is a directory, not a file: copyFileSync to the temp sibling succeeds, but
    // renameSync onto an existing directory throws EISDIR — this is what actually
    // exercises the cleanup unlink (a missing src, by contrast, fails before the temp
    // file is ever created, so it never touches the cleanup path at all).
    const dest = join(dir, 'dest');
    writeFileSync(src, 'content');
    mkdirSync(dest);

    expect(() => atomicCopy(src, dest)).toThrow();

    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.warrden-tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('ensureMounts', () => {
  it('is a no-op for an empty marker list', () => {
    expect(() => ensureMounts([])).not.toThrow();
  });

  it('does not throw when all markers are present', () => {
    const dir = tmpDir();
    const marker = join(dir, 'MOUNTED');
    writeFileSync(marker, '');

    expect(() => ensureMounts([marker])).not.toThrow();
  });

  it('throws MountError listing exactly the absent paths', () => {
    const dir = tmpDir();
    const present = join(dir, 'present');
    writeFileSync(present, '');
    const missing1 = join(dir, 'missing1');
    const missing2 = join(dir, 'missing2');

    let error: unknown;
    try {
      ensureMounts([present, missing1, missing2]);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(MountError);
    expect((error as InstanceType<typeof MountError>).missing).toEqual([missing1, missing2]);
  });
});
