import { describe, it, expect } from 'vitest';
import { pickRelease } from '../src/pipelines/acquire/pick.js';
import { candidate, FakeGenerator } from './helpers.js';

const base = { tags: ['prefer CHS'], title: 'Frieren', kind: 'series' as const, seasonNumber: 1 };

describe('pickRelease', () => {
  it('renders a numbered candidate list in the prompt and resolves the LLM\'s chosen number back to that candidate\'s real guid', async () => {
    const cands = [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: '[Trash] Frieren S01 CAMRip' })];
    const llm = new FakeGenerator([{ decision: 'pick', candidate: 2, releaseGroup: 'Trash', confidence: 'low', reasoning: 'only option' }]);
    const res = await pickRelease({ llm, candidates: cands, ...base });

    // The LLM never saw a guid — only numbered lines — so it answered with a number (2),
    // and pickRelease resolved that back to candidate #2's actual guid.
    expect(res).toMatchObject({ decision: 'pick', guid: 'g2' });
    expect(llm.calls[0].callsite).toBe('release-pick');
    expect(llm.calls[0].prompt).toContain('#1');
    expect(llm.calls[0].prompt).toContain('#2');
    expect(llm.calls[0].prompt).toContain('CAMRip');
    // The prompt never contains a guid for the LLM to (fail to) copy back.
    expect(llm.calls[0].prompt).not.toContain('g1');
    expect(llm.calls[0].prompt).not.toContain('g2');
    // The policy prompt (system + the caller's freeform tags) actually made it into the
    // LLM call, not just the candidate listing.
    expect(llm.calls[0].system.length).toBeGreaterThan(0);
    expect(llm.calls[0].system).toContain('number');
    expect(llm.calls[0].prompt).toContain('CHS');
  });
  it('passes through a none decision', async () => {
    const llm = new FakeGenerator([{ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'nothing matches CHS requirement' }]);
    const res = await pickRelease({ llm, candidates: [candidate({})], ...base });
    expect(res.decision).toBe('none');
  });
  it.each([
    { name: 'a number past the end of the list', candidateNumber: 5 },
    { name: 'zero', candidateNumber: 0 },
    { name: 'a negative number', candidateNumber: -1 },
  ])('rejects a hallucinated candidate number ($name) naming the number in the error', async ({ candidateNumber }) => {
    const llm = new FakeGenerator([{ decision: 'pick', candidate: candidateNumber, releaseGroup: null, confidence: 'high', reasoning: '?' }]);
    await expect(pickRelease({ llm, candidates: [candidate({ guid: 'g1' })], ...base })).rejects.toThrow(String(candidateNumber));
  });
  it('declares none viable without calling the llm when there are no candidates', async () => {
    const llm = new FakeGenerator([]);
    const res = await pickRelease({ llm, candidates: [], ...base });
    expect(res.decision).toBe('none');
    expect(llm.calls).toHaveLength(0);
  });
  it.each([
    { name: 'a numeric seeders count', seeders: 25, expected: '25 seeders' },
    { name: 'null (indexer silent)', seeders: null, expected: '? seeders' },
    { name: 'undefined (usenet release)', seeders: undefined as unknown as null, expected: '? seeders' },
  ])('renders $name as "$expected" in the candidate line', async ({ seeders, expected }) => {
    const llm = new FakeGenerator([{ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'n/a' }]);
    await pickRelease({ llm, candidates: [candidate({ seeders })], ...base });
    expect(llm.calls[0].prompt).toContain(expected);
  });
});
