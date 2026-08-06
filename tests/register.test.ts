import { describe, it, expect, vi } from 'vitest';
import { registerWebhooks } from '../src/arr/register.js';
import { makeCtx, configWithArrs, fakeArrClient } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';

function managedObjectRows(ctx: ReturnType<typeof makeCtx>) {
  return ctx.db.prepare(`SELECT arr_instance, kind, external_id, name FROM managed_objects`).all();
}

describe('registerWebhooks', () => {
  it('creates the notification and records it in managed_objects when none exists', async () => {
    const client = fakeArrClient();
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', client]]) });

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
    });
    // Phase 1 only handles "added" events — subscribing to events nothing consumes yet
    // would just mean Sonarr/Radarr fire webhooks Warrden silently drops.
    const body = (client.createNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('onDownload');
    expect(body).not.toHaveProperty('onUpgrade');
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 1, name: 'Warrden' }]);
  });

  it('skips creation but still records a pre-existing "Warrden" notification', async () => {
    const client = fakeArrClient({ notifications: [{ id: 7, name: 'Warrden' }] });
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', client]]) });

    await registerWebhooks(ctx);

    expect(client.createNotification).not.toHaveBeenCalled();
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 7, name: 'Warrden' }]);
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
