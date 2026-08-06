import { describe, it, expect } from 'vitest';
import { synthesizePolicyPrompt } from '../src/pipelines/acquire/policy.js';

describe('synthesizePolicyPrompt', () => {
  it('embeds every freeform tag verbatim', () => {
    const { user } = synthesizePolicyPrompt({
      tags: ['prefer CHS subs', 'dual audio when available', 'avoid HEVC re-encodes of BD remuxes'],
      title: 'Sousou no Frieren',
      kind: 'series',
      seasonNumber: 1,
    });
    for (const t of ['prefer CHS subs', 'dual audio when available', 'avoid HEVC re-encodes of BD remuxes'])
      expect(user).toContain(t);
    expect(user).toContain('Sousou no Frieren');
    expect(user).toContain('Season 1');
  });

  it('states the none-viable escape hatch in the system prompt', () => {
    const { system } = synthesizePolicyPrompt({ tags: [], title: 'X', kind: 'movie' });
    expect(system.toLowerCase()).toContain('none');
  });

  it('handles empty tags without placeholder junk', () => {
    const { user } = synthesizePolicyPrompt({ tags: [], title: 'X', kind: 'movie' });
    expect(user).not.toContain('undefined');
  });
});
