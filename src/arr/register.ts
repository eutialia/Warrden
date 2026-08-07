import type { AppContext } from '../context.js';
import { ManagedObjects } from '../db/managedObjects.js';
import type { NotificationSummary } from './types.js';
import { errorMessage } from '../util/errors.js';

const NOTIFICATION_NAME = 'Warrden';

/**
 * Self-registers the Warrden webhook notification on every configured arr instance
 * that doesn't already have one. Idempotent (checks by name before creating) and
 * fault-tolerant: a broken/unreachable/unconfigured instance logs a warning and is
 * skipped, it never stops the rest from registering.
 */
export async function registerWebhooks(ctx: AppContext): Promise<void> {
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

    try {
      const existing = await client.listNotifications();
      const found = existing.find((n) => n.name === NOTIFICATION_NAME);
      // Set only when we've just deleted a stale registration — tracks both "recreate,
      // not fresh-create" for the event payload below, and the removed id for the
      // recreate-failure warning if the replacement create doesn't land.
      let recreatedFromId: number | undefined;
      if (found) {
        if (found.onDownload === true && found.onUpgrade === true) {
          // Already present in the arr and subscribed to everything we need, but the
          // local registry may have been reset (fresh db, restore) — re-record it so
          // GC (reconcile.ts's gc()) can still find it.
          managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: found.id, name: NOTIFICATION_NAME });
          continue;
        }
        // Registered by Phase 1 without import events — recreate rather than PUT: a full
        // notification update requires round-tripping every field, and delete+create with
        // our own known-good body is simpler and idempotent under the name check above.
        await client.deleteNotification(found.id);
        managedObjects.delete(arr.name, 'notification', found.id);
        recreatedFromId = found.id;
      }

      const url = `${ctx.config.server.publicUrl}/webhooks/${arr.name}`;
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
