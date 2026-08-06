import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/app.js';
import { makeCtx } from './helpers.js';

describe('dashboard api', () => {
  it('lists jobs and fetches detail with acquire record', async () => {
    const ctx = makeCtx();
    ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
    const app = createApp(ctx);
    const list: any[] = await (await app.request('/api/jobs')).json();
    expect(list).toHaveLength(1);
    const detail: any = await (await app.request(`/api/jobs/${list[0].id}`)).json();
    expect(detail.job.pipeline).toBe('acquire');
    expect((await app.request('/api/jobs/999')).status).toBe(404);
  });
  it('redacts llm keys on GET and preserves them through PUT round-trip', async () => {
    const ctx = makeCtx();
    ctx.config.llm.keys.openrouter = 'sk-secret';
    const app = createApp(ctx);
    const got: any = await (await app.request('/api/config')).json();
    expect(got.llm.keys.openrouter).toBe('•••');
    const res = await app.request('/api/config', { method: 'PUT', body: JSON.stringify(got), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(ctx.config.llm.keys.openrouter).toBe('sk-secret'); // sentinel preserved the secret
  });
  it('rejects invalid config with issues', async () => {
    const ctx = makeCtx();
    const app = createApp(ctx);
    const bad = { ...ctx.config, arrs: [{ name: '', kind: 'sonarr', baseUrl: 'x', apiKey: '' }] };
    const res = await app.request('/api/config', { method: 'PUT', body: JSON.stringify(bad), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
  it('manual acquire trigger enqueues', async () => {
    const ctx = makeCtx();
    const app = createApp(ctx);
    const res = await app.request('/api/acquire', { method: 'POST', body: JSON.stringify({ arrInstance: 'sonarr', targetKind: 'series', targetId: 7 }), headers: { 'content-type': 'application/json' } });
    expect((await res.json()).outcome).toBe('enqueued');
  });
});
