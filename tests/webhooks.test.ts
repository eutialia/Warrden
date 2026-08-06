import { describe, it, expect } from 'vitest';
import { handleWebhook } from '../src/arr/webhooks.js';
import { makeCtx, configWithArrs, fakeArrClient } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';

const seriesAdd = { eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren', year: 2023, tvdbId: 424536 } };
const movieAdded = { eventType: 'MovieAdded', movie: { id: 7, title: 'Perfect Blue', year: 1997, tmdbId: 573 } };

function knownArrsCtx() {
  return makeCtx({
    config: configWithArrs('sonarr', 'radarr'),
    clients: new Map<string, ArrApi>([
      ['sonarr', fakeArrClient()],
      ['radarr', fakeArrClient()],
    ]),
  });
}

describe('handleWebhook', () => {
  it.each([
    { name: 'sonarr SeriesAdd', instance: 'sonarr', payload: seriesAdd, targetKind: 'series', targetId: 42 },
    { name: 'radarr MovieAdded', instance: 'radarr', payload: movieAdded, targetKind: 'movie', targetId: 7 },
  ])('$name enqueues acquire', ({ instance, payload, targetKind, targetId }) => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    const job = ctx.queue.claim()!;
    expect(job).toMatchObject({ pipeline: 'acquire', target_kind: targetKind, target_id: targetId, arr_instance: instance });
  });

  it('acknowledges Test events without enqueueing', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Test' }).handled).toBe(true);
    expect(ctx.queue.claim()).toBeNull();
  });

  it('ignores unknown events and garbage payloads', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Rename' })).toEqual({ handled: false, reason: 'ignored' });
    expect(handleWebhook(ctx, 'sonarr', { nonsense: true })).toEqual({ handled: false, reason: 'ignored' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance with no registered client, even by default (no config, no clients)', () => {
    const ctx = makeCtx(); // default config: arrs: [], clients: {}
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance that is in config.arrs but has no ctx.clients entry yet — clients, not config, is authoritative (a brand-new instance before a restart wires it up)', () => {
    const ctx = makeCtx({ config: configWithArrs('sonarr') }); // configured, but no client registered
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('carries the target title through as the acquire prompt hint', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    expect(ctx.queue.claim()!.payload).toEqual({ title: 'Frieren' });
  });

  it('appends an event carrying the job id and enqueue outcome', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received', job_id: job.id });
    expect(events[0]!.data).toMatchObject({ outcome: 'enqueued' });
  });
});
