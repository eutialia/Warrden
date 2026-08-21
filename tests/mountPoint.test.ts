import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containingMount, isEmptyDir } from '../src/fs/mountPoint.js';
import { tmpDir } from './helpers.js';

describe('containingMount', () => {
  it('walks up to the root when everything shares one device', () => {
    const root = tmpDir();
    const child = join(root, 'Series');
    mkdirSync(child);
    expect(containingMount(child)).toBe(containingMount(root));
  });

  it('stops at the first ancestor whose device differs', () => {
    const root = tmpDir();
    const share = join(root, 'media');
    const series = join(share, 'Series');
    mkdirSync(series, { recursive: true });

    // A real NFS mount at `share`: everything below it reports one device, everything
    // above it reports another. A test cannot mount a share, so the stat is injected.
    const stat = (p: string) => ({ dev: p.startsWith(share) ? 42 : 7 });
    expect(containingMount(series, stat)).toBe(share);
  });

  it('ends the walk at a parent it cannot stat', () => {
    const stat = (p: string) => {
      if (p === '/mnt') throw new Error('EACCES');
      return { dev: 1 };
    };
    expect(containingMount('/mnt/media/Series', stat)).toBe('/mnt/media');
  });

  it('returns the path itself when it is the root', () => {
    expect(containingMount('/')).toBe('/');
  });
});

describe('isEmptyDir', () => {
  it('is true for a directory with no entries', () => {
    expect(isEmptyDir(tmpDir())).toBe(true);
  });

  it('is false for a directory holding a file', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'Show.mkv'), 'video');
    expect(isEmptyDir(dir)).toBe(false);
  });

  it('is false for a path it cannot read, which is not the same as empty', () => {
    expect(isEmptyDir(join(tmpDir(), 'nope'))).toBe(false);
  });
});
