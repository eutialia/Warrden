import { describe, it, expect } from 'vitest';
import { capCandidates, dedupByInfoHash, prefilter } from '../src/pipelines/acquire/prefilter.js';
import { BYTES_PER_MB } from '../src/util/bytes.js';
import { candidate } from './helpers.js';

const opts = { seederFloor: 3, minSizeMB: 50, maxSizeMB: 60000 };

describe('prefilter', () => {
  it.each([
    { name: 'arr-rejected', c: candidate({ rejected: true, rejections: ['Unknown quality'] }), reason: 'rejected' },
    { name: 'low seeders', c: candidate({ seeders: 1 }), reason: 'seeders' },
    { name: 'too small', c: candidate({ size: 10 * BYTES_PER_MB }), reason: 'size' },
    { name: 'too big', c: candidate({ size: 90000 * BYTES_PER_MB }), reason: 'size' },
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
    { name: 'seeders exactly at the floor', c: candidate({ seeders: opts.seederFloor }) },
    { name: 'size exactly at the minimum', c: candidate({ size: opts.minSizeMB * BYTES_PER_MB }) },
    { name: 'size exactly at the maximum', c: candidate({ size: opts.maxSizeMB * BYTES_PER_MB }) },
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

describe('dedupByInfoHash', () => {
  it('keeps the higher-seeded copy of the same torrent and drops the other', () => {
    const nyaa = candidate({ guid: 'nyaa', infoHash: 'e1057f27ace6be8c0d444a711e05c2612e225c77', seeders: 130, indexer: 'Nyaa' });
    const rarbg = candidate({ guid: 'rarbg', infoHash: 'E1057F27ACE6BE8C0D444A711E05C2612E225C77', seeders: 46, indexer: 'TheRARBG' });
    const res = dedupByInfoHash([rarbg, nyaa]);
    expect(res.kept.map((c) => c.guid)).toEqual(['nyaa']);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toContain('duplicate');
    expect(res.dropped[0]!.reason).toContain('nyaa');
  });

  it('does not collapse candidates that have no infoHash', () => {
    const a = candidate({ guid: 'a', infoHash: undefined });
    const b = candidate({ guid: 'b', infoHash: undefined });
    const res = dedupByInfoHash([a, b]);
    expect(res.kept.map((c) => c.guid)).toEqual(['a', 'b']);
    expect(res.dropped).toHaveLength(0);
  });
});

describe('capCandidates', () => {
  it('keeps the top N by seeders when no season mode is given', () => {
    const cands = [
      candidate({ guid: 'low', seeders: 10 }),
      candidate({ guid: 'high', seeders: 100 }),
      candidate({ guid: 'mid', seeders: 50 }),
    ];
    const res = capCandidates(cands, { max: 2 });
    expect(res.kept.map((c) => c.guid)).toEqual(['high', 'mid']);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toContain('capped');
  });

  it('on a complete season, keeps every pack before filling leftover slots with singles', () => {
    const pack = candidate({ guid: 'pack', fullSeason: true, seeders: 10 });
    const singles = Array.from({ length: 4 }, (_, i) => candidate({ guid: `s${i}`, fullSeason: false, seeders: 100 - i }));
    const res = capCandidates([singles[0]!, pack, ...singles.slice(1)], { max: 3, mode: 'complete' });
    expect(res.kept.map((c) => c.guid)).toEqual(['pack', 's0', 's1']);
    expect(res.dropped.map((d) => d.candidate.guid)).toEqual(['s2', 's3']);
  });

  it('on an airing season, keeps singles before packs, and prefers singles that cover a missing episode', () => {
    const pack = candidate({ guid: 'pack', fullSeason: true, seeders: 200 });
    const missing = candidate({ guid: 'e5', fullSeason: false, seeders: 10, episodeNumbers: [5] });
    const other = candidate({ guid: 'e1', fullSeason: false, seeders: 90, episodeNumbers: [1] });
    const res = capCandidates([pack, other, missing], { max: 2, mode: 'airing', missingEpisodeNumbers: [5] });
    expect(res.kept.map((c) => c.guid)).toEqual(['e5', 'e1']);
    expect(res.dropped.map((d) => d.candidate.guid)).toEqual(['pack']);
  });

  it('treats an empty mappedEpisodeNumbers list as missing and falls through to episodeNumbers', () => {
    const pack = candidate({ guid: 'pack', fullSeason: true, seeders: 200 });
    const mappedEmpty = candidate({
      guid: 'e5',
      fullSeason: false,
      seeders: 10,
      mappedEpisodeNumbers: [],
      episodeNumbers: [5],
    });
    const other = candidate({ guid: 'e1', fullSeason: false, seeders: 90, episodeNumbers: [1] });
    const res = capCandidates([pack, other, mappedEmpty], { max: 2, mode: 'airing', missingEpisodeNumbers: [5] });
    expect(res.kept.map((c) => c.guid)).toEqual(['e5', 'e1']);
  });
});

