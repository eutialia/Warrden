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

  // A job that fails terminally (a permanent error) never calls clearJob and never reads its
  // entries again, so `set` is the only place left that can reclaim them.
  it('sweeps every expired entry on write, so a job that never cleared itself cannot strand its candidates', () => {
    let t = 0;
    const cache = new SearchCache(1000, () => t);
    cache.set(1, 'movie', [candA]);
    cache.set(1, 's2', [candA]);
    expect(cache.size).toBe(2);

    t = 1001;
    cache.set(2, 'movie', [candA]);

    expect(cache.size).toBe(1);
    expect(cache.get(1, 'movie')).toBeUndefined();
    expect(cache.get(2, 'movie')).toEqual([candA]);
  });

  it('stays bounded by the entries still inside their TTL, however many jobs come and go', () => {
    let t = 0;
    const cache = new SearchCache(1000, () => t);
    for (let jobId = 1; jobId <= 50; jobId++) {
      cache.set(jobId, 'movie', [candA]);
      t += 1001;
    }
    expect(cache.size).toBe(1);
  });

  it('keeps entries a live job is still inside the TTL for when another job writes', () => {
    let t = 0;
    const cache = new SearchCache(1000, () => t);
    cache.set(1, 'movie', [candA]);
    t = 500;
    cache.set(2, 'movie', [candA]);
    expect(cache.size).toBe(2);
    expect(cache.get(1, 'movie')).toEqual([candA]);
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
