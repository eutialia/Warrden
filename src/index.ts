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
import { runAcquireJob } from './pipelines/acquire/run.js';
import { reconcile } from './reconcile/reconcile.js';
import { createApp } from './server/app.js';

/** Builds the fully-wired `AppContext` for a fresh process: config, db, one `ArrClient`
 * per configured instance, and the shared queue/event-log/LLM singletons everything else
 * is handed. Pulled out of `main()` so startup reads as a short list of steps rather than
 * a wall of construction code ahead of them. */
function buildContext(dataDir: string): AppContext {
  const config = loadConfig(dataDir);
  const db = openDb(dataDir);
  const clients = new Map<string, ArrApi>(config.arrs.map((arr) => [arr.name, new ArrClient(arr)]));

  return {
    db,
    config,
    queue: new JobQueue(db),
    events: new EventLog(db),
    clients,
    llm: new AiSdkGenerator(config),
  };
}

/** Resets any job left `running` by a crashed previous process so it's claimable again,
 * reporting how many (if any) via the event log. */
function reclaimAbandonedJobs(ctx: AppContext): void {
  const reclaimed = ctx.queue.reclaimAbandoned();
  if (reclaimed > 0) {
    ctx.events.append({
      kind: 'jobs.reclaimed',
      level: 'warn',
      message: `Reclaimed ${reclaimed} job(s) left "running" by a previous, presumably crashed, run`,
      data: { count: reclaimed },
    });
  }
}

/** Runs `reconcile()` once immediately, then on `reconcileIntervalMinutes`. `reconcile`
 * already isolates per-instance failures internally, but this is the last-resort net for
 * anything that still escapes it (e.g. a `managed_objects`/`sync_state` query failing
 * outright) — reconciliation is background maintenance, never worth crashing the process
 * over. Returns a stop function that clears the interval. */
function scheduleReconcile(ctx: AppContext): () => void {
  const runOnce = (): void => {
    reconcile(ctx).catch((err: unknown) => {
      ctx.events.append({
        kind: 'reconcile.crashed',
        level: 'warn',
        message: `Reconciliation pass threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  };
  runOnce();
  const interval = setInterval(runOnce, ctx.config.reconcileIntervalMinutes * 60_000);
  return () => clearInterval(interval);
}

async function main(): Promise<void> {
  const ctx = buildContext(resolveDataDir());

  try {
    await registerWebhooks(ctx);
  } catch (err) {
    // registerWebhooks already logs and continues per-instance internally; this is a
    // last-resort net so a bug in that loop can't take the rest of startup down with it.
    console.error('registerWebhooks failed at startup', err);
  }

  reclaimAbandonedJobs(ctx);

  const stopRunner = startRunner(ctx, { acquire: runAcquireJob });
  const stopReconcile = scheduleReconcile(ctx);

  const server = serve({ fetch: createApp(ctx).fetch, port: ctx.config.server.port }, () => {
    console.log(`warrden listening on port ${ctx.config.server.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    stopRunner();
    stopReconcile();
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
