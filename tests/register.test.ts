import { describe, it, expect, vi } from 'vitest';
import { registerWebhooks, registerWebhooksInBackground } from '../src/arr/register.js';
import { makeCtx, configWithArrs, fakeArrClient, ctxWithClient } from './helpers.js';
import { ManagedObjects } from '../src/db/managedObjects.js';
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
      const client = fakeArrClient({ notifications: [{ id: 7, name: 'Warrden', onDownload: true, onUpgrade: true, fields }] });
      const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });

      await registerWebhooks(ctx);

      expect(client.createNotification).not.toHaveBeenCalled();
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
      notifications: [{ id: 7, name: 'Warrden', onDownload: true, onUpgrade: true, fields: [{ name: 'url', value: registeredUrl }] }],
    });
    const ctx = ctxWithClient('sonarr', client, { config });
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 7, name: 'Warrden' });

    await registerWebhooks(ctx);

    expect(client.deleteNotification).toHaveBeenCalledWith(7);
    // The arr is left POSTing to the address we actually serve, not the one it had.
    expect(client.notifications).toEqual([
      expect.objectContaining({ id: 1, name: 'Warrden', fields: [{ name: 'url', value: expectedUrl }, { name: 'method', value: 1 }] }),
    ]);
    expect(ctx.events.list()).toContainEqual(
      expect.objectContaining({ kind: 'webhook.registered', data: expect.objectContaining({ recreated: true, url: expectedUrl }) }),
    );
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 1, name: 'Warrden' }]);
  });

  it.each([
    { name: 'onDownload false', notification: { id: 7, name: 'Warrden', onDownload: false, onUpgrade: true } },
    { name: 'onUpgrade false', notification: { id: 7, name: 'Warrden', onDownload: true, onUpgrade: false } },
    { name: 'both absent (Phase 1 registration)', notification: { id: 7, name: 'Warrden' } },
  ])('recreates a stale "Warrden" notification missing import events ($name)', async ({ notification }) => {
    const client = fakeArrClient({ notifications: [notification] });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    // Seed the registry with the OLD notification's row up front, as a real Phase 1
    // install would have it — otherwise the `managedObjects.delete` call in the recreate
    // path has nothing to delete and this test can't tell it apart from a no-op.
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 7, name: 'Warrden' });

    await registerWebhooks(ctx);

    expect(client.deleteNotification).toHaveBeenCalledWith(7);
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
    const events = ctx.events.list();
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'webhook.registered', data: expect.objectContaining({ recreated: true }) }),
    );
    // The old (id 7) row is gone from the registry, replaced by the newly created one —
    // and ONLY the new one: no leftover row from the seeded id 7.
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 1, name: 'Warrden' }]);
  });

  it('a create that fails on our end but actually committed server-side is detected via re-list — no duplicate create call, the found row is recorded', async () => {
    const client = fakeArrClient({ notifications: [{ id: 7, name: 'Warrden' }] }); // stale -> triggers the recreate path
    let createCalls = 0;
    client.createNotification = vi.fn(async () => {
      createCalls++;
      // Simulates a response lost after the arr committed the write: the store gains the
      // row, but this call still throws to its own caller.
      const committed = { id: 99, name: 'Warrden', onDownload: true, onUpgrade: true };
      client.notifications.push(committed);
      throw new Error('ETIMEDOUT');
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 7, name: 'Warrden' });

    await registerWebhooks(ctx);

    expect(createCalls).toBe(1); // no blind second create — the re-list found the committed row
    expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 99, name: 'Warrden' }]);
  });

  it('reports a recreate-failure — not a generic register-failure — when the replacement create fails twice after the old notification was already deleted', async () => {
    const client = fakeArrClient({ notifications: [{ id: 7, name: 'Warrden' }] });
    client.createNotification = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    new ManagedObjects(ctx.db).insert({ arrInstance: 'sonarr', kind: 'notification', externalId: 7, name: 'Warrden' });

    await registerWebhooks(ctx);

    expect(client.deleteNotification).toHaveBeenCalledWith(7);
    // Retried exactly once: the initial attempt plus one retry, no more.
    expect(client.createNotification).toHaveBeenCalledTimes(2);

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]).toMatchObject({ kind: 'webhook.recreate-failed', data: { instance: 'sonarr', oldId: 7 } });
    expect(warnEvents[0]!.message).toContain('no Warrden webhook');
    // The old row was deleted and no new one was ever created — the registry has none.
    expect(managedObjectRows(ctx)).toEqual([]);
  });

  it('logs a warn event and continues to the next instance when an arr call throws', async () => {
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

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr' } });
    expect(warnEvents[0]!.message).toContain('ECONNREFUSED');
    // The broken instance didn't stop radarr from registering.
    expect(healthy.createNotification).toHaveBeenCalledTimes(1);
  });

  it('logs a warn event and continues when no ArrClient is configured for an instance', async () => {
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map() });

    await registerWebhooks(ctx);

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]).toMatchObject({ kind: 'webhook.register-failed', data: { instance: 'sonarr' } });
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
