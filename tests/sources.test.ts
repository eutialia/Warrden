import { describe, it, expect } from 'vitest';
import { resolveSourceDirs } from '../src/pipelines/ingest/sources.js';

describe('resolveSourceDirs', () => {
  it.each([
    // torrent root = first path segment under a download root
    [['/dl/Torrent A/S1/e1.mkv', '/dl/Torrent A/S2/e2.mkv'], ['/dl'], ['/dl/Torrent A']],
    // file directly in a root = single-file torrent, nothing to sweep
    [['/dl/movie.mkv'], ['/dl'], []],
    // no configured root matching → fall back to the file's own dir
    [['/other/T/e1.mkv'], ['/dl'], ['/other/T']],
    // never the root itself, results deduped + sorted
    [['/dl/T/e1.mkv', '/dl/T/e2.mkv'], ['/dl'], ['/dl/T']],
  ] as const)('resolveSourceDirs(%j, %j) -> %j', (dropped, roots, expected) => {
    expect(resolveSourceDirs([...dropped], [...roots])).toEqual([...expected]);
  });

  it('a bare string prefix must not match past a path segment boundary', () => {
    // '/downloadsX' is NOT under root '/downloads' even though it starts with that string.
    expect(resolveSourceDirs(['/downloadsX/T/e1.mkv'], ['/downloads'])).toEqual(['/downloadsX/T']);
  });

  it('the longest matching root wins when roots nest', () => {
    expect(resolveSourceDirs(['/dl/sub/T/e1.mkv'], ['/dl', '/dl/sub'])).toEqual(['/dl/sub/T']);
  });

  it('results are sorted', () => {
    expect(resolveSourceDirs(['/dl/Zeta/e1.mkv', '/dl/Alpha/e1.mkv'], ['/dl'])).toEqual(['/dl/Alpha', '/dl/Zeta']);
  });
});
