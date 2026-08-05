import { describe, it, expect, beforeEach } from 'vitest';
import { JobQueue } from '../src/jobs/queue.js';
import { freshDb } from './helpers.js';

const target = { pipeline: 'acquire', targetKind: 'series' as const, targetId: 42, arrInstance: 'sonarr' };
let q: JobQueue;
beforeEach(() => { q = new JobQueue(freshDb()); });

describe('JobQueue', () => {
  it('enqueues then coalesces duplicate pending', () => {
    expect(q.enqueue(target).outcome).toBe('enqueued');
    expect(q.enqueue(target).outcome).toBe('coalesced');
  });
  it('marks running job dirty and requeues on completion', () => {
    q.enqueue(target);
    const job = q.claim()!;
    expect(q.enqueue(target).outcome).toBe('marked-dirty');
    expect(q.complete(job.id).requeued).toBe(true);
    expect(q.claim()!.status).toBe('running'); // the requeued twin is claimable
  });
  it('does not requeue clean jobs', () => {
    q.enqueue(target);
    expect(q.complete(q.claim()!.id).requeued).toBe(false);
    expect(q.claim()).toBeNull();
  });
  it('respects not_before when claiming', () => {
    q.enqueue({ ...target, notBefore: 5_000 });
    expect(q.claim(1_000)).toBeNull();
    expect(q.claim(6_000)).not.toBeNull();
  });
  it.each([
    { attempts: 1, retried: true },
    { attempts: 2, retried: true },
    { attempts: 3, retried: false }, // maxAttempts default 3 → failed
  ])('retry/backoff: attempt $attempts → retried=$retried', ({ attempts, retried }) => {
    q.enqueue(target);
    let res!: { retried: boolean };
    for (let i = 0; i < attempts; i++) {
      const job = q.claim(Number.MAX_SAFE_INTEGER)!;
      res = q.fail(job.id, 'boom');
    }
    expect(res.retried).toBe(retried);
  });
});
