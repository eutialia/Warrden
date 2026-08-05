import { describe, it, expect } from 'vitest';
import { registerWebhooks } from '../src/arr/register.js';
import { makeCtx, configWithArrs } from './helpers.js';
import type {
  ArrApi,
  MovieResource,
  NotificationSummary,
  ReleaseCandidate,
  ReleaseProfileResource,
  SeriesResource,
  TagResource,
} from '../src/arr/types.js';

function unimplemented(): never {
  throw new Error('not implemented in FakeArrClient');
}

/** Minimal ArrApi fake — only listNotifications/createNotification are exercised by registerWebhooks. */
class FakeArrClient implements ArrApi {
  createdNotifications: object[] = [];
  private nextId = 100;

  constructor(
    public notifications: NotificationSummary[] = [],
    private readonly failListWith?: Error,
  ) {}

  async listNotifications(): Promise<NotificationSummary[]> {
    if (this.failListWith) throw this.failListWith;
    return this.notifications;
  }

  async createNotification(body: object): Promise<NotificationSummary> {
    this.createdNotifications.push(body);
    const created = { id: this.nextId++, name: (body as { name: string }).name };
    this.notifications.push(created);
    return created;
  }

  systemStatus(): Promise<unknown> {
    return unimplemented();
  }
  listSeries(): Promise<SeriesResource[]> {
    return unimplemented();
  }
  listMovies(): Promise<MovieResource[]> {
    return unimplemented();
  }
  getSeries(): Promise<SeriesResource> {
    return unimplemented();
  }
  updateSeries(): Promise<SeriesResource> {
    return unimplemented();
  }
  searchReleases(): Promise<ReleaseCandidate[]> {
    return unimplemented();
  }
  grabRelease(): Promise<void> {
    return unimplemented();
  }
  listTags(): Promise<TagResource[]> {
    return unimplemented();
  }
  createTag(): Promise<TagResource> {
    return unimplemented();
  }
  deleteTag(): Promise<void> {
    return unimplemented();
  }
  listReleaseProfiles(): Promise<ReleaseProfileResource[]> {
    return unimplemented();
  }
  createReleaseProfile(): Promise<ReleaseProfileResource> {
    return unimplemented();
  }
  deleteReleaseProfile(): Promise<void> {
    return unimplemented();
  }
  deleteNotification(): Promise<void> {
    return unimplemented();
  }
}

function managedObjectRows(ctx: ReturnType<typeof makeCtx>) {
  return ctx.db.prepare(`SELECT arr_instance, kind, external_id, name FROM managed_objects`).all();
}

describe('registerWebhooks', () => {
  it('creates the notification and records it in managed_objects when none exists', async () => {
    const client = new FakeArrClient([]);
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', client]]) });

    await registerWebhooks(ctx);

    expect(client.createdNotifications).toEqual([
      {
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
      },
    ]);
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 100, name: 'Warrden' }]);
  });

  it('skips creation but still records a pre-existing "Warrden" notification', async () => {
    const client = new FakeArrClient([{ id: 7, name: 'Warrden' }]);
    const ctx = makeCtx({ config: configWithArrs('sonarr'), clients: new Map([['sonarr', client]]) });

    await registerWebhooks(ctx);

    expect(client.createdNotifications).toEqual([]);
    expect(managedObjectRows(ctx)).toEqual([{ arr_instance: 'sonarr', kind: 'notification', external_id: 7, name: 'Warrden' }]);
  });

  it('logs a warn event and continues to the next instance when an arr call throws', async () => {
    const broken = new FakeArrClient([], new Error('ECONNREFUSED'));
    const healthy = new FakeArrClient([]);
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
    expect(healthy.createdNotifications).toHaveLength(1);
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
