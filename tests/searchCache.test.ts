import { describe, expect, it } from 'vitest';
import { SearchCache } from '../src/pipelines/acquire/searchCache.js';
import { candidate } from './helpers.js';

const candA = candidate({ guid: 'a' });

describe('SearchCache', () => {
  it('returns cached results within TTL and keyed per job and target', () => {
    let t = 0;
    const cache = new SearchCache(1000, () => t);
    cache.set(1, 's1', [candA]);
    expect(cache.get(1, 's1')).toEqual([candA]);
    expect(cache.get(1, 's2')).toBeUndefined();
    expect(cache.get(2, 's1')).toBeUndefined();
    t = 1001;
    expect(cache.get(1, 's1')).toBeUndefined();
  });

  it('clearJob drops every entry for that job only', () => {
    const cache = new SearchCache();
    cache.set(1, 's1', [candA]);
    cache.set(1, 's2', [candA]);
    cache.set(2, 's1', [candA]);
    cache.clearJob(1);
    expect(cache.get(1, 's1')).toBeUndefined();
    expect(cache.get(1, 's2')).toBeUndefined();
    expect(cache.get(2, 's1')).toEqual([candA]);
  });

  // Job ids are numbers joined into a string key, so a naive prefix match would let job #1
  // clear job #11's entries too.
  it('clearJob does not touch a job whose id merely starts with the cleared one', () => {
    const cache = new SearchCache();
    cache.set(1, 's1', [candA]);
    cache.set(11, 's1', [candA]);
    cache.clearJob(1);
    expect(cache.get(11, 's1')).toEqual([candA]);
  });
});
