import { describe, it, expect } from 'vitest';
import { resolveSourceDirsDetailed } from '../src/pipelines/ingest/sources.js';

function allDirs(dropped: readonly string[], roots: readonly string[]): string[] {
  return resolveSourceDirsDetailed([...dropped], [...roots]).all;
}

function rootDerivedDirs(dropped: readonly string[], roots: readonly string[]): string[] {
  return resolveSourceDirsDetailed([...dropped], [...roots]).rootDerived;
}

describe('resolveSourceDirsDetailed — all', () => {
  it.each([
    // torrent root = first path segment under a download root
    [['/dl/Torrent A/S1/e1.mkv', '/dl/Torrent A/S2/e2.mkv'], ['/dl'], ['/dl/Torrent A']],
    // file directly in a root = single-file torrent, nothing to sweep
    [['/dl/movie.mkv'], ['/dl'], []],
    // no configured root matching → fall back to the file's own dir
    [['/other/T/e1.mkv'], ['/dl'], ['/other/T']],
    // never the root itself, results deduped + sorted
    [['/dl/T/e1.mkv', '/dl/T/e2.mkv'], ['/dl'], ['/dl/T']],
  ] as const)('all(%j, %j) -> %j', (dropped, roots, expected) => {
    expect(allDirs(dropped, roots)).toEqual([...expected]);
  });

  it('a bare string prefix must not match past a path segment boundary', () => {
    // '/downloadsX' is NOT under root '/downloads' even though it starts with that string.
    expect(allDirs(['/downloadsX/T/e1.mkv'], ['/downloads'])).toEqual(['/downloadsX/T']);
  });

  it('the longest matching root wins when roots nest', () => {
    expect(allDirs(['/dl/sub/T/e1.mkv'], ['/dl', '/dl/sub'])).toEqual(['/dl/sub/T']);
  });

  it('results are sorted', () => {
    expect(allDirs(['/dl/Zeta/e1.mkv', '/dl/Alpha/e1.mkv'], ['/dl'])).toEqual(['/dl/Alpha', '/dl/Zeta']);
  });
});

describe('resolveSourceDirsDetailed — rootDerived', () => {
  it('excludes a dirname()-fallback dir that `all` would still include', () => {
    expect(allDirs(['/other/T/e1.mkv'], ['/dl'])).toEqual(['/other/T']);
    expect(rootDerivedDirs(['/other/T/e1.mkv'], ['/dl'])).toEqual([]);
  });

  it('includes a dir that resolved through a configured downloadRoots entry', () => {
    expect(rootDerivedDirs(['/dl/Torrent A/e1.mkv'], ['/dl'])).toEqual(['/dl/Torrent A']);
  });

  it('a dir reached both ways (root-derived for one dropped path, fallback for another) counts as root-derived', () => {
    const dropped = ['/dl/T/e1.mkv', '/dl/T/e2.mkv']; // both under the configured root, same torrent dir
    expect(rootDerivedDirs(dropped, ['/dl'])).toEqual(['/dl/T']);
  });

  it('a single-file torrent (directly in the root) contributes nothing to either field', () => {
    expect(allDirs(['/dl/movie.mkv'], ['/dl'])).toEqual([]);
    expect(rootDerivedDirs(['/dl/movie.mkv'], ['/dl'])).toEqual([]);
  });
});

describe('resolveSourceDirsDetailed — both fields together', () => {
  it('returns {all, rootDerived} for a mix of root-derived and fallback dirs', () => {
    const dropped = ['/dl/Torrent A/e1.mkv', '/other/T/e1.mkv'];
    const roots = ['/dl'];

    expect(resolveSourceDirsDetailed(dropped, roots)).toEqual({
      all: ['/dl/Torrent A', '/other/T'],
      rootDerived: ['/dl/Torrent A'],
    });
  });
});
