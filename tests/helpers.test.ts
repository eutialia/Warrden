import { describe, it, expect } from 'vitest';
import { freshDb, makeCtx } from './helpers.js';

describe('makeCtx', () => {
  it('builds queue/events on a provided db override, not a second orphan db', () => {
    const db = freshDb();
    const ctx = makeCtx({ db });

    ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 1, arrInstance: 'sonarr' });
    ctx.events.append({ kind: 'test', message: 'hello' });

    // Read back through the caller's own db handle, independent of ctx.queue/ctx.events.
    expect(db.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 1 });
  });
});
