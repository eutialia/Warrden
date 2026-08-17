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
 * Self-registers the Warrden webhook notification on every configured arr instance
 * that doesn't already have one. Idempotent (checks by name before creating) and
 * fault-tolerant: a broken/unreachable/unconfigured instance logs a warning and is
 * skipped, it never stops the rest from registering.
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
      const existing = await client.listNotifications();
      const found = existing.find((n) => n.name === NOTIFICATION_NAME);
      // Set only when we've just deleted a stale registration — tracks both "recreate,
      // not fresh-create" for the event payload below, and the removed id for the
      // recreate-failure warning if the replacement create doesn't land.
      let recreatedFromId: number | undefined;
      if (found) {
        const registeredUrl = notificationUrl(found);
        // A rename of this instance, or a `server.publicUrl` change, moves the path we
        // actually serve: the arr keeps POSTing to the old one and every event it sends is
        // dropped on the floor, silently and for as long as nobody notices.
        const pointsElsewhere = registeredUrl !== undefined && registeredUrl !== url;
        if (found.onDownload === true && found.onUpgrade === true && !pointsElsewhere) {
          // Already present in the arr and subscribed to everything we need, but the
          // local registry may have been reset (fresh db, restore) — re-record it so
          // GC (reconcile.ts's gc()) can still find it.
          managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: found.id, name: NOTIFICATION_NAME });
          continue;
        }
        // Missing import events (a Phase 1 registration), or pointing at an address that
        // isn't ours any more: recreate rather than PUT, since a full notification update
        // requires round-tripping every field, and delete+create with our own known-good
        // body is simpler and idempotent under the name check above.
        await client.deleteNotification(found.id);
        managedObjects.delete(arr.name, 'notification', found.id);
        recreatedFromId = found.id;
      }

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

      let created: NotificationSummary;
      try {
        created = await client.createNotification(body);
      } catch (err) {
        // A fresh-create failure (no prior delete) is just a normal registration
        // failure — fall through to the outer catch's "webhook.register-failed". A
        // recreate failure is worse: the old notification is already gone, so the arr
        // has *no* Warrden webhook right now. Retry once immediately (cheap — every
        // startup retries anyway) before reporting that explicitly.
        if (recreatedFromId === undefined) throw err;

        // The create call can fail on our end (timeout, dropped connection) AFTER the arr
        // already committed it server-side — a blind retry in that case would create a
        // genuine duplicate on top of it. Re-list by name first: if "Warrden" is already
        // there, that's the create that just failed to tell us it succeeded; record it
        // instead of creating a second one. A re-list failure here is treated the same as
        // "nothing found" — it falls through to the blind retry below, same as before this
        // check existed.
        const relisted = await client.listNotifications().catch(() => []);
        const alreadyCommitted = relisted.find((n) => n.name === NOTIFICATION_NAME);
        if (alreadyCommitted) {
          created = alreadyCommitted;
        } else {
          try {
            created = await client.createNotification(body);
          } catch (retryErr) {
            ctx.events.append({
              kind: 'webhook.recreate-failed',
              level: 'warn',
              message: `Removed the stale "${NOTIFICATION_NAME}" webhook on "${arr.name}" but failed to recreate it — the instance currently has no Warrden webhook: ${errorMessage(retryErr)}`,
              data: { instance: arr.name, oldId: recreatedFromId },
            });
            continue;
          }
        }
      }

      managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: created.id, name: NOTIFICATION_NAME });

      ctx.events.append({
        kind: 'webhook.registered',
        message: `Registered "${NOTIFICATION_NAME}" webhook on "${arr.name}"`,
        data: recreatedFromId !== undefined ? { instance: arr.name, url, recreated: true } : { instance: arr.name, url },
      });
    } catch (err) {
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'warn',
        message: `Failed to register webhook on "${arr.name}": ${errorMessage(err)}`,
        data: { instance: arr.name },
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
