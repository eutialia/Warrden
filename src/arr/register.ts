import type { AppContext } from '../context.js';

const NOTIFICATION_NAME = 'Warrden';

/**
 * Self-registers the Warrden webhook notification on every configured arr instance
 * that doesn't already have one. Idempotent (checks by name before creating) and
 * fault-tolerant: a broken/unreachable instance logs a warning and is skipped, it
 * never stops the rest from registering.
 */
export async function registerWebhooks(ctx: AppContext): Promise<void> {
  for (const arr of ctx.config.arrs) {
    try {
      const client = ctx.clients.get(arr.name);
      if (!client) {
        throw new Error(`no ArrClient configured for instance "${arr.name}"`);
      }

      const existing = await client.listNotifications();
      if (existing.some((n) => n.name === NOTIFICATION_NAME)) {
        continue;
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

      ctx.db
        .prepare(
          `INSERT INTO managed_objects (arr_instance, kind, external_id, name, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(arr.name, 'notification', created.id, NOTIFICATION_NAME, Date.now());

      ctx.events.append({
        kind: 'webhook.registered',
        message: `Registered "${NOTIFICATION_NAME}" webhook on "${arr.name}"`,
        data: { instance: arr.name, url },
      });
    } catch (err) {
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'warn',
        message: `Failed to register webhook on "${arr.name}": ${err instanceof Error ? err.message : String(err)}`,
        data: { instance: arr.name },
      });
    }
  }
}
