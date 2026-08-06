import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { mapArrPath } from '../src/fs/paths.js';
import { walkFiles, atomicCopy, ensureMounts, MountError } from '../src/fs/files.js';
import { tmpDir } from './helpers.js';

// walkFiles' sort-order test below needs readdirSync to hand back one specific directory's
// entries in a deliberately non-lexicographic order — real filesystems can't be coerced
// into that from a test, so it's mocked instead. `readdirState.reverseDir` is unset (real
// behavior) for every other test in this file, including the `.zfs` pruning test, which
// relies on the real EACCES from an unreadable directory. `vi.mock` factories are hoisted
// above imports, so the mutable state has to come from `vi.hoisted` (a plain `const` here
// would hit a TDZ error).
const readdirState = vi.hoisted(() => ({ reverseDir: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((p: unknown, opts: unknown): unknown => {
      const entries = (actual.readdirSync as (p: unknown, opts: unknown) => unknown)(p, opts);
      return p === readdirState.reverseDir && Array.isArray(entries) ? [...entries].reverse() : entries;
    }) as typeof actual.readdirSync,
  };
});

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

  it('returns results sorted even when readdir yields entries in a non-lexicographic order', () => {
    // walkFiles walks depth-first in whatever order readdirSync hands back each directory's
    // entries — real filesystems often (but aren't guaranteed to) already return entries
    // lexicographically, which would let a plain two-file fixture pass even with the final
    // `.sort()` deleted. Forcing a genuinely reversed order via the module mock above is
    // what makes this test actually discriminate the sort from directory-entry luck.
    const dir = tmpDir();
    writeFileSync(join(dir, 'a.srt'), '');
    writeFileSync(join(dir, 'b.srt'), '');

    readdirState.reverseDir = dir;
    try {
      expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'a.srt'), join(dir, 'b.srt')]);
    } finally {
      readdirState.reverseDir = null;
    }
  });

  it('prunes a dot-directory before ever calling readdir on it', () => {
    const dir = tmpDir();
    const hidden = join(dir, '.zfs');
    mkdirSync(hidden);
    writeFileSync(join(hidden, 'ghost.srt'), '');
    writeFileSync(join(dir, 'visible.srt'), '');

    // chmod 0 makes `.zfs` unreadable: post-filtering (checking the dot-prefix only
    // after readdir has already recursed into every subdirectory) would throw EACCES
    // trying to list it; pruning by name *before* ever calling readdir on it never
    // touches the directory at all, so this only passes under real pruning.
    chmodSync(hidden, 0o000);
    try {
      expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'visible.srt')]);
    } finally {
      chmodSync(hidden, 0o755);
    }
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
