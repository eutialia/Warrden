import type Database from 'better-sqlite3';
import type { ArrClient } from './arr/client.js';
import type { Config } from './config/schema.js';
import type { EventLog } from './events/log.js';
import type { JobQueue } from './jobs/queue.js';

// grows as later tasks add more fields (llm generator, ...)
export interface AppContext {
  db: Database.Database;
  config: Config;
  queue: JobQueue;
  events: EventLog;
  // keyed by ArrInstance.name
  clients: Map<string, ArrClient>;
}
