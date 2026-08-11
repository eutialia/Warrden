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

  it('bounds the frontmatter close scan at the first heading instead of at any later "---"', () => {
    const text = `---
site: https://subhd.tv
updated: 2026-08-10
--

# subhd.tv

## Access
- IF a THEN b. (confirmed 2026-08-01)

---

## Search
- IF c THEN d. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(k.sections.Search).toEqual(['IF c THEN d. (confirmed 2026-08-01)']);
  });

  it('ignores a real section heading and its bullets when they sit inside a fenced code block', () => {
    const text = `## Pitfalls
- a real pitfall. (confirmed 2026-01-01)

\`\`\`markdown
## Access
- an example rule copied from the docs
\`\`\`

## Search
- a real search rule. (confirmed 2026-01-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual([]);
    expect(k.sections.Pitfalls).toEqual(['a real pitfall. (confirmed 2026-01-01)']);
    expect(k.sections.Search).toEqual(['a real search rule. (confirmed 2026-01-01)']);
  });

  it('does not let a fence left open above the operator section blank it out', () => {
    const text = `---
site: https://subhd.tv
updated: 2026-08-10
---

# subhd.tv

## Access
- IF a THEN b. (confirmed 2026-08-01)

\`\`\`
an example snippet whose closing fence was never typed

## Search

## Download

## Pitfalls

## Operator notes
Never use this site for anime.
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.operatorNotes).toBe('Never use this site for anime.');
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(renderKnowledge(k)).toContain('Never use this site for anime.');
  });

  it('does not blank operator notes on save when a fence above them was left open', () => {
    const dataDir = tmpDir();
    const text = `# subhd.tv

## Access
\`\`\`
unterminated

## Operator notes
Never use this site for anime.
`;
    saveKnowledge(dataDir, parseKnowledge('https://subhd.tv', text));
    const saved = readFileSync(knowledgePath(dataDir, 'https://subhd.tv'), 'utf8');
    expect(saved).toContain('Never use this site for anime.');
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

  it('ignores an indented line that has no bullet above it to continue', () => {
    const text = `## Access
  - indented, with no bullet above it
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

  it('ends operator notes at a real agent heading instead of adopting the rest of the file', () => {
    const text = `# subhd.tv

## Operator notes
Never use this site for anime.

## Access
- IF a THEN b. (confirmed 2026-08-01)

## Search
- IF c THEN d. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.operatorNotes).toBe('Never use this site for anime.');
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(k.sections.Search).toEqual(['IF c THEN d. (confirmed 2026-08-01)']);
  });

  it('keeps a fenced agent heading inside operator notes rather than ending them there', () => {
    const text = `## Operator notes
The skeleton looks like this:

\`\`\`markdown
## Access
- example rule
\`\`\`
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual([]);
    expect(k.operatorNotes).toContain('## Access');
    expect(k.operatorNotes).toContain('example rule');
  });
});

describe('parse: wrapped bullets', () => {
  const wrapped = `## Access
- IF the search page returns a Cloudflare interstitial THEN escalate to the
  chromium tier before retrying. (confirmed 2026-08-10)

## Search
- IF searching THEN GET /search/{query}. (confirmed 2026-08-01)
`;
  const joined = 'IF the search page returns a Cloudflare interstitial THEN escalate to the chromium tier before retrying. (confirmed 2026-08-10)';

  it('joins a bullet wrapped across lines, keeping its confirmed stamp', () => {
    const k = parseKnowledge('https://subhd.tv', wrapped);
    expect(k.sections.Access).toEqual([joined]);
    expect(k.sections.Search).toEqual(['IF searching THEN GET /search/{query}. (confirmed 2026-08-01)']);
  });

  it('re-emits a joined bullet on one line and is byte-stable from then on', () => {
    const once = renderKnowledge(parseKnowledge('https://subhd.tv', wrapped));
    expect(once).toContain(`- ${joined}\n`);
    expect(renderKnowledge(parseKnowledge('https://subhd.tv', once))).toBe(once);
  });

  it('ends a wrapped bullet at a blank line, a new bullet, or a heading', () => {
    const text = `## Access
- first rule
  wrapped tail. (confirmed 2026-08-01)
- second rule. (confirmed 2026-08-02)

stray prose after a blank line

## Pitfalls
- a pitfall
  that also wraps. (confirmed 2026-08-03)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['first rule wrapped tail. (confirmed 2026-08-01)', 'second rule. (confirmed 2026-08-02)']);
    expect(k.sections.Pitfalls).toEqual(['a pitfall that also wraps. (confirmed 2026-08-03)']);
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
      // 2026-05-12 is exactly STALE_AFTER_DAYS before 2026-08-10, so it survives — but
      // only if today's clock time is discarded. Comparing against the raw timestamp puts
      // the cutoff at 23:59:59 that day and drops the bullet by a few hours.
      name: 'reads today as a date, so a full ISO timestamp does not shift the boundary by a day',
      bullets: ['IF a THEN b. (confirmed 2026-05-12)'],
      today: '2026-08-10T23:59:59Z',
      hadSuccessSince: true,
      expected: ['IF a THEN b. (confirmed 2026-05-12)'],
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
