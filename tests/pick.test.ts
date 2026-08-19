import { describe, it, expect } from 'vitest';
import { pickRelease, resolveReleaseGroup } from '../src/pipelines/acquire/pick.js';
import { candidate, FakeGenerator, pickResponse } from './helpers.js';

const base = { prefer: ['CHS subs'], avoid: ['CAMRip'], title: 'Frieren', kind: 'series' as const, seasonNumber: 1 };

describe('pickRelease', () => {
  it('renders a numbered candidate list in the prompt and resolves the LLM\'s chosen number back to that candidate\'s real guid', async () => {
    const cands = [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: '[Trash] Frieren S01 CAMRip' })];
    const llm = new FakeGenerator([pickResponse({ decision: 'pick', candidate: 2, releaseGroup: 'Trash', confidence: 'low', reasoning: 'only option' })]);
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
    // The policy prompt (system + both of the caller's freeform preference lists) actually
    // made it into the LLM call, not just the candidate listing.
    expect(llm.calls[0].system.length).toBeGreaterThan(0);
    expect(llm.calls[0].system).toContain('number');
    expect(llm.calls[0].prompt).toContain('Prefer:\n- CHS subs');
    expect(llm.calls[0].prompt).toContain('Avoid:\n- CAMRip');
  });
  it('forwards a hint through to the policy prompt', async () => {
    const llm = new FakeGenerator([pickResponse({ decision: 'pick', candidate: 1, releaseGroup: null, confidence: 'high', reasoning: 'ok' })]);
    await pickRelease({
      llm,
      candidates: [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: 'other' })],
      ...base,
      hint: 'prefer the 10bit encode',
    });
    expect(llm.calls[0]!.prompt).toContain('prefer the 10bit encode');
  });

  it('passes through a none decision when the host has not claimed a season shape', async () => {
    const llm = new FakeGenerator([pickResponse({ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'nothing matches CHS requirement' })]);
    const res = await pickRelease({ llm, candidates: [candidate({}), candidate({ guid: 'g2', title: 'other' })], ...base });
    expect(res.decision).toBe('none');
  });
  it.each([
    { name: 'a number past the end of the list', candidateNumber: 5 },
    { name: 'zero', candidateNumber: 0 },
    { name: 'a negative number', candidateNumber: -1 },
  ])('rejects a hallucinated candidate number ($name) naming the number in the error', async ({ candidateNumber }) => {
    const llm = new FakeGenerator([pickResponse({ decision: 'pick', candidate: candidateNumber, releaseGroup: null, confidence: 'high', reasoning: '?' })]);
    await expect(
      pickRelease({
        llm,
        candidates: [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: 'other' })],
        ...base,
      }),
    ).rejects.toThrow(String(candidateNumber));
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
    const llm = new FakeGenerator([pickResponse({ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'n/a' })]);
    await pickRelease({
      llm,
      candidates: [candidate({ seeders }), candidate({ guid: 'g2', title: 'other' })],
      ...base,
    });
    expect(llm.calls[0].prompt).toContain(expected);
  });

  it('treats a none decision that still names a candidate as a pick (the model found one, then waffled)', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'none', candidate: 1, releaseGroup: 'Trix', confidence: 'high', reasoning: 'best remaining is Trix' }),
    ]);
    const res = await pickRelease({
      llm,
      candidates: [candidate({ guid: 'g-trix' }), candidate({ guid: 'g2', title: 'other' })],
      ...base,
    });
    expect(res).toMatchObject({ decision: 'pick', guid: 'g-trix', releaseGroup: 'Trix' });
  });

  it('renders Sonarr shape, quality, group and languages on the candidate line so the model does not have to parse the title', async () => {
    const llm = new FakeGenerator([pickResponse({ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'n/a' })]);
    await pickRelease({
      llm,
      candidates: [
        candidate({
          title: '[Trix] The Ramparts of Ice S01 (Batch)',
          fullSeason: true,
          releaseGroup: 'Trix',
          quality: { quality: { name: 'WEBDL-1080p' } },
          languages: [{ id: 8, name: 'Japanese' }],
        }),
        candidate({ guid: 'g2', title: 'other' }),
      ],
      ...base,
    });
    const line = llm.calls[0]!.prompt;
    expect(line).toContain('#1 pack');
    expect(line).toContain('WEBDL-1080p');
    expect(line).toContain('Trix');
    expect(line).toContain('Japanese');
  });

  it('forwards season mode into the policy prompt', async () => {
    const llm = new FakeGenerator([pickResponse({ decision: 'pick', candidate: 1, releaseGroup: null, confidence: 'high', reasoning: 'ok' })]);
    await pickRelease({
      llm,
      candidates: [candidate({ guid: 'g1' }), candidate({ guid: 'g2', title: 'other' })],
      ...base,
      mode: 'complete',
    });
    expect(llm.calls[0]!.prompt).toContain('Season status: complete');
  });

  it('calls the LLM even when the eligible pool has exactly one candidate', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'pick', candidate: 1, releaseGroup: 'Trix', confidence: 'high', reasoning: 'only option, looks clean' }),
    ]);
    const pack = candidate({ guid: 'g-pack', fullSeason: true, releaseGroup: 'Trix', title: '[Trix] S01 Batch' });
    const res = await pickRelease({ llm, candidates: [pack], ...base, mode: 'complete' });
    expect(llm.calls).toHaveLength(1);
    expect(res).toMatchObject({ decision: 'pick', guid: 'g-pack' });
  });

  it('passes a shape-owned none through instead of overriding it', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'none', candidate: null, releaseGroup: null, confidence: null, reasoning: 'wrong cut' }),
    ]);
    const pack = candidate({ guid: 'g-a', fullSeason: true, releaseGroup: 'Trix' });
    const pack2 = candidate({ guid: 'g-b', fullSeason: true, releaseGroup: 'Other' });
    const res = await pickRelease({ llm, candidates: [pack, pack2], ...base, mode: 'complete' });
    expect(res).toEqual({ decision: 'none', reasoning: 'wrong cut' });
  });

  it('on a complete season, asks the LLM only among the packs', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'pick', candidate: 1, releaseGroup: 'Trix', confidence: 'high', reasoning: 'best pack' }),
    ]);
    const a = candidate({ guid: 'g-a', fullSeason: true, releaseGroup: 'Trix', seeders: 130 });
    const b = candidate({ guid: 'g-b', fullSeason: true, releaseGroup: 'Other', seeders: 40 });
    const single = candidate({ guid: 'g-ep', fullSeason: false, seeders: 3000, title: 'S01E12' });
    const res = await pickRelease({ llm, candidates: [a, b, single], ...base, mode: 'complete' });
    expect(res).toMatchObject({ decision: 'pick', guid: 'g-a' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.prompt).toContain('#1 pack');
    expect(llm.calls[0]!.prompt).toContain('#2 pack');
    expect(llm.calls[0]!.prompt).not.toContain('S01E12');
    expect(llm.calls[0]!.prompt).not.toContain('#3');
  });

  it('on an airing season, asks the LLM only among the singles', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'pick', candidate: 1, releaseGroup: 'SubsPlease', confidence: 'high', reasoning: 'newest missing episode' }),
    ]);
    const pack = candidate({ guid: 'g-pack', fullSeason: true, releaseGroup: 'Trix', title: '[Trix] S01 Batch' });
    const single = candidate({ guid: 'g-ep', fullSeason: false, releaseGroup: 'SubsPlease', title: 'S01E03' });
    const res = await pickRelease({ llm, candidates: [pack, single], ...base, mode: 'airing' });
    expect(res).toMatchObject({ decision: 'pick', guid: 'g-ep' });
    expect(llm.calls[0]!.prompt).toContain('S01E03');
    expect(llm.calls[0]!.prompt).not.toContain('S01 Batch');
  });

  it('falls back to singles on a complete season when no pack survived', async () => {
    const llm = new FakeGenerator([
      pickResponse({ decision: 'pick', candidate: 1, releaseGroup: 'DKB', confidence: 'high', reasoning: 'no pack exists' }),
    ]);
    const single = candidate({ guid: 'g-ep', fullSeason: false, releaseGroup: 'DKB', title: 'S01E12' });
    const res = await pickRelease({ llm, candidates: [single], ...base, mode: 'complete' });
    expect(res).toMatchObject({ decision: 'pick', guid: 'g-ep' });
    expect(llm.calls[0]!.prompt).toContain('S01E12');
  });
});

describe('resolveReleaseGroup', () => {
  it('prefers the arr\'s own releaseGroup field', () => {
    expect(resolveReleaseGroup(candidate({ releaseGroup: 'Trix', title: '[Other] S01 Batch' }))).toBe('Trix');
  });

  it('extracts a bracketed group from the title when Sonarr omitted releaseGroup', () => {
    expect(resolveReleaseGroup(candidate({ releaseGroup: undefined, title: '[Trix] The Ramparts of Ice S01 (Batch)' }))).toBe('Trix');
  });

  it('is null when neither the field nor a bracketed prefix names a group', () => {
    expect(resolveReleaseGroup(candidate({ releaseGroup: undefined, title: 'The Ramparts of Ice S01E01' }))).toBeNull();
  });
});
