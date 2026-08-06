import { describe, it, expect } from 'vitest';
import { pickRelease } from '../src/pipelines/acquire/pick.js';
import { candidate, FakeGenerator } from './helpers.js';

const base = { tags: ['prefer CHS'], title: 'Frieren', kind: 'series' as const, seasonNumber: 1 };

describe('pickRelease', () => {
  it('returns the pick and passed the numbered candidates to the llm', async () => {
    const cands = [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: '[Trash] Frieren S01 CAMRip' })];
    const llm = new FakeGenerator([{ decision: 'pick', guid: 'g2', releaseGroup: 'Trash', confidence: 'low', reasoning: 'only option' }]);
    const res = await pickRelease({ llm, candidates: cands, ...base });
    expect(res).toMatchObject({ decision: 'pick', guid: 'g2' });
    expect(llm.calls[0].callsite).toBe('release-pick');
    expect(llm.calls[0].prompt).toContain('#2');
    expect(llm.calls[0].prompt).toContain('CAMRip');
  });
  it('passes through a none decision', async () => {
    const llm = new FakeGenerator([{ decision: 'none', reasoning: 'nothing matches CHS requirement' }]);
    const res = await pickRelease({ llm, candidates: [candidate({})], ...base });
    expect(res.decision).toBe('none');
  });
  it('rejects hallucinated guids', async () => {
    const llm = new FakeGenerator([{ decision: 'pick', guid: 'not-real', releaseGroup: null, confidence: 'high', reasoning: '?' }]);
    await expect(pickRelease({ llm, candidates: [candidate({ guid: 'g1' })], ...base })).rejects.toThrow(/guid/i);
  });
});
