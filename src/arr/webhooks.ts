import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { PipelineName, TargetKind } from '../jobs/queue.js';
import { eventEnvelope, type EpisodeFact, type EventFacts, type FileFact, type ReleaseFact } from '../events/envelope.js';
import { traceTrigger } from '../trace/tracer.js';

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

/**
 * The imported file, as either arr describes it: Sonarr sends it under `episodeFile`,
 * Radarr under `movieFile`, with identical field names inside. Every field past the path is
 * optional — a manual import can arrive with no quality, no group and no `mediaInfo` — so
 * absence never costs us the whole webhook.
 */
const MediaFileSchema = z.object({
  relativePath: z.string(),
  quality: z.string().optional(),
  releaseGroup: z.string().optional(),
  size: z.number().optional(),
  /** The raw torrent/usenet name of the file, when the download client had one. */
  sceneName: z.string().optional(),
  /** Where the arr imported it FROM — the download client's own copy. */
  sourcePath: z.string().optional(),
  mediaInfo: z
    .object({
      subtitles: z.array(z.string()).optional(),
      audioLanguages: z.array(z.string()).optional(),
    })
    .optional(),
});

// Both Sonarr and Radarr fire `Download` for import events — a fresh grab as well as an
// upgrade of an existing file, distinguished only by `isUpgrade`. `series`/`movie` are
// optional here (rather than a second discriminated union) because the schema can't tell
// which one a given arr sends before parsing; the handler picks whichever is present.
//
// The blocks below the target are what the event log keeps of the import. NOT kept, and
// deliberately: series/movie metadata past id+title, images, overviews, `customFormatInfo`,
// `downloadClient*`, `applicationUrl` — the trace stores the body verbatim, so the event
// only carries what a reader composes a line from. `release.size` is likewise ignored: for
// a pack it is the size of the whole pack, and the row is about one file.
const DownloadSchema = z.object({
  eventType: z.literal('Download'),
  series: z.object({ id: z.number(), title: z.string() }).optional(),
  movie: z.object({ id: z.number(), title: z.string() }).optional(),
  isUpgrade: z.boolean().optional(),
  episodes: z
    .array(z.object({ seasonNumber: z.number(), episodeNumber: z.number(), title: z.string().optional() }))
    .optional(),
  episodeFile: MediaFileSchema.optional(),
  movieFile: MediaFileSchema.optional(),
  release: z
    .object({ releaseTitle: z.string().optional(), indexer: z.string().optional(), releaseType: z.string().optional() })
    .optional(),
  downloadId: z.string().optional(),
});

type DownloadEvent = z.infer<typeof DownloadSchema>;
type MediaFile = z.infer<typeof MediaFileSchema>;

/** Sonarr's release shapes, in the vocabulary `ReleaseFact.type` already speaks. Radarr
 * sends no `releaseType` at all, which lands on `undefined` like any other unknown. */
const RELEASE_TYPES: Record<string, ReleaseFact['type']> = {
  singleEpisode: 'single',
  multiEpisode: 'multi',
  seasonPack: 'pack',
};

/**
 * One Download webhook as normalized facts — the same shape whichever arr sent it.
 *
 * This is the whole point of keeping the fields: nothing downstream may branch on Sonarr
 * vs Radarr, so `episodeFile` and `movieFile` collapse into one `file` here and the
 * difference stops existing at the door. A movie simply has no `episodes`.
 */
function importFacts(event: DownloadEvent): EventFacts {
  const media = event.episodeFile ?? event.movieFile;
  return {
    episodes: episodeFacts(event.episodes),
    file: fileFact(media),
    release: releaseFact(event),
    // The download client's own path is what `sourcePath` means everywhere else ("where
    // this file came from"), so it wins; `sceneName` answers the same question when the
    // arr didn't send one, and is the only surviving trace of the torrent's real name.
    sourcePath: media?.sourcePath ?? media?.sceneName,
    downloadId: event.downloadId,
  };
}

function episodeFacts(episodes: DownloadEvent['episodes']): readonly EpisodeFact[] | undefined {
  if (episodes === undefined || episodes.length === 0) return undefined;
  return episodes.map((e) => ({
    season: e.seasonNumber,
    episode: e.episodeNumber,
    ...(e.title === undefined ? {} : { title: e.title }),
  }));
}

function fileFact(media: MediaFile | undefined): FileFact | undefined {
  if (media === undefined) return undefined;
  const subs = media.mediaInfo?.subtitles;
  const audio = media.mediaInfo?.audioLanguages;
  return {
    path: media.relativePath,
    ...(media.quality === undefined ? {} : { quality: media.quality }),
    ...(media.releaseGroup === undefined ? {} : { group: media.releaseGroup }),
    // The FILE's size, never `release.size`: a season pack's release size is the whole
    // pack, repeated identically on every one of its per-episode webhooks.
    ...(media.size === undefined ? {} : { size: media.size }),
    ...(subs === undefined || subs.length === 0 ? {} : { subs }),
    ...(audio === undefined || audio.length === 0 ? {} : { audio }),
  };
}

function releaseFact(event: DownloadEvent): ReleaseFact | undefined {
  const release = event.release;
  if (release === undefined) return undefined;
  const type = release.releaseType === undefined ? undefined : RELEASE_TYPES[release.releaseType];
  const fact: ReleaseFact = {
    ...(release.releaseTitle === undefined ? {} : { title: release.releaseTitle }),
    ...(release.indexer === undefined ? {} : { indexer: release.indexer }),
    ...(type === undefined ? {} : { type }),
  };
  return Object.keys(fact).length === 0 ? undefined : fact;
}

const WebhookSchema = z.discriminatedUnion('eventType', [SeriesAddSchema, MovieAddedSchema, DownloadSchema, TestSchema]);

/** A season pack import fires one Download webhook per episode; enqueueing each ingest run
 * `notBefore` this far out lets the queue's coalescing (which resets the pending twin's
 * not_before on every duplicate) collapse the storm into one run after the last webhook. */
export const INGEST_DEBOUNCE_MS = 30_000;

interface HandleWebhookResult {
  handled: boolean;
  reason?: string;
}

/** Only the parts of AppContext handleWebhook actually reads — lets the route pass a
 * partial ctx without an `as AppContext` cast. */
type HandleWebhookCtx = Pick<AppContext, 'queue' | 'events' | 'config' | 'clients' | 'trace'>;

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
  // `src/pipelines/acquire/run.ts`): enqueueing a job for an instance with no client would
  // only fail later, uncaught, when the runner actually tries to process it. The two are
  // rebuilt together by `applyConfig`, so this is also the live view of what's configured.
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
  let isUpgrade: boolean | undefined;
  let imported: EventFacts = {};

  if (event.eventType === 'Download') {
    pipeline = 'ingest';
    targetKind = event.series ? 'series' : 'movie';
    target = event.series ?? event.movie;
    isUpgrade = event.isUpgrade;
    imported = importFacts(event);
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
    ...(event.eventType === 'Download' ? { notBefore: Date.now() + INGEST_DEBOUNCE_MS } : {}),
  });
  traceTrigger(ctx.trace, result, {
    kind: 'trigger.webhook',
    summary: `${event.eventType} webhook (${instanceName})`,
    payload: () => payload,
  });
  ctx.events.append({
    kind: 'webhook.received',
    jobId: result.id,
    message: `${event.eventType} for "${target.title}" (${instanceName})`,
    data: eventEnvelope({
      scope: 'trigger',
      action: 'webhook',
      facts: {
        source: 'webhook',
        instance: instanceName,
        eventType: event.eventType,
        title: target.title,
        pipeline,
        outcome: result.outcome,
        // A pack import is one webhook per file, every one of them coalesced onto the same
        // job. The rows stay individually stored — Phase C reads them as the per-file
        // history — and a reader folds them into one line by this key.
        coalesceKey: `hooks:${result.id}`,
        ...(isUpgrade === undefined ? {} : { reason: isUpgrade ? 'upgrade' : 'new' }),
        // The import itself: which episodes, which file, which release. A pack fires one of
        // these per file, so these rows ARE the per-file history the drawer renders.
        ...imported,
      },
    }),
  });

  return { handled: true };
}
