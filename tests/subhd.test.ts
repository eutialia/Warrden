import { describe, expect, it } from 'vitest';
import { parseSubhdSearch, SubhdAdapter } from '../src/agent/adapters/subhd.js';
import { resolveSiteAdapter } from '../src/agent/adapters/registry.js';
import { pickSubtitlePack, solveCaptchaOnce } from '../src/agent/adapters/pick.js';
import { FakeGenerator } from './helpers.js';
import type { SearchHints } from '../src/pipelines/subtitle/queries.js';
import { buildSearchHints } from '../src/pipelines/subtitle/queries.js';

const SAMPLE_HTML = `
<html><body>
<a class="link-dark align-middle" href='/a/12345'>葬送的芙莉莲 [Airota]</a>
<span class="p-1 text-secondary">ASS</span>
<span>>简体</span></span>
<span class="align-text-top me-3">1200</span>
<a class="fw-bold text-dark" href='/u/x'>uploader</a>
<a class="link-dark align-middle" href='/a/99999'>Unrelated Show EN</a>
<span>>英语</span></span>
</body></html>
`;

describe('parseSubhdSearch', () => {
  it('extracts slug, title, and language labels', () => {
    const rows = parseSubhdSearch(SAMPLE_HTML);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ id: '12345', title: expect.stringContaining('芙莉莲') });
    expect(rows[0]!.url).toContain('/a/12345');
  });
});

describe('SubhdAdapter.matches', () => {
  const a = new SubhdAdapter();
  it.each([
    [{ name: 'subhd', baseUrl: 'https://subhd.tv' }, true],
    [{ name: 'SubHD-main', baseUrl: 'https://example.com' }, true],
    [{ name: 'acgrip', baseUrl: 'https://acg.rip' }, false],
  ])('%j -> %s', (site, expected) => {
    expect(a.matches(site)).toBe(expected);
    expect(!!resolveSiteAdapter(site)).toBe(expected);
  });
});

describe('pickSubtitlePack', () => {
  const hints: SearchHints = buildSearchHints({
    title: 'Frieren',
    languages: ['zh-Hans'],
    preferredGroups: ['Airota'],
  });

  it('returns the numbered pick', async () => {
    const llm = new FakeGenerator([{ decision: 'pick', candidate: 2, reasoning: 'best lang' }]);
    const candidates = [
      { id: '1', title: 'A', langs: ['en'], url: 'https://x/1' },
      { id: '2', title: 'B', langs: ['zh'], url: 'https://x/2' },
    ];
    const out = await pickSubtitlePack({ llm, candidates, hints });
    expect(out?.candidate.id).toBe('2');
    expect(llm.calls[0]?.promptCache).toBe(true);
  });

  it('returns null on decision none', async () => {
    const llm = new FakeGenerator([{ decision: 'none', candidate: null, reasoning: 'nope' }]);
    const out = await pickSubtitlePack({
      llm,
      candidates: [{ id: '1', title: 'A', langs: [], url: 'https://x/1' }],
      hints,
    });
    expect(out).toBeNull();
  });
});

describe('solveCaptchaOnce', () => {
  it('reads a single plaintext SVG text node without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    const svg = '<svg><text x="1">Ab12</text></svg>';
    await expect(solveCaptchaOnce({ llm, svg })).resolves.toBe('Ab12');
    expect(llm.calls).toHaveLength(0);
  });

  it('falls back to the LLM when no clear plaintext node exists', async () => {
    const llm = new FakeGenerator([{ answer: 'Xy99' }]);
    const svg = '<svg><path d="M0 0"/></svg>';
    await expect(solveCaptchaOnce({ llm, svg })).resolves.toBe('Xy99');
  });
});
