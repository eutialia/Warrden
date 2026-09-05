import type { AppContext } from '../context.js';
import { AttentionItems } from '../db/attention.js';
import { ManagedObjects } from '../db/managedObjects.js';
import type { ArrApi, NotificationSummary } from './types.js';
import { errorMessage } from '../util/errors.js';
import { webhookFailureDetail } from './webhookError.js';

export const NOTIFICATION_NAME = 'Warrden';

/** Only the parts of AppContext registration actually reads, the same idiom as
 * `HandleWebhookCtx` in `webhooks.ts`, so the config route can hand it the fields it has
 * gated on without an `as AppContext` cast. */
type RegisterCtx = Pick<AppContext, 'db' | 'config' | 'clients' | 'events'>;

/** The address an existing notification is currently POSTing to, or `undefined` when the arr
 * didn't return the field at all. Absent is stale: we cannot prove the hook points at us. */
function notificationUrl(notification: NotificationSummary): string | undefined {
  const field = notification.fields?.find((f) => f.name === 'url');
  return typeof field?.value === 'string' ? field.value : undefined;
}

export type ArrWebhookStatus = 'ok' | 'missing' | 'stale' | 'unknown';

/**
 * Live arr notification vs the URL we currently serve. Checks every flag this app actually
 * has, not every flag the registration body sends: a hook subscribed to Download alone still
 * delivers nothing on the add event, so treating it as healthy left it standing forever and no
 * arr-side add ever reached Warrden. The notification resource is per-app though, so Sonarr
 * echoes `onSeriesAdd` and never `onMovieAdded` and Radarr the reverse; demanding both would
 * make the predicate permanently false and re-PUT an already-correct webhook on every pass.
 * Missing `url` is stale, same as one pointing elsewhere: we cannot prove the hook points at
 * us, so a skip would leave Settings showing Webhook failed forever.
 */
export function classifyWebhook(
  found: NotificationSummary | undefined,
  kind: 'sonarr' | 'radarr',
  url: string,
): Exclude<ArrWebhookStatus, 'unknown'> {
  if (!found) return 'missing';
  const registeredUrl = notificationUrl(found);
  const addEvent = kind === 'sonarr' ? found.onSeriesAdd : found.onMovieAdded;
  const subscribedToAll = addEvent === true && found.onDownload === true && found.onUpgrade === true;
  if (!subscribedToAll || registeredUrl !== url) return 'stale';
  return 'ok';
}

export async function probeWebhook(client: ArrApi, kind: 'sonarr' | 'radarr', url: string): Promise<ArrWebhookStatus> {
  try {
    const existing = await client.listNotifications();
    const found = existing.find((n) => n.name === NOTIFICATION_NAME);
    return classifyWebhook(found, kind, url);
  } catch {
    return 'unknown';
  }
}

export type WebhookRegisterStatus = 'created' | 'updated' | 'skipped' | 'failed';

export interface WebhookRegisterResult {
  instance: string;
  status: WebhookRegisterStatus;
  url: string;
  error?: string;
}

/**
 * Self-registers the Warrden webhook notification on every configured arr instance that
 * doesn't already have a correct one: create when absent, PUT in place when present but
 * wrong. Idempotent (checks by name first) and fault-tolerant: an instance that errors
 * raises its own attention item and is skipped, it never stops the rest from registering.
 * `force` PUTs even a healthy match, so Re-check can steal the hook for this process.
 */
export async function registerWebhooks(ctx: RegisterCtx, opts?: { force?: boolean }): Promise<WebhookRegisterResult[]> {
  const managedObjects = new ManagedObjects(ctx.db);
  const attention = new AttentionItems(ctx.db);
  const force = opts?.force === true;
  const results: WebhookRegisterResult[] = [];

  for (const arr of ctx.config.arrs) {
    const url = `${ctx.config.server.publicUrl}/webhooks/${arr.name}`;
    const client = ctx.clients.get(arr.name);
    if (!client) {
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'warn',
        message: `Failed to register webhook on "${arr.name}": no ArrClient configured`,
        data: { instance: arr.name },
      });
      results.push({ instance: arr.name, status: 'failed', url, error: 'no ArrClient configured' });
      continue;
    }

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
        if (!force && classifyWebhook(found, arr.kind, url) === 'ok') {
          // Already present in the arr and subscribed to everything we need, but the
          // local registry may have been reset (fresh db, restore) — re-record it so
          // GC (reconcile.ts's gc()) can still find it.
          managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: found.id, name: NOTIFICATION_NAME });
          resolveRegisterFailure(attention, arr.name);
          results.push({ instance: arr.name, status: 'skipped', url });
          continue;
        }
        // Missing import events (a Phase 1 registration), or pointing at an address that
        // isn't ours any more: PUT our own known-good body over the id it already has.
        // Never delete-then-create: a create that doesn't land after the delete did
        // leaves the arr with NO webhook (a live run lost 22 minutes of events that way),
        // whereas a failed PUT leaves the old, wrong-but-present notification standing.
        const updated = await client.updateNotification({ ...body, id: found.id });
        managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: updated.id, name: NOTIFICATION_NAME });
        resolveRegisterFailure(attention, arr.name);
        ctx.events.append({
          kind: 'webhook.registered',
          message: `Updated the "${NOTIFICATION_NAME}" webhook on "${arr.name}" in place`,
          data: { instance: arr.name, url, updated: true },
        });
        results.push({ instance: arr.name, status: 'updated', url });
        continue;
      }

      const created = await client.createNotification(body);
      managedObjects.insert({ arrInstance: arr.name, kind: 'notification', externalId: created.id, name: NOTIFICATION_NAME });
      resolveRegisterFailure(attention, arr.name);

      ctx.events.append({
        kind: 'webhook.registered',
        message: `Registered "${NOTIFICATION_NAME}" webhook on "${arr.name}"`,
        data: { instance: arr.name, url },
      });
      results.push({ instance: arr.name, status: 'created', url });
    } catch (err) {
      // Attention, not warn: every path that lands here ends with the instance having no
      // webhook we can vouch for, and the symptom (nothing ever arrives from this arr) is
      // invisible until someone goes looking. `targetKind`/`targetId` are what
      // `AttentionItems.open` actually dedupes on, so a failure that repeats every startup
      // refreshes one open row per instance instead of piling up a new one per pass.
      const error = webhookFailureDetail(err, url);
      ctx.events.append({
        kind: 'webhook.register-failed',
        level: 'attention',
        message: `Failed to register the Warrden webhook on "${arr.name}": ${error}`,
        data: { instance: arr.name, targetKind: 'notification', targetId: NOTIFICATION_NAME, dedupeKey: arr.name },
      });
      results.push({ instance: arr.name, status: 'failed', url, error });
    }
  }
  return results;
}

function resolveRegisterFailure(attention: AttentionItems, instance: string): void {
  attention.resolveForTarget({
    kinds: ['webhook.register-failed'],
    instance,
    targetKind: 'notification',
    targetId: NOTIFICATION_NAME,
    dedupeKey: instance,
  });
}

// One pass at a time so two callers cannot interleave list-then-create into a duplicate
// webhook. Every enqueued pass still runs, including a force Re-check behind a save.
let draining = false;
const registerJobs: Array<{
  ctx: RegisterCtx;
  force: boolean;
  resolve: (results: WebhookRegisterResult[]) => void;
}> = [];

/** Fires `registerWebhooks` in the background rather than blocking its caller on it: a
 * slow or unreachable arr instance would otherwise delay the HTTP server coming up at
 * startup (and, on a config save, the response to the operator's own PUT), plus every
 * other arr's registration behind it. Passes are serialized (see above); the caller gets
 * no handle either way, so a queued pass is indistinguishable from an immediate one. */
export function registerWebhooksInBackground(ctx: RegisterCtx): void {
  void enqueueRegister(ctx, false);
}

/** Same queue as the background path, but the caller waits. Used by Re-check so the
 * response carries this pass's per-instance results instead of racing a fire-and-forget. */
export function registerWebhooksNow(ctx: RegisterCtx, opts?: { force?: boolean }): Promise<WebhookRegisterResult[]> {
  return enqueueRegister(ctx, opts?.force === true);
}

function enqueueRegister(ctx: RegisterCtx, force: boolean): Promise<WebhookRegisterResult[]> {
  return new Promise((resolve) => {
    registerJobs.push({ ctx, force, resolve });
    if (draining) return;
    draining = true;
    void drainQueue();
  });
}

/** `registerWebhooks` already isolates per-instance failures internally; the `catch` here is
 * the last-resort net for anything that still escapes it, reported as a `warn` event (rather
 * than `console.error`, so it's visible on the dashboard like every other background
 * failure) and never allowed to stall the queue behind it. */
async function drainQueue(): Promise<void> {
  try {
    while (registerJobs.length > 0) {
      const job = registerJobs.shift();
      if (!job) break;
      try {
        job.resolve(await registerWebhooks(job.ctx, { force: job.force }));
      } catch (err) {
        job.ctx.events.append({
          kind: 'webhook.register-crashed',
          level: 'warn',
          message: `Webhook registration threw unexpectedly: ${errorMessage(err)}`,
        });
        job.resolve([]);
      }
    }
  } finally {
    // Same synchronous turn as the loop's own exit check, so a caller can never slip in
    // between "nothing queued" and "not draining" and have its pass dropped.
    draining = false;
  }
}
