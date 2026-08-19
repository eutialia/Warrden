import type { AppContext } from '../context.js';
import { ManagedObjects } from '../db/managedObjects.js';
import type { NotificationSummary } from './types.js';
import { errorMessage } from '../util/errors.js';

const NOTIFICATION_NAME = 'Warrden';

/** Only the parts of AppContext registration actually reads, the same idiom as
 * `HandleWebhookCtx` in `webhooks.ts`, so the config route can hand it the fields it has
 * gated on without an `as AppContext` cast. */
type RegisterCtx = Pick<AppContext, 'db' | 'config' | 'clients' | 'events'>;

/** The address an existing notification is currently POSTing to, or `undefined` when the arr
 * didn't return the field at all. Absent is deliberately not "wrong": a real Sonarr/Radarr
 * always includes its implementation's settings, so treating a missing `url` as stale would
 * only ever churn a webhook we can't actually prove anything about. */
function notificationUrl(notification: NotificationSummary): string | undefined {
  const field = notification.fields?.find((f) => f.name === 'url');
  return typeof field?.value === 'string' ? field.value : undefined;
}

/**
 * Self-registers the Warrden webhook notification on every configured arr instance that
 * doesn't already have a correct one: create when absent, PUT in place when present but
 * wrong. Idempotent (checks by name first) and fault-tolerant: an instance that errors
 * raises its own attention item and is skipped, it never stops the rest from registering.
 */
export async function registerWebhooks(ctx: RegisterCtx): Promise<void> {
  const managedObjects = new ManagedObjects(ctx.db);

  for (const arr of ctx.config.arrs) {
    const client = ctx.clients.get(arr.name);
    if (!client) {
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'warn',
        message: `Failed to register webhook on "${arr.name}": no ArrClient configured`,
        data: { instance: arr.name },
      });
      continue;
    }

    const url = `${ctx.config.server.publicUrl}/webhooks/${arr.name}`;

    try {
      const body = {
        name: NOTIFICATION_NAME,
        implementation: 'Webhook',
        configContract: 'WebhookSettings',
        fields: [
          { name: 'url', value: url },
          { name: 'method', value: 1 },
        ],
        onSeriesAdd: true,
        onMovieAdded: true,
        onDownload: true,
        onUpgrade: true,
      };

      const existing = await client.listNotifications();
      const found = existing.find((n) => n.name === NOTIFICATION_NAME);
      if (found) {
        const registeredUrl = notificationUrl(found);
        // A rename of this instance, or a `server.publicUrl` change, moves the path we
        // actually serve: the arr keeps POSTing to the old one and every event it sends is
        // dropped on the floor, silently and for as long as nobody notices.
        const pointsElsewhere = registeredUrl !== undefined && registeredUrl !== url;
        // Every flag that this app actually has, not every flag `body` sends: a hook
        // subscribed to Download alone still delivers nothing on the add event, so treating it
        // as healthy left it standing forever and no arr-side add ever reached Warrden. The
        // notification resource is per-app though, so Sonarr echoes `onSeriesAdd` and never
        // `onMovieAdded` and Radarr the reverse; demanding both would make the predicate
        // permanently false and re-PUT an already-correct webhook on every single pass.
        const addEvent = arr.kind === 'sonarr' ? found.onSeriesAdd : found.onMovieAdded;
        const subscribedToAll = addEvent === true && found.onDownload === true && found.onUpgrade === true;
        if (subscribedToAll && !pointsElsewhere) {
          // Already present in the arr and subscribed to everything we need, but the
          // local registry may have been reset (fresh db, restore) — re-record it so
          // GC (reconcile.ts's gc()) can still find it.
          managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: found.id, name: NOTIFICATION_NAME });
          continue;
        }
        // Missing import events (a Phase 1 registration), or pointing at an address that
        // isn't ours any more: PUT our own known-good body over the id it already has.
        // Never delete-then-create: a create that doesn't land after the delete did
        // leaves the arr with NO webhook (a live run lost 22 minutes of events that way),
        // whereas a failed PUT leaves the old, wrong-but-present notification standing.
        const updated = await client.updateNotification({ ...body, id: found.id });
        managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: updated.id, name: NOTIFICATION_NAME });
        ctx.events.append({
          kind: 'webhook.registered',
          message: `Updated the "${NOTIFICATION_NAME}" webhook on "${arr.name}" in place`,
          data: { instance: arr.name, url, updated: true },
        });
        continue;
      }

      const created = await client.createNotification(body);
      managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: created.id, name: NOTIFICATION_NAME });

      ctx.events.append({
        kind: 'webhook.registered',
        message: `Registered "${NOTIFICATION_NAME}" webhook on "${arr.name}"`,
        data: { instance: arr.name, url },
      });
    } catch (err) {
      // Attention, not warn: every path that lands here ends with the instance having no
      // webhook we can vouch for, and the symptom (nothing ever arrives from this arr) is
      // invisible until someone goes looking. `targetKind`/`targetId` are what
      // `AttentionItems.open` actually dedupes on, so a failure that repeats every startup
      // refreshes one open row per instance instead of piling up a new one per pass.
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'attention',
        message: `Failed to register the Warrden webhook on "${arr.name}" - the instance may not be delivering events: ${errorMessage(err)}`,
        data: { instance: arr.name, targetKind: 'notification', targetId: NOTIFICATION_NAME, dedupeKey: arr.name },
      });
    }
  }
}

// One pass at a time, and at most one pass waiting behind it. Two rapid saves would
// otherwise interleave their list-then-create against the same arr and register the webhook
// twice, since neither sees the other's create in its own `listNotifications`. The wait
// collapses to the latest ctx on purpose: an older config is exactly what the newer one
// supersedes, so running both in turn would only re-point the webhook backwards first.
let draining = false;
let queued: RegisterCtx | null = null;

/** Fires `registerWebhooks` in the background rather than blocking its caller on it: a
 * slow or unreachable arr instance would otherwise delay the HTTP server coming up at
 * startup (and, on a config save, the response to the operator's own PUT), plus every
 * other arr's registration behind it. Passes are serialized (see above); the caller gets
 * no handle either way, so a queued pass is indistinguishable from an immediate one. */
export function registerWebhooksInBackground(ctx: RegisterCtx): void {
  queued = ctx;
  if (draining) return;
  draining = true;
  void drainQueue();
}

/** `registerWebhooks` already isolates per-instance failures internally; the `catch` here is
 * the last-resort net for anything that still escapes it, reported as a `warn` event (rather
 * than `console.error`, so it's visible on the dashboard like every other background
 * failure) and never allowed to stall the queue behind it. */
async function drainQueue(): Promise<void> {
  try {
    while (queued) {
      const ctx = queued;
      queued = null;
      try {
        await registerWebhooks(ctx);
      } catch (err) {
        ctx.events.append({
          kind: 'webhook.register-crashed',
          level: 'warn',
          message: `Webhook registration threw unexpectedly: ${errorMessage(err)}`,
        });
      }
    }
  } finally {
    // Same synchronous turn as the loop's own exit check, so a caller can never slip in
    // between "nothing queued" and "not draining" and have its pass dropped.
    draining = false;
  }
}
