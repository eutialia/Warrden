import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { PipelineName, TargetKind } from '../jobs/queue.js';

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

// Both Sonarr and Radarr fire `Download` for import events — a fresh grab as well as an
// upgrade of an existing file, distinguished only by `isUpgrade`. `series`/`movie` are
// optional here (rather than a second discriminated union) because the schema can't tell
// which one a given arr sends before parsing; the handler picks whichever is present.
const DownloadSchema = z.object({
  eventType: z.literal('Download'),
  series: z.object({ id: z.number(), title: z.string() }).optional(),
  movie: z.object({ id: z.number(), title: z.string() }).optional(),
  isUpgrade: z.boolean().optional(),
});

const WebhookSchema = z.discriminatedUnion('eventType', [SeriesAddSchema, MovieAddedSchema, DownloadSchema, TestSchema]);

export interface HandleWebhookResult {
  handled: boolean;
  reason?: string;
}

/** Only the parts of AppContext handleWebhook actually reads — lets the route pass a
 * partial ctx without an `as AppContext` cast. */
export type HandleWebhookCtx = Pick<AppContext, 'queue' | 'events' | 'config' | 'clients'>;

/**
 * Validates an inbound Sonarr/Radarr webhook body and, for a series/movie "added"
 * event, enqueues the acquire pipeline for it. Never throws — an unconfigured
 * instance, a malformed payload, or a not-yet-supported event type are all reported
 * as `handled: false` so the route can still answer the arr with 200 (arrs retry on
 * non-2xx, which we don't want).
 */
export function handleWebhook(ctx: HandleWebhookCtx, instanceName: string, payload: unknown): HandleWebhookResult {
  // `ctx.clients` (not `ctx.config.arrs`) is checked here because it's what the runner
  // actually resolves against (`ctx.clients.get(job.arr_instance)` in
  // `src/pipelines/acquire/run.ts`) — the two can drift: a brand-new instance can be in
  // `config.arrs` before a restart has wired up its `ArrClient` (arr connections are
  // startup-only, per the README), and enqueueing against it here would only fail later,
  // uncaught, when the runner actually tries to process the job.
  if (!ctx.clients.has(instanceName)) {
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

  // Resolve what to dispatch per event type, then enqueue + log once below — every
  // event here reduces to the same shape (a pipeline, a series-or-movie target, and a
  // job payload), so branching only to fill that in keeps the two near-identical
  // enqueue + append calls this used to have from drifting apart.
  let pipeline: PipelineName;
  let targetKind: TargetKind;
  let target: { id: number; title: string } | undefined;
  let extraData: Record<string, unknown> = {};

  if (event.eventType === 'Download') {
    pipeline = 'ingest';
    targetKind = event.series ? 'series' : 'movie';
    target = event.series ?? event.movie;
    extraData = { isUpgrade: event.isUpgrade };
  } else {
    pipeline = 'acquire';
    targetKind = event.eventType === 'SeriesAdd' ? 'series' : 'movie';
    target = event.eventType === 'SeriesAdd' ? event.series : event.movie;
  }

  if (!target) {
    return { handled: false, reason: 'ignored' };
  }

  let jobPayload: Record<string, unknown> = { title: target.title };
  if (event.eventType === 'Download') {
    // `isUpgrade` rides along on the job payload (not just the event's `data`) because
    // the subtitle pipeline is enqueued as a follow-on from ingest — whose payload is
    // built from the webhook's original job, so the only chain that can tell an upgrade
    // from a fresh download is this payload. Ingest itself ignores it.
    jobPayload = { title: target.title, isUpgrade: event.isUpgrade };
  }
  // No `downloadId` here (even for a Download event): nothing downstream reads it — ingest
  // derives its own download ids straight from the arr's live queue (`assessQueue`), not
  // from whatever the webhook happened to carry when the job was first enqueued.
  const result = ctx.queue.enqueue({
    pipeline,
    targetKind,
    targetId: target.id,
    arrInstance: instanceName,
    payload: jobPayload,
  });
  ctx.events.append({
    kind: 'webhook.received',
    jobId: result.id ?? undefined,
    message: `${event.eventType} for "${target.title}" (${instanceName})`,
    data: { instance: instanceName, eventType: event.eventType, targetId: target.id, outcome: result.outcome, ...extraData },
  });

  return { handled: true };
}
