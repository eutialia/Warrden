import { describe, expect, it } from 'vitest';
import { resolveTargetMeta, resolveTargetTitle } from '../src/pipelines/targetTitle.js';
import { enqueueAndClaim, fakeArrClient, makeCtx, movieResource, seriesResource } from './helpers.js';

describe('resolveTargetMeta', () => {
  it('includes series alternateTitles for search variants', async () => {
    const client = fakeArrClient({
      series: [
        seriesResource({
          id: 42,
          title: 'Frieren',
          alternateTitles: [{ title: '葬送的芙莉莲' }, { title: 'Sousou no Frieren' }],
        }),
      ],
    });
    const ctx = makeCtx({ clients: new Map([['sonarr', client]]) });
    const job = enqueueAndClaim(ctx, {
      pipeline: 'subtitle',
      targetKind: 'series',
      targetId: 42,
      arrInstance: 'sonarr',
      payload: { title: 'Frieren' },
    });
    const meta = await resolveTargetMeta(client, job);
    expect(meta.title).toBe('Frieren');
    expect(meta.alternates).toEqual(expect.arrayContaining(['葬送的芙莉莲', 'Sousou no Frieren']));
  });

  it('includes movie originalTitle and alternateTitles', async () => {
    const client = fakeArrClient({
      movies: [
        movieResource({
          id: 7,
          title: 'Perfect Blue',
          originalTitle: 'パーフェクトブルー',
          alternateTitles: [{ title: '未麻的部屋' }],
        }),
      ],
    });
    const ctx = makeCtx({ clients: new Map([['radarr', client]]) });
    const job = enqueueAndClaim(ctx, {
      pipeline: 'subtitle',
      targetKind: 'movie',
      targetId: 7,
      arrInstance: 'radarr',
    });
    const meta = await resolveTargetMeta(client, job);
    expect(meta.title).toBe('Perfect Blue');
    expect(meta.alternates).toEqual(expect.arrayContaining(['パーフェクトブルー', '未麻的部屋']));
    await expect(resolveTargetTitle(client, job)).resolves.toBe('Perfect Blue');
  });
});
