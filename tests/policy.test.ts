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

  it('frames Prefer as a rank boost, never an exclusive filter', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system).toContain('Prefer entries are rank boosts, never exclusive filters');
    expect(system).toContain('Do not declare none viable just because a preferred group or keyword is absent');
  });

  it('frames Avoid as semantic: dual/multi is not an original-language-only dub', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system).toContain('Avoid entries are strong negative preferences, not absolute bans');
    expect(system).toContain('Dual-audio, multi-audio, Dual, and Multi include the original language');
    expect(system).toContain('Sonarr language tags often list only the original language');
  });

  it('restricts none-viable to an actually unusable list', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system).toContain('Declare none viable only when the list is actually unusable');
    expect(system).toContain('not because a Prefer entry is unmatched');
  });

  it('tells the model a human reviews a none-viable verdict, so the reasoning must name the defect', () => {
    const { system } = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(system).toContain('a human reviews your reasoning and can override it');
    expect(system).toContain('name the concrete defect that disqualifies the candidates');
  });

  it('states a complete-season pack-first rule in the user prompt', () => {
    const { user } = synthesizePolicyPrompt({
      prefer: [],
      avoid: [],
      title: 'The Ramparts of Ice',
      kind: 'series',
      seasonNumber: 1,
      mode: 'complete',
    });
    expect(user).toContain('Season status: complete');
    expect(user).toContain('Prefer a season pack');
    expect(user).toContain('single-episode release is a fallback');
  });

  it('states an airing-season single-first rule in the user prompt', () => {
    const { user } = synthesizePolicyPrompt({
      prefer: [],
      avoid: [],
      title: 'X',
      kind: 'series',
      seasonNumber: 1,
      mode: 'airing',
    });
    expect(user).toContain('Season status: airing');
    expect(user).toContain('single-episode release');
  });

  it('omits season status for a movie or an unknown season', () => {
    const movie = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'movie' });
    expect(movie.user).not.toContain('Season status');
    const unknown = synthesizePolicyPrompt({ prefer: [], avoid: [], title: 'X', kind: 'series', seasonNumber: 1, mode: 'unknown' });
    expect(unknown.user).not.toContain('Season status');
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
        'Pick exactly ONE release from the numbered candidate list the user provides.',
        'Prefer entries are rank boosts, never exclusive filters: if nothing matches the Prefer list, pick the best remaining candidate. Do not declare none viable just because a preferred group or keyword is absent.',
        'Avoid entries are strong negative preferences, not absolute bans: pick an avoided release only when every alternative is worse overall.',
        'Dual-audio, multi-audio, Dual, and Multi include the original language and are not original-language-only dubs; do not treat them as an English-dub-only release.',
        'Sonarr language tags often list only the original language even on dual/multi releases. Do not treat a single-language tag as proof the release is not dual.',
        'Declare none viable only when the list is actually unusable (wrong title, CAM, or nothing acceptable remains), not because a Prefer entry is unmatched.',
        'If you declare none viable, a human reviews your reasoning and can override it, so name the concrete defect that disqualifies the candidates.',
        'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
        'Answer with the candidate\'s number (the # prefix on its line in the list, e.g. 2 for "#2 [...]") — not its title or any other identifier.',
        'When you pick, also extract the release group — the fansub/release group name in the picked title, usually bracketed at the start or end — into releaseGroup; use null only if no group is identifiable.',
        'Respond with JSON matching the schema provided — no prose outside the JSON.',
      ].join(' '),
    );
    expect(user).toBe('Target: Sousou no Frieren, Season 1\n\nPrefer:\n- CHS subs\n\nAvoid:\n- HEVC re-encodes');
    expect(user).not.toContain('Operator hint');
  });
});
