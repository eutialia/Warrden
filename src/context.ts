import type Database from 'better-sqlite3';
import { ArrClient } from './arr/client.js';
import type { ArrApi } from './arr/types.js';
import type { Config } from './config/schema.js';
import type { EventLog } from './events/log.js';
import type { JobQueue } from './jobs/queue.js';
import type { ModelCatalog } from './llm/catalog.js';
import type { StructuredGenerator } from './llm/generator.js';
import type { MediaTools } from './media/tools.js';
import type { SearchCache } from './pipelines/acquire/searchCache.js';
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
  // The one OpenRouter model catalog, shared between the picker route and the generator that
  // reads each model's capabilities off it: a second instance would be a second cold cache and
  // a second fetch of the same 400-model list. Optional so a `Partial<AppContext>` test that
  // only exercises the route still gets one built for it in `createApp`.
  catalog?: ModelCatalog;
  // Process-wide so a job's retry (a different runner tick, same process) can still see what
  // its previous run already searched, instead of re-sweeping every indexer for it.
  searchCache: SearchCache;
  trace: Tracer;
  // External media binaries (ffprobe/alass/ffsubsync) behind one seam — production wires
  // CliMediaTools, tests inject a fake. Optional so existing Partial<AppContext> call
  // sites (createApp routes) stay valid; pipeline code that needs it asserts its presence.
  media?: MediaTools;
  // Directory the dashboard's built assets (`index.html` + `assets/`) live in, served by
  // `createApp`. Injectable (rather than a module-level constant resolved off
  // `import.meta.url`) so tests can point it at a small fixture dir instead of the real
  // `web/dist`. Three states: omitted takes the real build's location, which is what
  // production wants; a path serves that path; `null` serves no dashboard at all, for
  // `npm run dev:all` where vite owns the UI and the built copy here would only be a
  // staler second dashboard to confuse yourself with.
  webDistDir?: string | null;
}

/**
 * Points `ctx` at `next`: the config itself, plus a freshly built `ArrClient` per
 * configured instance. The single place `ctx.clients` is (re)built: startup calls it once
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
