import { describe, it, expect } from 'vitest';
import { prefilter } from '../src/pipelines/acquire/prefilter.js';
import { candidate } from './helpers.js';

const opts = { seederFloor: 3, minSizeMB: 50, maxSizeMB: 60000 };

describe('prefilter', () => {
  it.each([
    { name: 'arr-rejected', c: candidate({ rejected: true, rejections: ['Unknown quality'] }), reason: 'rejected' },
    { name: 'low seeders', c: candidate({ seeders: 1 }), reason: 'seeders' },
    { name: 'too small', c: candidate({ size: 10 * 1_048_576 }), reason: 'size' },
    { name: 'too big', c: candidate({ size: 90000 * 1_048_576 }), reason: 'size' },
  ])('drops $name', ({ c, reason }) => {
    const res = prefilter([c], opts);
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0].reason).toContain(reason);
  });

  it.each([
    { name: 'healthy candidate', c: candidate({}) },
    { name: 'null seeders (indexer silent)', c: candidate({ seeders: null }) },
    // Sonarr/Radarr omit seeders/leechers entirely on Usenet releases: the field is
    // `undefined` at runtime despite the type saying `number | null`. Missing must be
    // treated exactly like null (kept), not coerced into a falsy "0 seeders" drop.
    { name: 'undefined seeders (usenet release)', c: candidate({ seeders: undefined as unknown as null }) },
  ])('keeps $name', ({ c }) => {
    expect(prefilter([c], opts).kept).toHaveLength(1);
  });

  it('keeps relative order of kept candidates', () => {
    const a = candidate({ guid: 'a' });
    const b = candidate({ guid: 'b', seeders: 0 });
    const c = candidate({ guid: 'c' });
    expect(prefilter([a, b, c], opts).kept.map((x) => x.guid)).toEqual(['a', 'c']);
  });
});
