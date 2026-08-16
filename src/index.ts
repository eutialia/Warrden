import { serve } from '@hono/node-server';
import { ArrClient } from './arr/client.js';
import { registerWebhooks } from './arr/register.js';
import type { ArrApi } from './arr/types.js';
import { loadConfig, resolveDataDir } from './config/store.js';
import type { AppContext } from './context.js';
import { openDb } from './db/db.js';
import { EventLog } from './events/log.js';
import { JobQueue } from './jobs/queue.js';
import { startRunner } from './jobs/runner.js';
import { AiSdkGenerator } from './llm/generator.js';
import { CliMediaTools } from './media/tools.js';
import { runAcquireJob } from './pipelines/acquire/run.js';
import { runIngestJob } from './pipelines/ingest/run.js';
import { runSubtitleJob } from './pipelines/subtitle/run.js';
import { createApp } from './server/app.js';
import { SqlTracer } from './trace/tracer.js';
import { reclaimAbandonedJobs, scheduleEventPrune, scheduleReconcile } from './startup.js';
import { errorMessage } from './util/errors.js';

/** Builds the fully-wired `AppContext` for a fresh process: config, db, one `ArrClient`
 * per configured instance, and the shared queue/event-log/LLM singletons everything else
 * is handed. Pulled out of `main()` so startup reads as a short list of steps rather than
 * a wall of construction code ahead of them. */
function buildContext(dataDir: string): AppContext {
  const config = loadConfig(dataDir);
  const db = openDb(dataDir);
  const clients = new Map<string, ArrApi>(config.arrs.map((arr) => [arr.name, new ArrClient(arr)]));
  const events = new EventLog(db);
  // The closure reads `ctx.config.debug.enabled` live, so flipping the config toggle at
  // runtime (no restart) takes effect immediately. Safe despite referencing `ctx` before
  // it's assigned: the closure only runs once tracing is invoked, well after this
  // function returns and `ctx` is fully initialized.
  const trace = new SqlTracer(db, events, () => ctx.config.debug.enabled);

  const ctx: AppContext = {
    db,
    config,
    dataDir,
    queue: new JobQueue(db),
    events,
    clients,
    llm: new AiSdkGenerator(config),
    trace,
    media: new CliMediaTools(),
  };
  return ctx;
}

/** Fires `registerWebhooks` in the background rather than blocking startup on it — a slow
 * or unreachable arr instance would otherwise delay the HTTP server (and every other arr's
 * own webhook registration) coming up at all. `registerWebhooks` already isolates
 * per-instance failures internally; this `catch` is the last-resort net for anything that
 * still escapes it, reported as a `warn` event (rather than `console.error`, so it's
 * visible on the dashboard like every other startup/background failure). */
function registerWebhooksInBackground(ctx: AppContext): void {
  registerWebhooks(ctx).catch((err: unknown) => {
    ctx.events.append({
      kind: 'webhook.register-crashed',
      level: 'warn',
      message: `Webhook registration threw unexpectedly: ${errorMessage(err)}`,
    });
  });
}

async function main(): Promise<void> {
  const ctx = buildContext(resolveDataDir());

  reclaimAbandonedJobs(ctx);

  const stopRunner = startRunner(ctx, { acquire: runAcquireJob, ingest: runIngestJob, subtitle: runSubtitleJob });
  const stopReconcile = scheduleReconcile(ctx);
  const stopEventPrune = scheduleEventPrune(ctx);

  const server = serve({ fetch: createApp(ctx).fetch, port: ctx.config.server.port }, () => {
    console.log(`warrden listening on port ${ctx.config.server.port}`);
  });

  // After serve() so a slow/unreachable arr can never delay the server (and dashboard)
  // coming up — fire-and-forget, not awaited.
  registerWebhooksInBackground(ctx);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    stopRunner();
    stopReconcile();
    stopEventPrune();
    // Belt-and-suspenders: closeAllConnections() below should make close()'s callback
    // fire promptly, but if something still hangs (e.g. a slow db.close()), don't let a
    // supervisor's SIGKILL be the only way out — exit on our own after a grace period.
    setTimeout(() => process.exit(1), 5000).unref();
    server.close(() => {
      ctx.db.close();
      process.exit(0);
    });
    // `close()`'s callback above only fires once every open socket closes, and the SSE
    // stream (/api/events/stream) holds its connection open indefinitely — without this,
    // shutdown would hang forever with a dashboard tab left open. `closeAllConnections`
    // isn't in the `Http2SecureServer` arm of @hono/node-server's `ServerType` union
    // (we never construct one — `serve()` is called with no TLS options), hence the cast.
    (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
