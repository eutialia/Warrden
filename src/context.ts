import type Database from 'better-sqlite3';
import { ArrClient } from './arr/client.js';
import type { ArrApi } from './arr/types.js';
import type { Config } from './config/schema.js';
import type { EventLog } from './events/log.js';
import type { JobQueue } from './jobs/queue.js';
import type { StructuredGenerator } from './llm/generator.js';
import type { MediaTools } from './media/tools.js';
import type { Tracer } from './trace/tracer.js';

// grows as later tasks add more fields
export interface AppContext {
  db: Database.Database;
  config: Config;
  // where config.json (and, via `openDb`, warrden.db) lives — PUT /api/config needs it to persist
  dataDir: string;
  queue: JobQueue;
  events: EventLog;
  // keyed by ArrInstance.name; ArrApi (not the concrete ArrClient) so fakes plug in directly
  clients: Map<string, ArrApi>;
  llm: StructuredGenerator;
  trace: Tracer;
  // External media binaries (ffprobe/alass/ffsubsync) behind one seam — production wires
  // CliMediaTools, tests inject a fake. Optional so existing Partial<AppContext> call
  // sites (createApp routes) stay valid; pipeline code that needs it asserts its presence.
  media?: MediaTools;
  // Directory the dashboard's built assets (`index.html` + `assets/`) live in, served by
  // `createApp` when present. Optional and injectable (rather than a module-level constant
  // resolved off `import.meta.url`) so tests can point it at a small fixture dir instead of
  // the real `web/dist` — production just omits it and gets the real build's location.
  webDistDir?: string;
}

/**
 * Points `ctx` at `next`: the config itself, plus a freshly built `ArrClient` per
 * configured instance. The single place `ctx.clients` is (re)built — startup calls it once
 * and `PUT /api/config` calls it on every save, so an added, renamed, re-keyed or removed
 * arr instance is live the moment it's saved instead of waiting for a restart. Everything
 * else reads `ctx.config` live already, so swapping the reference here is all they need.
 *
 * Takes a `Partial<AppContext>` for the same reason `createApp` does: the config route's
 * `ctx` is that type, and widening here beats an `as AppContext` cast at the call site.
 */
export function applyConfig(ctx: Partial<AppContext>, next: Config): void {
  ctx.config = next;
  ctx.clients = new Map<string, ArrApi>(next.arrs.map((arr) => [arr.name, new ArrClient(arr)]));
}
