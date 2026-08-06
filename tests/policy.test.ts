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

  it('normalizes an internal newline in a tag to a single space, so one tag stays one bullet', () => {
    const { user } = synthesizePolicyPrompt({ tags: ['prefer CHS\nsubs over dubs'], title: 'X', kind: 'movie' });
    expect(user).toContain('- prefer CHS subs over dubs');
    expect(user.split('\n').filter((line) => line.startsWith('-'))).toHaveLength(1);
  });

  it('appends an operator-hint section, weighing it heavily, when a hint is given', () => {
    const { user } = synthesizePolicyPrompt({ tags: [], title: 'X', kind: 'movie', hint: 'prefer the 10bit encode this time' });
    expect(user).toContain('Operator hint (from a human reviewing a previous attempt — weigh it heavily):\nprefer the 10bit encode this time');
  });

  it('normalizes an internal newline in the hint to a single space, same as a tag', () => {
    const { user } = synthesizePolicyPrompt({ tags: [], title: 'X', kind: 'movie', hint: 'avoid CAMRip\nprefer BD' });
    expect(user).toContain('Operator hint (from a human reviewing a previous attempt — weigh it heavily):\navoid CAMRip prefer BD');
  });

  it('produces a byte-identical prompt to before when no hint is given (regression)', () => {
    const input = { tags: ['prefer CHS subs'], title: 'Sousou no Frieren', kind: 'series' as const, seasonNumber: 1 };
    const { system, user } = synthesizePolicyPrompt(input);
    expect(system).toBe(
      [
        'You are selecting a single release to download for a media library.',
        "Pick exactly ONE release from the numbered candidate list the user provides, honoring the user's freeform preferences verbatim.",
        'If no candidate is viable given those preferences, declare none viable instead of forcing a pick.',
        'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
        "Answer with the candidate's number (the # prefix on its line in the list, e.g. 2 for \"#2 [...]\") — not its title or any other identifier.",
        'When you pick, also extract the release group — the fansub/release group name in the picked title, usually bracketed at the start or end — into releaseGroup; use null only if no group is identifiable.',
        'Respond with JSON matching the schema provided — no prose outside the JSON.',
      ].join(' '),
    );
    expect(user).toBe('Target: Sousou no Frieren, Season 1\n\nPreferences:\n- prefer CHS subs');
    expect(user).not.toContain('Operator hint');
  });
});
