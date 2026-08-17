import { describe, it, expect } from 'vitest';
import { synthesizePolicyPrompt } from '../src/pipelines/acquire/policy.js';

describe('synthesizePolicyPrompt', () => {
  it('embeds every freeform preference verbatim, under its own Prefer/Avoid header', () => {
    const { user } = synthesizePolicyPrompt({
      prefer: ['CHS subs', 'dual audio when available'],
      avoid: ['HEVC re-encodes of BD remuxes'],
      title: 'Sousou no Frieren',
      kind: 'series',
      seasonNumber: 1,
    });
    for (const t of ['CHS subs', 'dual audio when available', 'HEVC re-encodes of BD remuxes']) expect(user).toContain(t);
    expect(user).toContain('Sousou no Frieren');
    expect(user).toContain('Season 1');
  });

  it('renders both sections separated by a blank line, each a header plus one bullet per entry', () => {
    const { user } = synthesizePolicyPrompt({
      prefer: ['CHS subs', '1080p'],
      avoid: ['HEVC re-encodes'],
      title: 'X',
      kind: 'movie',
    });
    expect(user).toBe('Target: X\n\nPrefer:\n- CHS subs\n- 1080p\n\nAvoid:\n- HEVC re-encodes');
  });

  it.each([
    {
      scenario: 'only prefer is filled',
      prefer: ['CHS subs'],
      avoid: [],
      expected: 'Target: X\n\nPrefer:\n- CHS subs',
    },
    {
      scenario: 'only avoid is filled',
      prefer: [],
      avoid: ['HEVC re-encodes'],
      expected: 'Target: X\n\nAvoid:\n- HEVC re-encodes',
    },
  ])('renders only the non-empty section when $scenario', ({ prefer, avoid, expected }) => {
    const { user } = synthesizePolicyPrompt({ prefer, avoid, title: 'X', kind: 'movie' });
    expect(user).toBe(expected);
  });

  it('states the none-viable escape hatch in the system prompt', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system.toLowerCase()).toContain('none');
  });

  it('frames Avoid as a strong negative preference rather than an absolute ban', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system).toContain(
      'Avoid entries are strong negative preferences, not absolute bans — pick an avoided release only when every alternative is worse overall, and declare none viable if nothing acceptable remains.',
    );
  });

  it('keeps the single none-specified line when both lists are empty', () => {
    const { user } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(user).toBe('Target: X\n\nPreferences: none specified.');
    expect(user).not.toContain('undefined');
    expect(user).not.toContain('Prefer:');
    expect(user).not.toContain('Avoid:');
  });

  it.each([
    { list: 'prefer' as const, entry: 'CHS\nsubs over dubs', expected: '- CHS subs over dubs' },
    { list: 'avoid' as const, entry: 'HEVC\nre-encodes', expected: '- HEVC re-encodes' },
  ])('normalizes an internal newline in a $list entry to a single space, so one entry stays one bullet', ({ list, entry, expected }) => {
    const { user } = synthesizePolicyPrompt({ prefer: [], avoid: [], [list]: [entry], title: 'X', kind: 'movie' });
    expect(user).toContain(expected);
    expect(user.split('\n').filter((line) => line.startsWith('-'))).toHaveLength(1);
  });

  it('appends an operator-hint section, weighing it heavily, when a hint is given', () => {
    const { user } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie', hint: 'prefer the 10bit encode this time' });
    expect(user).toContain('Operator hint (from a human reviewing a previous attempt — weigh it heavily):\nprefer the 10bit encode this time');
  });

  it('normalizes an internal newline in the hint to a single space, same as a preference entry', () => {
    const { user } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie', hint: 'avoid CAMRip\nprefer BD' });
    expect(user).toContain('Operator hint (from a human reviewing a previous attempt — weigh it heavily):\navoid CAMRip prefer BD');
  });

  it('produces the exact prompt bytes when no hint is given (regression)', () => {
    const input = { prefer: ['CHS subs'], avoid: ['HEVC re-encodes'], title: 'Sousou no Frieren', kind: 'series' as const, seasonNumber: 1 };
    const { system, user } = synthesizePolicyPrompt(input);
    expect(system).toBe(
      [
        'You are selecting a single release to download for a media library.',
        "Pick exactly ONE release from the numbered candidate list the user provides, honoring the user's freeform preferences verbatim: favor releases matching the Prefer list and steer away from releases matching the Avoid list.",
        'If no candidate is viable given those preferences, declare none viable instead of forcing a pick.',
        'Avoid entries are strong negative preferences, not absolute bans — pick an avoided release only when every alternative is worse overall, and declare none viable if nothing acceptable remains.',
        'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
        "Answer with the candidate's number (the # prefix on its line in the list, e.g. 2 for \"#2 [...]\") — not its title or any other identifier.",
        'When you pick, also extract the release group — the fansub/release group name in the picked title, usually bracketed at the start or end — into releaseGroup; use null only if no group is identifiable.',
        'Respond with JSON matching the schema provided — no prose outside the JSON.',
      ].join(' '),
    );
    expect(user).toBe('Target: Sousou no Frieren, Season 1\n\nPrefer:\n- CHS subs\n\nAvoid:\n- HEVC re-encodes');
    expect(user).not.toContain('Operator hint');
  });
});
