import { describe, expect, it } from 'vitest';
import { runAdapterSearch } from '../src/agent/adapters/run.js';
import type { DownloadResult, SiteAdapter, SubtitleCandidate } from '../src/agent/adapters/types.js';
import { buildSearchHints } from '../src/pipelines/subtitle/queries.js';
import { FakeGenerator, tmpDir } from './helpers.js';

function fakeAdapter(opts: {
  candidates?: SubtitleCandidate[];
  download?: DownloadResult | DownloadResult[];
}): SiteAdapter & { downloads: number } {
  const queue = Array.isArray(opts.download) ? [...opts.download] : opts.download ? [opts.download] : [];
  const state = { downloads: 0 };
  return {
    id: 'fake',
    matches: () => true,
    downloads: 0,
    async search() {
      return opts.candidates ?? [];
    },
    async download() {
      state.downloads += 1;
      (this as { downloads: number }).downloads = state.downloads;
      return queue.shift() ?? { kind: 'failed', message: 'empty' };
    },
  };
}

describe('runAdapterSearch', () => {
  const hints = buildSearchHints({ title: 'Show', languages: ['zh-Hans'], preferredGroups: [] });

  it('searches, picks, downloads, and returns the file', async () => {
    const cand: SubtitleCandidate = { id: 's1', title: 'Show pack', langs: ['zh'], url: 'https://x/a/s1' };
    const adapter = fakeAdapter({
      candidates: [cand],
      download: { kind: 'file', filePath: '/tmp/pack.zip', url: 'https://dl/x.zip' },
    });
    const llm = new FakeGenerator([{ decision: 'pick', candidate: 1, reasoning: 'ok' }]);
    const transcript: string[] = [];
    const out = await runAdapterSearch({
      adapter,
      llm,
      hints,
      destDir: tmpDir(),
      workDir: tmpDir(),
      onTranscript: (e) => transcript.push(e.action),
    });
    expect(out).toEqual({ filePath: '/tmp/pack.zip', url: 'https://dl/x.zip', searchUrl: expect.stringContaining('Show') });
    expect(transcript).toContain('adapter-pick');
    expect(transcript).toContain('adapter-download');
  });

  it('solves captcha once then downloads', async () => {
    const cand: SubtitleCandidate = { id: 's1', title: 'Show', langs: ['zh'], url: 'https://x/a/s1' };
    const adapter = fakeAdapter({
      candidates: [cand],
      download: [
        { kind: 'captcha', svg: '<svg><text>Cd34</text></svg>' },
        { kind: 'file', filePath: '/tmp/ok.zip', url: 'https://dl/ok.zip' },
      ],
    });
    const llm = new FakeGenerator([{ decision: 'pick', candidate: 1, reasoning: 'ok' }]);
    const out = await runAdapterSearch({
      adapter,
      llm,
      hints,
      destDir: tmpDir(),
      workDir: tmpDir(),
      onTranscript: () => {},
    });
    expect(out?.filePath).toBe('/tmp/ok.zip');
    expect(adapter.downloads).toBe(2);
  });

  it('returns null when search is empty', async () => {
    const adapter = fakeAdapter({ candidates: [] });
    const llm = new FakeGenerator([]);
    const out = await runAdapterSearch({
      adapter,
      llm,
      hints,
      destDir: tmpDir(),
      workDir: tmpDir(),
      onTranscript: () => {},
    });
    expect(out).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});
