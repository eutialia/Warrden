import { z } from 'zod';
import type { AppContext } from '../context.js';

// Sonarr/Radarr webhooks carry many more fields than this; `.passthrough()` on every
// branch means we only assert on what we use and never reject a payload for having
// fields we don't care about.
const SeriesAddSchema = z
  .object({
    eventType: z.literal('SeriesAdd'),
    series: z.object({ id: z.number(), title: z.string() }).passthrough(),
  })
  .passthrough();

const MovieAddedSchema = z
  .object({
    eventType: z.literal('MovieAdded'),
    movie: z.object({ id: z.number(), title: z.string() }).passthrough(),
  })
  .passthrough();

const TestSchema = z
  .object({
    eventType: z.literal('Test'),
  })
  .passthrough();

const WebhookSchema = z.discriminatedUnion('eventType', [SeriesAddSchema, MovieAddedSchema, TestSchema]);

export interface HandleWebhookResult {
  handled: boolean;
  reason?: string;
}

/**
 * Validates an inbound Sonarr/Radarr webhook body and, for a series/movie "added"
 * event, enqueues the acquire pipeline for it. Never throws — malformed or
 * not-yet-supported event types are reported as `handled: false` so the route can
 * still answer the arr with 200 (arrs retry on non-2xx, which we don't want).
 */
export function handleWebhook(ctx: AppContext, instanceName: string, payload: unknown): HandleWebhookResult {
  const parsed = WebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return { handled: false, reason: 'ignored' };
  }

  const event = parsed.data;
  if (event.eventType === 'Test') {
    return { handled: true };
  }

  const target = event.eventType === 'SeriesAdd' ? event.series : event.movie;
  const targetKind = event.eventType === 'SeriesAdd' ? 'series' : 'movie';

  ctx.queue.enqueue({
    pipeline: 'acquire',
    targetKind,
    targetId: target.id,
    arrInstance: instanceName,
    payload: { title: target.title },
  });
  ctx.events.append({
    kind: 'webhook.received',
    message: `${event.eventType} for "${target.title}" (${instanceName})`,
    data: { instance: instanceName, eventType: event.eventType, targetId: target.id },
  });

  return { handled: true };
}
