import type { AppContext } from '../context.js';
import { ManagedObjects } from '../db/managedObjects.js';
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
      if (found) {
        if (found.onDownload === true && found.onUpgrade === true) {
          // Already present in the arr and subscribed to everything we need, but the
          // local registry may have been reset (fresh db, restore) — re-record it so
          // GC (Task 12) can still find it.
          managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: found.id, name: NOTIFICATION_NAME });
          continue;
        }
        // Registered by Phase 1 without import events — recreate rather than PUT: a full
        // notification update requires round-tripping every field, and delete+create with
        // our own known-good body is simpler and idempotent under the name check above.
        await client.deleteNotification(found.id);
        managedObjects.delete(arr.name, 'notification', found.id);
      }

      const url = `${ctx.config.server.publicUrl}/webhooks/${arr.name}`;
      const created = await client.createNotification({
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
      });

      managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: created.id, name: NOTIFICATION_NAME });

      ctx.events.append({
        kind: 'webhook.registered',
        message: `Registered "${NOTIFICATION_NAME}" webhook on "${arr.name}"`,
        data: { instance: arr.name, url },
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
