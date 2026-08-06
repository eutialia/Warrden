import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mapArrPath } from '../src/fs/paths.js';
import { walkFiles, atomicCopy, ensureMounts, MountError } from '../src/fs/files.js';
import { tmpDir } from './helpers.js';

describe('mapArrPath', () => {
  const MAPPINGS = [
    { from: '/data/downloads', to: '/mnt/nas/downloads' },
    { from: '/data', to: '/mnt/nas/data' },
  ];

  it.each([
    ['/data/downloads/t/a.mkv', '/mnt/nas/downloads/t/a.mkv'], // longest prefix wins
    ['/data/library/Show/a.mkv', '/mnt/nas/data/library/Show/a.mkv'],
    ['/elsewhere/a.mkv', '/elsewhere/a.mkv'], // no mapping → unchanged
    ['/data/downloadsX/a.mkv', '/mnt/nas/data/downloadsX/a.mkv'], // prefix must end at a path segment
    ['/data/downloads', '/mnt/nas/downloads'], // exact dir match
  ])('maps %s -> %s', (input, expected) => {
    expect(mapArrPath(MAPPINGS, input)).toBe(expected);
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
    expect(result).toEqual([join(dir, 'a.srt'), join(dir, 'sub', 'b.ASS')].sort());
  });

  it('skips dotfiles and .warrden-tmp- prefixed files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.hidden.srt'), '');
    writeFileSync(join(dir, '.warrden-tmp-a.srt'), '');
    writeFileSync(join(dir, 'visible.srt'), '');

    expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'visible.srt')]);
  });

  it('returns sorted absolute paths', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'z.srt'), '');
    writeFileSync(join(dir, 'a.srt'), '');

    expect(walkFiles(dir, ['.srt'])).toEqual([join(dir, 'a.srt'), join(dir, 'z.srt')]);
  });

  it('returns an empty array for a missing directory', () => {
    const dir = join(tmpDir(), 'does-not-exist');
    expect(walkFiles(dir, ['.srt'])).toEqual([]);
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

  it('does not leave a temp file behind when the copy fails', () => {
    const dir = tmpDir();
    const src = join(dir, 'does-not-exist.txt');
    const dest = join(dir, 'dest.txt');

    expect(() => atomicCopy(src, dest)).toThrow();

    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.warrden-tmp-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(dest)).toBe(false);
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
