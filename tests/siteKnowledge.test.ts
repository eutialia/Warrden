import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyKnowledge,
  knowledgeForPrompt,
  knowledgePath,
  loadKnowledge,
  parseKnowledge,
  pruneStale,
  renderKnowledge,
  saveKnowledge,
} from '../src/agent/siteKnowledge.js';
import { ensureDataSubdir } from '../src/fs/paths.js';
import { tmpDir } from './helpers.js';

const SAMPLE = `---
site: https://subhd.tv
updated: 2026-08-10
---

# subhd.tv

## Access
- IF the search page returns a Cloudflare interstitial THEN escalate to chromium. (confirmed 2026-08-10)

## Search
- IF searching THEN GET /search/{query} with the query URL-encoded. (confirmed 2026-08-01)

## Download

## Pitfalls

## Operator notes
Never use this site for anime.
`;

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

  it('prunes bullets older than the window once the site has succeeded since', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Access.push(stale, fresh);
    const pruned = pruneStale(k, '2026-08-10', true);
    expect(pruned.sections.Access).toEqual([fresh]);
  });

  it('keeps stale bullets when the site has had no success to judge them by', () => {
    const k = emptyKnowledge('https://x.test');
    k.sections.Access.push(stale);
    expect(pruneStale(k, '2026-08-10', false).sections.Access).toEqual([stale]);
  });

  it('never prunes operator notes', () => {
    const k = parseKnowledge('https://subhd.tv', SAMPLE);
    expect(pruneStale(k, '2030-01-01', true).operatorNotes).toBe('Never use this site for anime.');
  });
});
