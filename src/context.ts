import type Database from 'better-sqlite3';
import type { ArrApi } from './arr/types.js';
import type { Config } from './config/schema.js';
import type { EventLog } from './events/log.js';
import type { JobQueue } from './jobs/queue.js';
import type { StructuredGenerator } from './llm/generator.js';

// grows as later tasks add more fields
export interface AppContext {
  db: Database.Database;
  config: Config;
  queue: JobQueue;
  events: EventLog;
  // keyed by ArrInstance.name; ArrApi (not the concrete ArrClient) so fakes plug in directly
  clients: Map<string, ArrApi>;
  llm: StructuredGenerator;
}
