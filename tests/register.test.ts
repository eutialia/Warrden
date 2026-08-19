import { describe, it, expect, vi } from 'vitest';
import { registerWebhooks, registerWebhooksInBackground } from '../src/arr/register.js';
import { makeCtx, configWithArrs, fakeArrClient, ctxWithClient } from './helpers.js';
import { ManagedObjects } from '../src/db/managedObjects.js';
import { AttentionItems } from '../src/db/attention.js';
import type { ArrApi } from '../src/arr/types.js';

function managedObjectRows(ctx: ReturnType<typeof makeCtx>) {
  return ctx.db.prepare(`SELECT arr_instance, kind, external_id, name FROM managed_objects`).all();
}

describe('registerWebhooks', () => {
  it('creates the notification and records it in managed_objects when none exists', async () => {
    const client = fakeArrClient();
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await registerWebhooks(ctx);

    expect(client.createNotification).toHaveBeenCalledTimes(1);
    expect(client.createNotification).toHaveBeenCalledWith({
      name: 'Warrden',
      implementation: 'Webhook',
      configContract: 'WebhookSettings',
      fields: [
        { name: 'url', value: 'http://localhost:9797/webhooks/sonarr' },
        { name: 'method', value: 1 },
      ],
      onSeriesAdd: true,
      onMovieAdded: true,
      onDownload: true,
      onUpgrade: true,
    });
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 1, name: 'Warrden' }]);
  });

  it.each([
    { scenario: 'the arr did not report a url field at all', fields: undefined },
    { scenario: 'its url still points at us', fields: [{ name: 'url', value: 'http://localhost:9797/webhooks/sonarr' }] },
  ])(
    'skips creation but still records a pre-existing "Warrden" notification already subscribed to import events when $scenario',
    async ({ fields }) => {
      const client = fakeArrClient({
        notifications: [{ id: 7, name: 'Warrden', onSeriesAdd: true, onMovieAdded: true, onDownload: true, onUpgrade: true, fields }],
      });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

      await registerWebhooks(ctx);

      expect(client.createNotification).not.toHaveBeenCalled();
      expect(client.updateNotification).not.toHaveBeenCalled();
      expect(client.deleteNotification).not.toHaveBeenCalled();
      expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 7, name: 'Warrden' }]);
    },
  );

  it.each([
    {
      scenario: 'the instance was renamed since it registered',
      config: configWithArrs('sonarr'),
      registeredUrl: 'http://localhost:9797/webhooks/sonarr-old',
      expectedUrl: 'http://localhost:9797/webhooks/sonarr',
    },
    {
      scenario: 'server.publicUrl changed since it registered',
      config: { ...configWithArrs('sonarr'), server: { port: 9797, publicUrl: 'http://warrden.local:9797' } },
      registeredUrl: 'http://localhost:9797/webhooks/sonarr',
      expectedUrl: 'http://warrden.local:9797/webhooks/sonarr',
    },
  ])('re-points a healthy "Warrden" notification whose url is stale because $scenario', async ({ config, registeredUrl, expectedUrl }) => {
    const client = fakeArrClient({
      notifications: [
        {
          id: 7,
          name: 'Warrden',
          onSeriesAdd: true,
          onMovieAdded: true,
          onDownload: true,
          onUpgrade: true,
          fields: [{ name: 'url', value: registeredUrl }],
        },
      ],
    });
    const ctx = ctxWithClient('sonarr', client, { config });
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 7, name: 'Warrden' });

    await registerWebhooks(ctx);

    expect(client.updateNotification).toHaveBeenCalledWith({
      id: 7,
      name: 'Warrden',
      implementation: 'Webhook',
      configContract: 'WebhookSettings',
      fields: [
        { name: 'url', value: expectedUrl },
        { name: 'method', value: 1 },
      ],
      onSeriesAdd: true,
      onMovieAdded: true,
      onDownload: true,
      onUpgrade: true,
    });
    // Never torn down first: the arr keeps a webhook at every instant of the fix.
    expect(client.deleteNotification).not.toHaveBeenCalled();
    expect(client.createNotification).not.toHaveBeenCalled();
    // The arr is left POSTing to the address we actually serve, not the one it had, under
    // the SAME id it already had.
    expect(client.notifications).toEqual([
      expect.objectContaining({ id: 7, name: 'Warrden', fields: [{ name: 'url', value: expectedUrl }, { name: 'method', value: 1 }] }),
    ]);
    expect(ctx.events.list()).toContainEqual(
      expect.objectContaining({ kind: 'webhook.registered', data: expect.objectContaining({ updated: true, url: expectedUrl }) }),
    );
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 7, name: 'Warrden' }]);
  });

  const healthyNotification = { id: 7, name: 'Warrden', onSeriesAdd: true, onMovieAdded: true, onDownload: true, onUpgrade: true };
  it.each([
    { name: 'onDownload false', notification: { ...healthyNotification, onDownload: false } },
    { name: 'onUpgrade false', notification: { ...healthyNotification, onUpgrade: false } },
    // A Download-only hook (what Phase 1 registered) never delivers SeriesAdd/MovieAdded, so
    // nothing ever acquires from an arr-side add, and it used to be left standing forever.
    { name: 'onSeriesAdd absent', notification: { ...healthyNotification, onSeriesAdd: undefined } },
    { name: 'onMovieAdded false', notification: { ...healthyNotification, onMovieAdded: false } },
    { name: 'every flag absent (Phase 1 registration)', notification: { id: 7, name: 'Warrden' } },
  ])('updates a stale "Warrden" notification missing import events in place ($name)', async ({ notification }) => {
    const client = fakeArrClient({ notifications: [notification] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await registerWebhooks(ctx);

    expect(client.updateNotification).toHaveBeenCalledWith({
      id: 7,
      name: 'Warrden',
      implementation: 'Webhook',
      configContract: 'WebhookSettings',
      fields: [
        { name: 'url', value: 'http://localhost:9797/webhooks/sonarr' },
        { name: 'method', value: 1 },
      ],
      onSeriesAdd: true,
      onMovieAdded: true,
      onDownload: true,
      onUpgrade: true,
    });
    expect(client.deleteNotification).not.toHaveBeenCalled();
    expect(client.createNotification).not.toHaveBeenCalled();
    expect(ctx.events.list()).toContainEqual(
      expect.objectContaining({ kind: 'webhook.registered', data: expect.objectContaining({ updated: true }) }),
    );
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 7, name: 'Warrden' }]);
  });

  it('raises attention (and leaves the existing notification standing) when the in-place update fails', async () => {
    const client = fakeArrClient({ notifications: [{ id: 7, name: 'Warrden' }] });
    client.updateNotification = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await registerWebhooks(ctx);

    expect(client.deleteNotification).not.toHaveBeenCalled();
    expect(client.notifications).toEqual([{ id: 7, name: 'Warrden' }]);

    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr', dedupeKey: 'sonarr' } });
    expect(attentionEvents[0]!.message).toContain('ECONNREFUSED');
    expect(new AttentionItems(ctx.db).list({ status: 'open' })).toHaveLength(1);
  });

  it('collapses a failure that repeats across passes into ONE open attention row per instance', async () => {
    const broken = fakeArrClient();
    broken.listNotifications = async () => {
      throw new Error('ECONNREFUSED');
    };
    const alsoBroken = fakeArrClient();
    alsoBroken.listNotifications = async () => {
      throw new Error('ETIMEDOUT');
    };
    const ctx = makeCtx({
      config: configWithArrs('sonarr', 'radarr'),
      clients: new Map<string, ArrApi>([
        ['sonarr', broken],
        ['radarr', alsoBroken],
      ]),
    });

    await registerWebhooks(ctx);
    await registerWebhooks(ctx);
    await registerWebhooks(ctx);

    // Every pass logs its own event (the log is history), but the operator sees one open
    // item per still-broken instance rather than one per restart.
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(6);
    const openRows = new AttentionItems(ctx.db).list({ status: 'open' });
    expect(openRows).toHaveLength(2);
    expect(openRows.map((r) => r.data.instance).sort()).toEqual(['radarr', 'sonarr']);
  });

  it('raises attention and continues to the next instance when an arr call throws', async () => {
    const broken = fakeArrClient();
    broken.listNotifications = async () => {
      throw new Error('ECONNREFUSED');
    };
    const healthy = fakeArrClient();
    const ctx = makeCtx({
      config: configWithArrs('sonarr', 'radarr'),
      clients: new Map<string, ArrApi>([
        ['sonarr', broken],
        ['radarr', healthy],
      ]),
    });

    await registerWebhooks(ctx);

    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr' } });
    expect(attentionEvents[0]!.message).toContain('ECONNREFUSED');
    // The broken instance didn't stop radarr from registering.
    expect(healthy.createNotification).toHaveBeenCalledTimes(1);
  });

  it('raises attention when there is no notification to update and the create fails', async () => {
    const client = fakeArrClient();
    client.createNotification = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    await registerWebhooks(ctx);

    // One attempt, no retry: nothing was torn down, so the next pass is the retry.
    expect(client.createNotification).toHaveBeenCalledTimes(1);
    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr', dedupeKey: 'sonarr' } });
    expect(managedObjectRows(ctx)).toEqual([]);
  });

  it('stays at warn, not attention, when no ArrClient is configured for an instance', async () => {
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map() });

    await registerWebhooks(ctx);

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr' } });
    // A config gap, not a webhook Warrden lost: nothing for the Attention view to chase.
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(0);
    expect(new AttentionItems(ctx.db).list({ status: 'open' })).toHaveLength(0);
    expect(managedObjectRows(ctx)).toEqual([]);
  });
});

describe('registerWebhooksInBackground', () => {
  it('serializes passes, so two rapid saves cannot interleave list-then-create into a double registration', async () => {
    const client = fakeArrClient();
    let listed = 0;
    let release: (() => void) | undefined;
    client.listNotifications = async () => {
      listed++;
      // The first pass parks here until the test releases it. If the two passes were allowed
      // to run concurrently, the second would list an empty store and create a duplicate.
      if (listed === 1) await new Promise<void>((resolve) => (release = resolve));
      return [...client.notifications];
    };
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

    registerWebhooksInBackground(ctx);
    await vi.waitFor(() => expect(listed).toBe(1));

    registerWebhooksInBackground(ctx);
    expect(listed).toBe(1); // parked behind the first pass rather than racing it

    release!();
    await vi.waitFor(() => expect(listed).toBe(2));

    // The queued pass ran only after the first settled, found the webhook it had created,
    // and left it alone.
    expect(client.createNotification).toHaveBeenCalledTimes(1);
    expect(client.notifications).toHaveLength(1);
  });
});
