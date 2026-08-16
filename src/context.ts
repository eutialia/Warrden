import type Database from 'better-sqlite3';
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
