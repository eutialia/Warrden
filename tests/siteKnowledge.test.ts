import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentCharCount,
  defaultSeedsDir,
  emptyKnowledge,
  KNOWLEDGE_CHAR_CAP,
  KnowledgeConflictError,
  knowledgeForPrompt,
  knowledgePath,
  loadKnowledge,
  loadKnowledgeWithVersion,
  parseKnowledge,
  renderKnowledge,
  saveKnowledge,
  type SiteKnowledge,
} from '../src/agent/siteKnowledge.js';
import { scanForThreats } from '../src/agent/threatPatterns.js';
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

  it('reads a CRLF file as its LF equivalent, losing no bullets and keeping the notes\' own endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const lf = parseKnowledge('https://subhd.tv', SAMPLE);
    const k = parseKnowledge('https://subhd.tv', crlf);

    expect(k.updated).toBe(lf.updated);
    expect(k.sections).toEqual(lf.sections);
    // The one difference, and it's the point: the operator's half is copied out as typed,
    // so its CRLF survives where the agent's half is normalized.
    expect(k.operatorNotes).toBe('Never use this site for anime.\r');
    expect(renderKnowledge(k)).toContain('Never use this site for anime.\r\n');
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

  it('keeps a YAML comment in frontmatter from hiding the closing "---" and the updated stamp', () => {
    const text = `---
site: https://subhd.tv
# regenerated by hand on 2026-08-10
updated: 2026-08-10
---

# subhd.tv

## Access
- IF a THEN b. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://subhd.tv', text);
    expect(k.updated).toBe('2026-08-10');
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(renderKnowledge(k)).toContain('updated: 2026-08-10');
  });

  it('ends a bullet at an unclosed fence instead of gluing the fence and its prose on', () => {
    const text = `## Access
- IF a THEN b. (confirmed 2026-08-01)
\`\`\`text
a snippet whose closing fence was never typed
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);

    const rendered = renderKnowledge(k);
    expect(rendered).toContain('- IF a THEN b. (confirmed 2026-08-01)\n');
    expect(rendered).not.toContain('```');
    expect(rendered).not.toContain('never typed');
  });
});

/**
 * The parser reads nothing below `## Operator notes`, so every one of these is a case it
 * used to interpret — and, on the next save, silently rewrite. The assertions are the same
 * three every time: the bytes come out of the parse identical, the agent half above them is
 * unaffected, and the whole file re-renders byte for byte.
 */
describe('operator notes are an opaque slice', () => {
  const AGENT_HALF = `---
site: https://x.test
updated: 2026-08-10
---

# x.test

## Access
- IF a THEN b. (confirmed 2026-08-01)

## Search

## Download

## Pitfalls

`;
  const fileWithNotes = (notes: string): string => `${AGENT_HALF}## Operator notes\n${notes}\n`;

  it.each([
    {
      name: 'a second literal operator heading, documenting the file skeleton',
      notes: 'The file ends with:\n\n## Operator notes\nyour notes here',
    },
    {
      name: 'prose (not bullets) under a reserved heading',
      notes: '## Access\nEverything about access is already in the section above.',
    },
    {
      name: 'an unterminated fenced example holding a heading and a bullet',
      notes: 'The skeleton looks like this:\n\n```markdown\n## Access\n- example rule',
    },
    {
      name: 'every reserved heading at once',
      notes: '## Access\n## Search\n## Download\n## Pitfalls\n- and a bullet under the last one',
    },
    {
      name: 'an unknown heading and its bullets',
      notes: 'Some intro text.\n## Mirrors\n- mirror1.example\n- mirror2.example',
    },
    {
      name: 'CRLF line endings and unicode',
      notes: 'Windows wrote this file.\r\n不要用于动画字幕。\r\n— の operator',
    },
    {
      name: 'a blank line right after the heading',
      notes: '\nNever use this site for anime.',
    },
  ])('keeps $name byte for byte', ({ notes }) => {
    const text = fileWithNotes(notes);
    const k = parseKnowledge('https://x.test', text);

    expect(k.operatorNotes).toBe(notes);
    expect(k.sections).toEqual({
      Access: ['IF a THEN b. (confirmed 2026-08-01)'],
      Search: [],
      Download: [],
      Pitfalls: [],
    });
    expect(renderKnowledge(k)).toBe(text);
  });

  it('survives a save→reload round trip on disk, not just in memory', () => {
    const dataDir = tmpDir();
    const notes = 'The skeleton looks like this:\n\n```markdown\n## Access\n- example rule';
    const text = fileWithNotes(notes);

    saveKnowledge(dataDir, parseKnowledge('https://x.test', text));
    expect(readFileSync(knowledgePath(dataDir, 'https://x.test'), 'utf8')).toBe(text);
    expect(loadKnowledge(dataDir, 'https://x.test').operatorNotes).toBe(notes);
  });

  it('recognizes the heading whatever case it was written in', () => {
    const text = `# x.test

## Operator Notes
Never use this site for anime.
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.operatorNotes).toBe('Never use this site for anime.');
    expect(renderKnowledge(k)).toContain('## Operator notes\nNever use this site for anime.\n');
  });

  // M-01/D-13: a near-miss heading must still be recognized as the operator's, not treated
  // as an unknown agent-half heading whose "body" (the operator's whole half) is then
  // dropped on the next save. A trailing colon and indentation are natural things for a
  // human hand-editing the file with a text editor to type.
  it.each([
    ['a trailing colon', '## Operator notes:'],
    ['indentation', '  ## Operator notes'],
    ['a trailing colon and indentation', '  ## Operator notes:'],
    ['trailing prose after the heading', '## Operator notes (authoritative)'],
  ])('recognizes the heading with %s', (_case, heading) => {
    const text = `# x.test\n\n## Access\n- IF a THEN b. (confirmed 2026-08-01)\n\n${heading}\nNever use this site for anime.\n`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.operatorNotes).toBe('Never use this site for anime.');
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);

    // The round trip through a save is the consequence that matters: a near-miss heading
    // that isn't recognized destroys the operator's entire half on the very next write.
    const dataDir = tmpDir();
    saveKnowledge(dataDir, k);
    const reloaded = loadKnowledge(dataDir, 'https://x.test');
    expect(reloaded.operatorNotes).toBe('Never use this site for anime.');
  });

  it('is empty, and its heading still emitted, for a file with no operator section at all', () => {
    const text = `# x.test

## Access
- IF a THEN b. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.operatorNotes).toBe('');
    expect(k.sections.Access).toEqual(['IF a THEN b. (confirmed 2026-08-01)']);
    expect(renderKnowledge(k)).toContain('## Operator notes\n');
  });

  it('takes an agent section written below the heading as notes, keeping its bytes and moving it last', () => {
    // The documented cost of the split: `## Operator notes` is the last section by
    // construction, so a hand-written file that puts one above it hands that section to the
    // human. Nothing is lost — the bytes come back out below the heading, where they now are.
    const text = `# x.test

## Operator notes
Never use this site for anime.

## Access
- IF a THEN b. (confirmed 2026-08-01)
`;
    const k = parseKnowledge('https://x.test', text);
    expect(k.sections.Access).toEqual([]);
    expect(k.operatorNotes).toBe('Never use this site for anime.\n\n## Access\n- IF a THEN b. (confirmed 2026-08-01)');
    expect(renderKnowledge(k).endsWith(`## Operator notes\n${k.operatorNotes}\n`)).toBe(true);
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

  // M-04: a notes section holding nothing but whitespace counts as empty, not as a stub
  // worth injecting under the "authoritative" header — the exact thing the design says
  // never to show the model.
  it('treats whitespace-only operator notes as empty, not as a stub worth injecting', () => {
    const k = emptyKnowledge('https://x.test');
    k.operatorNotes = '   \n\n  ';
    const prompt = knowledgeForPrompt(k);
    expect(prompt).not.toContain('Operator notes');
    expect(prompt).toBe('');
  });

  it('marks operator notes authoritative when present', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    const prompt = knowledgeForPrompt(k);
    expect(prompt).toContain('Never use this site for anime.');
    expect(prompt.toLowerCase()).toContain('authoritative');
    expect(prompt.indexOf('Never use this site')).toBeLessThan(prompt.indexOf('IF the search page'));
  });

  it('introduces the agent sections instead of dropping a bare heading into the prompt', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Search.push('IF searching THEN use /s. (confirmed 2026-08-10)');
    const prompt = knowledgeForPrompt(k);
    // The block must not open on its own markdown heading: something has to say what these
    // bullets are and that the model should follow them.
    expect(prompt.startsWith('## ')).toBe(false);
    expect(prompt.split('\n')[0]).toMatch(/follow/i);
    expect(prompt.indexOf('## Search')).toBeGreaterThan(0);
  });

  it('has no agent-section framing when only operator notes are present', () => {
    const k = emptyKnowledge('https://x.test');
    k.operatorNotes = 'Mirror is at example.test.';
    const prompt = knowledgeForPrompt(k);
    expect(prompt).toContain('Mirror is at example.test.');
    expect(prompt).not.toMatch(/follow them step by step/i);
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(knowledgeForPrompt(emptyKnowledge('https://x.test'))).toBe('');
  });

  // G1: Pitfalls is the one agent section a failed, possibly attacker-influenced run can
  // still write to (no success gate behind it — see `siteReflection.ts`'s
  // `PROTOCOL_SECTIONS` doc). Framing it under the same "follow them step by step"
  // instruction that Access/Search/Download earn by having proved themselves would hand a
  // durable, scanner-clean steering channel to a protocol-shaped Pitfalls bullet. It must
  // render under its own framing as observations to weigh, not instructions to obey.
  describe('Pitfalls framing', () => {
    it('renders under separate framing from Access/Search/Download, not "follow them step by step"', () => {
      const k = emptyKnowledge('https://x.test');
      k.sections.Search.push('IF searching THEN use /s. (confirmed 2026-08-10)');
      k.sections.Pitfalls.push('IF results are empty THEN retry once. (confirmed 2026-08-10)');
      const prompt = knowledgeForPrompt(k);

      const followLine = prompt.split('\n\n').find((block) => block.includes('follow them step by step'));
      const pitfallsLine = prompt.split('\n\n').find((block) => block.includes('IF results are empty'));
      expect(followLine).toBeDefined();
      expect(pitfallsLine).toBeDefined();
      expect(followLine).not.toBe(pitfallsLine);
      // The Pitfalls block must not itself carry the "follow them step by step" framing.
      expect(pitfallsLine).not.toMatch(/follow them step by step/i);
      expect(followLine).not.toContain('## Pitfalls');
    });

    it('says Pitfalls entries are observations to weigh, not instructions to follow', () => {
      const k = emptyKnowledge('https://x.test');
      k.sections.Pitfalls.push('IF results are empty THEN retry once. (confirmed 2026-08-10)');
      const prompt = knowledgeForPrompt(k);
      expect(prompt).toMatch(/not instructions to follow/i);
    });

    it('still frames Access/Search/Download as "follow them step by step" on their own', () => {
      const k = emptyKnowledge('https://x.test');
      k.sections.Access.push('IF blocked THEN use chromium. (confirmed 2026-08-10)');
      const prompt = knowledgeForPrompt(k);
      expect(prompt).toMatch(/follow them step by step/i);
    });

    it('omits the Pitfalls framing header entirely when there are no Pitfalls bullets', () => {
      const k = emptyKnowledge('https://x.test');
      k.sections.Access.push('IF blocked THEN use chromium. (confirmed 2026-08-10)');
      const prompt = knowledgeForPrompt(k);
      expect(prompt).not.toMatch(/not instructions to follow/i);
    });

    it('does not change the on-disk file shape — render/parse stays byte-exact', () => {
      // This is prompt-assembly framing only. The file format itself
      // (renderKnowledge/parseKnowledge) is untouched: a Pitfalls bullet round-trips
      // through render then parse unchanged, whatever the prompt does with it.
      const k = emptyKnowledge('https://x.test');
      k.sections.Pitfalls.push('IF results are empty THEN retry once. (confirmed 2026-08-10)');
      expect(parseKnowledge('https://x.test', renderKnowledge(k))).toEqual(k);
    });
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

  // M-02: a failed write must not cost a generation of rollback. `.bak` is now copied
  // AFTER the new content is safely on disk at the temp path, so a failure in the write
  // itself (the case here — the temp path is blocked) leaves both the live file and its
  // `.bak` exactly as they were, rather than `.bak` already having been overwritten with
  // the generation that's now failing to land.
  it('does not overwrite .bak when the write itself fails', () => {
    const dataDir = tmpDir();
    const gen1 = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, gen1);
    const gen2 = { ...gen1, sections: { ...gen1.sections, Pitfalls: ['IF x THEN y. (confirmed 2026-08-10)'] } };
    saveKnowledge(dataDir, gen2);

    const path = knowledgePath(dataDir, 'https://subhd.tv');
    const bakBefore = readFileSync(`${path}.bak`, 'utf8');
    expect(bakBefore).toBe(SAMPLE); // gen1

    // Force the write itself to fail: a directory sitting where the .tmp file needs to go.
    mkdirSync(`${path}.tmp`, { recursive: true });
    const gen3 = { ...gen1, sections: { ...gen1.sections, Pitfalls: ['IF a THEN b. (confirmed 2026-08-10)'] } };
    expect(() => saveKnowledge(dataDir, gen3)).toThrow();

    expect(readFileSync(path, 'utf8')).toContain('IF x THEN y.'); // still gen2, unchanged
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(bakBefore); // still gen1, not overwritten
  });

  // G5: seed materialization on first touch goes through the same temp-file-then-rename
  // shape as saveKnowledge, not a direct copy — so a crash mid-copy can't leave a partial
  // file at the local path (which would then read as real, truncated knowledge forever).
  it('materializes the seed via temp-file-then-rename, not a direct copy (G5)', () => {
    const dataDir = tmpDir();
    const seedsDir = ensureDataSubdir(tmpDir(), 'sites');
    writeFileSync(join(seedsDir, 'subhd.tv.md'), SAMPLE, 'utf8');
    const path = knowledgePath(dataDir, 'https://subhd.tv');

    // Force the temp write to fail. A direct copyFileSync(seedPath, path) would be
    // unaffected by this and would still succeed — this only fails if materialization
    // goes through `<path>.tmp` first.
    mkdirSync(`${path}.tmp`, { recursive: true });
    expect(() => loadKnowledge(dataDir, 'https://subhd.tv', seedsDir)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe('compare-and-swap (G2)', () => {
  it('loadKnowledgeWithVersion returns a stable token for the same on-disk bytes', () => {
    const dataDir = tmpDir();
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, k);

    const first = loadKnowledgeWithVersion(dataDir, 'https://subhd.tv');
    const second = loadKnowledgeWithVersion(dataDir, 'https://subhd.tv');
    expect(first.version).toBe(second.version);
    expect(first.version).not.toBe('');
  });

  it('gives a distinct version for a fresh site with no file yet', () => {
    const { version } = loadKnowledgeWithVersion(tmpDir(), 'https://nowhere.test');
    expect(version).toBeTruthy();
  });

  it('saves normally when expectedVersion matches what is on disk, and returns the new version', () => {
    const dataDir = tmpDir();
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, k);
    const { knowledge, version } = loadKnowledgeWithVersion(dataDir, 'https://subhd.tv');

    knowledge.sections.Pitfalls.push('IF x THEN y. (confirmed 2026-08-10)');
    const newVersion = saveKnowledge(dataDir, knowledge, version);

    expect(newVersion).not.toBe(version);
    expect(readFileSync(knowledgePath(dataDir, 'https://subhd.tv'), 'utf8')).toContain('IF x THEN y.');
    // The new version really does describe what's on disk now.
    expect(loadKnowledgeWithVersion(dataDir, 'https://subhd.tv').version).toBe(newVersion);
  });

  it('refuses to save over a file that changed since expectedVersion was captured, leaving it untouched', () => {
    const dataDir = tmpDir();
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, k);
    const { knowledge, version } = loadKnowledgeWithVersion(dataDir, 'https://subhd.tv');

    // Someone else writes in between.
    const intervening = { ...k, operatorNotes: 'Someone else edited this in the meantime.' };
    saveKnowledge(dataDir, intervening);
    const path = knowledgePath(dataDir, 'https://subhd.tv');
    const onDiskBefore = readFileSync(path, 'utf8');

    knowledge.sections.Pitfalls.push('IF x THEN y. (confirmed 2026-08-10)');
    expect(() => saveKnowledge(dataDir, knowledge, version)).toThrow(KnowledgeConflictError);
    expect(readFileSync(path, 'utf8')).toBe(onDiskBefore);
  });

  it('conflicts when expectedVersion says "no file" but one now exists', () => {
    const dataDir = tmpDir();
    const { version } = loadKnowledgeWithVersion(dataDir, 'https://x.test'); // no file yet
    saveKnowledge(dataDir, emptyKnowledge('https://x.test')); // someone else creates it

    expect(() => saveKnowledge(dataDir, emptyKnowledge('https://x.test'), version)).toThrow(KnowledgeConflictError);
  });

  it('omitting expectedVersion keeps the unconditional overwrite', () => {
    const dataDir = tmpDir();
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    saveKnowledge(dataDir, k);
    saveKnowledge(dataDir, { ...k, operatorNotes: 'no CAS, always wins' });
    expect(loadKnowledge(dataDir, 'https://subhd.tv').operatorNotes).toBe('no CAS, always wins');
  });
});

describe('the shipped subhd.tv seed', () => {
  it('loads through loadKnowledge, stays under the char cap, and does not trip the scanner', () => {
    const dataDir = tmpDir();
    const k = loadKnowledge(dataDir, 'https://subhd.tv', defaultSeedsDir());

    expect(k.sections.Access.length).toBeGreaterThan(0);
    expect(k.sections.Search.length).toBeGreaterThan(0);
    expect(k.sections.Download.length).toBeGreaterThan(0);

    // The subhd protocol details must survive the reshape into IF/THEN bullets intact.
    const allBullets = [...k.sections.Access, ...k.sections.Search, ...k.sections.Download, ...k.sections.Pitfalls].join('\n');
    expect(allBullets).toContain('/a/{slug}');
    expect(allBullets).toContain('/down/{slug}');
    expect(allBullets).toContain('/api/sub/down');
    expect(allBullets).toContain('{"sid": "{slug}", "cap": ""}');
    expect(allBullets).toContain('captcha');
    expect(allBullets).toContain('Referer');
    for (const bullet of allBullets.split('\n')) {
      expect(bullet).toMatch(/\(confirmed \d{4}-\d{2}-\d{2}\)$/);
    }

    expect(agentCharCount(k)).toBeLessThan(KNOWLEDGE_CHAR_CAP);
    expect(scanForThreats(knowledgeForPrompt(k), 'strict')).toEqual([]);
  });
});
