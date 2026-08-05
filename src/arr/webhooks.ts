import { z } from 'zod';
import type { AppContext } from '../context.js';

// Zod object schemas strip unknown keys by default rather than rejecting them, so real
// Sonarr/Radarr payloads — which carry many more fields than we care about — parse
// fine as-is; nothing here needs `.passthrough()` since nothing reads the stripped fields.
const SeriesAddSchema = z.object({
  eventType: z.literal('SeriesAdd'),
  series: z.object({ id: z.number(), title: z.string() }),
});

const MovieAddedSchema = z.object({
  eventType: z.literal('MovieAdded'),
  movie: z.object({ id: z.number(), title: z.string() }),
});

const TestSchema = z.object({
  eventType: z.literal('Test'),
});

const WebhookSchema = z.discriminatedUnion('eventType', [SeriesAddSchema, MovieAddedSchema, TestSchema]);

export interface HandleWebhookResult {
  handled: boolean;
  reason?: string;
}

/** Only the parts of AppContext handleWebhook actually reads — lets the route pass a
 * partial ctx without an `as AppContext` cast. */
export type HandleWebhookCtx = Pick<AppContext, 'queue' | 'events' | 'config'>;

/**
 * Validates an inbound Sonarr/Radarr webhook body and, for a series/movie "added"
 * event, enqueues the acquire pipeline for it. Never throws — an unconfigured
 * instance, a malformed payload, or a not-yet-supported event type are all reported
 * as `handled: false` so the route can still answer the arr with 200 (arrs retry on
 * non-2xx, which we don't want).
 */
export function handleWebhook(ctx: HandleWebhookCtx, instanceName: string, payload: unknown): HandleWebhookResult {
  if (!ctx.config.arrs.some((a) => a.name === instanceName)) {
    return { handled: false, reason: 'unknown instance' };
  }

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

  const result = ctx.queue.enqueue({
    pipeline: 'acquire',
    targetKind,
    targetId: target.id,
    arrInstance: instanceName,
    payload: { title: target.title },
  });
  ctx.events.append({
    kind: 'webhook.received',
    jobId: result.id ?? undefined,
    message: `${event.eventType} for "${target.title}" (${instanceName})`,
    data: { instance: instanceName, eventType: event.eventType, targetId: target.id, outcome: result.outcome },
  });

  return { handled: true };
}
