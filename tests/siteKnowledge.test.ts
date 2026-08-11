import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentCharCount,
  emptyKnowledge,
  knowledgeForPrompt,
  knowledgePath,
  loadKnowledge,
  parseKnowledge,
  pruneStale,
  renderKnowledge,
  saveKnowledge,
  type SiteKnowledge,
} from '../src/agent/siteKnowledge.js';
import { ensureDataSubdir } from '../src/fs/paths.js';
import { SITE_KNOWLEDGE_SAMPLE as SAMPLE, tmpDir } from './helpers.js';

describe('parse and render', () => {
  it('round-trips a file without changing it', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    expect(renderKnowledge(k)).toBe(SAMPLE);
  });

  it('reads bullets per section and keeps operator notes verbatim', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    expect(k.updated).toBe('2026-08-10');
    expect(k.sections.Access).toHaveLength(1);
    expect(k.sections.Search[0]).toContain('GET /search/{query}');
    expect(k.sections.Download).toEqual([]);
    expect(k.operatorNotes).toBe('Never use this site for anime.');
  });

  it('treats an unparseable file as empty rather than throwing', () => {
    const k = parseKnowledge('https://x.test', 'not a knowledge file at all');
    expect(k.sections.Access).toEqual([]);
    expect(k.operatorNotes).toBe('');
  });
});

describe('parse: adversarial input', () => {
  it('parses a file with no frontmatter at all', () => {
    const text = `# subhd.tv

## Access
- IF a THEN b. (confirmed 2026-08-01)

## Search

## Download

## Pitfalls

## Operator notes
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.updated).toBeNull();
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(k.operatorNotes).toBe('');
  });

  it('parses a CRLF file the same as its LF equivalent, losing no bullets', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const k = parseKnowledge('https://subhd.tv', crlf);
    expect(k).toEqual(parseKnowledge('https://subhd.tv', SAMPLE));
  });

  it('recovers from an unterminated frontmatter fence instead of swallowing the whole file', () => {
    const text = `---
site: https://subhd.tv
updated: 2026-08-10

## Access
- IF a THEN b. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
  });

  it('ignores a heading or bullet-looking line inside a fenced code block', () => {
    const text = `## Access
- real bullet. (confirmed 2026-01-01)

\`\`\`
## Not A Real Heading
- not a real bullet either
\`\`\`

## Search
- search bullet. (confirmed 2026-01-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['real bullet. (confirmed 2026-01-01)']);
    expect(k.sections.Search).toEqual(['search bullet. (confirmed 2026-01-01)']);
  });

  it('ignores a bullet that appears before any heading', () => {
    const text = `- orphan bullet, no section yet

## Access
- real bullet. (confirmed 2026-01-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['real bullet. (confirmed 2026-01-01)']);
  });

  it('merges bullets under a duplicated heading instead of dropping the first block', () => {
    const text = `## Access
- one. (confirmed 2026-01-01)

## Access
- two. (confirmed 2026-01-02)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['one. (confirmed 2026-01-01)', 'two. (confirmed 2026-01-02)']);
  });

  it('does not recognize an indented line as a bullet', () => {
    const text = `## Access
  - indented, not a real bullet
- real bullet. (confirmed 2026-01-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['real bullet. (confirmed 2026-01-01)']);
  });

  it('keeps a "##" line inside operator notes intact instead of truncating there', () => {
    const text = `## Operator notes
Some intro text.
## Mirrors
- mirror1.example
- mirror2.example
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.operatorNotes).toBe('Some intro text.\n## Mirrors\n- mirror1.example\n- mirror2.example');
  });

  it('never lets a heading after Operator notes hand control back to an agent section', () => {
    const text = `## Operator notes
Never touch this.
## Search
- this looks like a bullet but is still inside operator notes
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Search).toEqual([]);
    expect(k.operatorNotes).toContain('## Search');
    expect(k.operatorNotes).toContain('this looks like a bullet');
  });
});

describe('round-trip fidelity', () => {
  it('round-trips multiple bullets per section', () => {
    const k: SiteKnowledge = {
      baseUrl: 'https://x.test',
      updated: '2026-08-10',
      sections: {
        Access: ['first access rule. (confirmed 2026-08-01)', 'second access rule. (confirmed 2026-08-05)'],
        Search: ['a search rule. (confirmed 2026-08-01)'],
        Download: [],
        Pitfalls: ['a pitfall. (confirmed 2026-08-01)', 'another pitfall.'],
      },
      operatorNotes: 'Multiple\nlines of notes.',
    };
    expect(parseKnowledge('https://x.test', renderKnowledge(k))).toEqual(k);
  });

  it('round-trips a null updated date', () => {
    const k = emptyKnowledge('https://x.test');
    expect(parseKnowledge('https://x.test', renderKnowledge(k))).toEqual(k);
  });

  it('round-trips CJK content in bullets and operator notes', () => {
    const k: SiteKnowledge = {
      baseUrl: 'https://subhd.tv',
      updated: '2026-08-10',
      sections: {
        Access: ['如果搜索页返回 Cloudflare 拦截页 THEN 升级到 chromium. (confirmed 2026-08-10)'],
        Search: [],
        Download: [],
        Pitfalls: [],
      },
      operatorNotes: '不要用于动画字幕。',
    };
    expect(parseKnowledge('https://subhd.tv', renderKnowledge(k))).toEqual(k);
  });
});

describe('prompt rendering', () => {
  it('omits an empty operator section entirely', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Search.push('IF searching THEN use /s. (confirmed 2026-08-10)');
    const prompt = knowledgeForPrompt(k);
    expect(prompt).toContain('IF searching THEN use /s.');
    expect(prompt).not.toContain('Operator notes');
  });

  it('marks operator notes authoritative when present', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    const prompt = knowledgeForPrompt(k);
    expect(prompt).toContain('Never use this site for anime.');
    expect(prompt.toLowerCase()).toContain('authoritative');
    expect(prompt.indexOf('Never use this site')).toBeLessThan(prompt.indexOf('IF the search page'));
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(knowledgeForPrompt(emptyKnowledge('https://x.test'))).toBe('');
  });
});

describe('agentCharCount', () => {
  it('is zero when no agent section has any bullets, even with operator notes present', () => {
    const k = emptyKnowledge('https://x.test');
    k.operatorNotes = 'x'.repeat(500);
    expect(agentCharCount(k)).toBe(0);
  });

  it('counts only the agent-owned sections, excluding operator notes', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Access.push('IF a THEN b. (confirmed 2026-08-01)');
    k.sections.Search.push('IF c THEN d. (confirmed 2026-08-01)');
    k.operatorNotes = 'x'.repeat(500);
    const expected = '## Access\n- IF a THEN b. (confirmed 2026-08-01)\n\n## Search\n- IF c THEN d. (confirmed 2026-08-01)';
    expect(agentCharCount(k)).toBe(expected.length);
  });
});

describe('load and save', () => {
  it('falls back to the seed when no local file exists, then owns the local copy', () => {
    const dataDir = tmpDir();
    const seedsDir = ensureDataSubdir(tmpDir(), 'sites');
    writeFileSync(join(seedsDir, 'subhd.tv.md'), SAMPLE, 'utf8');

    const loaded = loadKnowledge(dataDir, 'https://subhd.tv', seedsDir);
    expect(loaded.sections.Search).toHaveLength(1);
    expect(readFileSync(knowledgePath(dataDir, 'https://subhd.tv'), 'utf8')).toBe(SAMPLE);
  });

  it('returns empty knowledge when neither a local file nor a seed exists', () => {
    const k = loadKnowledge(tmpDir(), 'https://nowhere.test', undefined);
    expect(k.sections.Access).toEqual([]);
  });

  it('keeps the previous version as .bak on overwrite', () => {
    const dataDir = tmpDir();
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, k);
    k.sections.Pitfalls.push('IF x THEN y. (confirmed 2026-08-10)');
    saveKnowledge(dataDir, k);

    const path = knowledgePath(dataDir, 'https://subhd.tv');
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(SAMPLE);
    expect(readFileSync(path, 'utf8')).toContain('IF x THEN y.');
  });
});

describe('decay', () => {
  const stale = 'IF a THEN b. (confirmed 2026-01-01)';
  const fresh = 'IF c THEN d. (confirmed 2026-08-01)';

  it.each([
    {
      name: 'drops a stale bullet once the site has succeeded since',
      bullets: [stale, fresh],
      today: '2026-08-10',
      hadSuccessSince: true,
      expected: [fresh],
    },
    {
      name: 'keeps a stale bullet when there has been no success to judge it by',
      bullets: [stale],
      today: '2026-08-10',
      hadSuccessSince: false,
      expected: [stale],
    },
    {
      name: 'keeps a bullet whose confirmed stamp is calendar-invalid rather than treating it as always-stale',
      bullets: ['IF a THEN b. (confirmed 2026-13-45)'],
      today: '2026-08-10',
      hadSuccessSince: true,
      expected: ['IF a THEN b. (confirmed 2026-13-45)'],
    },
    {
      name: 'keeps every bullet when today itself fails to parse, rather than dropping everything',
      bullets: [stale, fresh],
      today: 'not-a-date',
      hadSuccessSince: true,
      expected: [stale, fresh],
    },
    {
      name: 'treats a full ISO timestamp for today the same as its date-only portion',
      bullets: [stale, fresh],
      today: '2026-08-10T23:59:59.999Z',
      hadSuccessSince: true,
      expected: [fresh],
    },
  ])('$name', ({ bullets, today, hadSuccessSince, expected }) => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Access.push(...bullets);
    expect(pruneStale(k, today, hadSuccessSince).sections.Access).toEqual(expected);
  });

  it('never prunes operator notes', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    expect(pruneStale(k, '2030-01-01', true).operatorNotes).toBe('Never use this site for anime.');
  });

  it('does not mutate its input', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Access.push(stale, fresh);
    pruneStale(k, '2026-08-10', true);
    expect(k.sections.Access).toEqual([stale, fresh]);
  });
});
