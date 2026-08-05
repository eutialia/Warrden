import { describe, it, expect } from 'vitest';
import { handleWebhook } from '../src/arr/webhooks.js';
import { makeCtx } from './helpers.js';

const seriesAdd = { eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren', year: 2023, tvdbId: 424536 } };
const movieAdded = { eventType: 'MovieAdded', movie: { id: 7, title: 'Perfect Blue', year: 1997, tmdbId: 573 } };

describe('handleWebhook', () => {
  it.each([
    { name: 'sonarr SeriesAdd', instance: 'sonarr', payload: seriesAdd, targetKind: 'series', targetId: 42 },
    { name: 'radarr MovieAdded', instance: 'radarr', payload: movieAdded, targetKind: 'movie', targetId: 7 },
  ])('$name enqueues acquire', ({ instance, payload, targetKind, targetId }) => {
    const ctx = makeCtx();
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    const job = ctx.queue.claim()!;
    expect(job).toMatchObject({ pipeline: 'acquire', target_kind: targetKind, target_id: targetId, arr_instance: instance });
  });

  it('acknowledges Test events without enqueueing', () => {
    const ctx = makeCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Test' }).handled).toBe(true);
    expect(ctx.queue.claim()).toBeNull();
  });

  it('ignores unknown events and garbage payloads', () => {
    const ctx = makeCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Rename' }).handled).toBe(false);
    expect(handleWebhook(ctx, 'sonarr', { nonsense: true }).handled).toBe(false);
    expect(ctx.queue.claim()).toBeNull();
  });

  it('carries the target title through as the acquire prompt hint', () => {
    const ctx = makeCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    expect(ctx.queue.claim()!.payload).toEqual({ title: 'Frieren' });
  });

  it('appends an event on a handled webhook', () => {
    const ctx = makeCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received' });
  });
});
