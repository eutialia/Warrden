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
import { createApp } from './server/app.js';

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const config = loadConfig(dataDir);
  const db = openDb(dataDir);

  const clients = new Map<string, ArrApi>(config.arrs.map((arr) => [arr.name, new ArrClient(arr)]));

  const ctx: AppContext = {
    db,
    config,
    queue: new JobQueue(db),
    events: new EventLog(db),
    clients,
    llm: new AiSdkGenerator(config),
  };

  try {
    await registerWebhooks(ctx);
  } catch (err) {
    // registerWebhooks already logs and continues per-instance internally; this is a
    // last-resort net so a bug in that loop can't take the rest of startup down with it.
    console.error('registerWebhooks failed at startup', err);
  }

  const stopRunner = startRunner(ctx, { acquire: runAcquireJob });

  const server = serve({ fetch: createApp(ctx).fetch, port: ctx.config.server.port }, () => {
    console.log(`warrden listening on port ${ctx.config.server.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    stopRunner();
    server.close(() => {
      db.close();
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
