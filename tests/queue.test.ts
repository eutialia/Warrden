import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobQueue } from '../src/jobs/queue.js';
import { freshDb } from './helpers.js';

const target = { pipeline: 'acquire', targetKind: 'series' as const, targetId: 42, arrInstance: 'sonarr' };
let q: JobQueue;
beforeEach(() => { q = new JobQueue(freshDb()); });

describe('JobQueue', () => {
  it('enqueues then coalesces duplicate pending', () => {
    const first = q.enqueue(target);
    expect(first.outcome).toBe('enqueued');
    const second = q.enqueue(target);
    expect(second.outcome).toBe('coalesced');
    expect(second.id).toBe(first.id); // coalesced reports the existing twin's id, not null
  });
  it('marks running job dirty and requeues on completion', () => {
    const first = q.enqueue(target);
    const job = q.claim()!;
    const dirtied = q.enqueue(target);
    expect(dirtied.outcome).toBe('marked-dirty');
    expect(dirtied.id).toBe(first.id); // marked-dirty reports the running twin's id, not null
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

  it('clears dirty on retry so a later completion is not spuriously requeued', () => {
    q.enqueue(target);
    const job = q.claim()!;
    expect(q.enqueue(target).outcome).toBe('marked-dirty'); // sets dirty=1 on the running job
    expect(q.fail(job.id, 'boom').retried).toBe(true); // back to pending — dirty must be cleared here

    const retried = q.claim(Number.MAX_SAFE_INTEGER)!;
    expect(q.complete(retried.id).requeued).toBe(false); // no leftover dirty flag to trigger a requeue
    expect(q.claim()).toBeNull(); // and no extra pending row was created
  });

  describe('fail() backoff delay (fake timers for exact not_before values)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('defaults not_before to now + 60_000ms x attempts', () => {
      vi.setSystemTime(0);
      q.enqueue(target);
      const job1 = q.claim()!;
      q.fail(job1.id, 'boom'); // attempts=1
      expect(q.get(job1.id)!.not_before).toBe(60_000);

      vi.setSystemTime(1_000);
      const job2 = q.claim(Number.MAX_SAFE_INTEGER)!; // same row, attempts going from 1 to 2
      q.fail(job2.id, 'boom again'); // attempts=2
      expect(q.get(job2.id)!.not_before).toBe(1_000 + 60_000 * 2);
    });

    it('uses an explicit retryInMs as-is, without scaling by attempt number', () => {
      vi.setSystemTime(5_000);
      q.enqueue(target);
      const job = q.claim()!;
      q.fail(job.id, 'boom', { retryInMs: 2_000 });
      expect(q.get(job.id)!.not_before).toBe(5_000 + 2_000);
    });
  });

  it('list() returns newest first and respects limit', () => {
    const a = q.enqueue(target).id!;
    const b = q.enqueue({ ...target, targetId: 43 }).id!;
    const c = q.enqueue({ ...target, targetId: 44 }).id!;

    expect(q.list().map((j) => j.id)).toEqual([c, b, a]);
    expect(q.list({ limit: 2 }).map((j) => j.id)).toEqual([c, b]);
  });

  it('round-trips payload and result JSON through enqueue -> claim -> complete -> get', () => {
    const payload = { season: 3, reason: 'missing' };
    const result = { picked: 'release-guid-123', sizeMB: 1234 };
    const { id } = q.enqueue({ ...target, payload });

    const claimed = q.claim()!;
    expect(claimed.payload).toEqual(payload);

    q.complete(id!, result);
    const done = q.get(id!)!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual(result);
  });

  it('complete() throws when the job is not running', () => {
    const { id } = q.enqueue(target);
    expect(() => q.complete(id!)).toThrow(/not running/);
  });

  it('fail() throws when the job is not running', () => {
    const { id } = q.enqueue(target);
    expect(() => q.fail(id!, 'boom')).toThrow(/not running/);
  });

  describe('reclaimAbandoned()', () => {
    it('resets a running job back to pending (claimable again); a still-pending job elsewhere is untouched', () => {
      const abandoned = q.enqueue(target).id!; // will be claimed (-> running) then abandoned
      const stillPending = q.enqueue({ ...target, targetId: 43 }).id!;
      const job = q.claim()!; // claims `abandoned` (created first)
      expect(job.id).toBe(abandoned);

      const count = q.reclaimAbandoned();
      expect(count).toBe(1);

      expect(q.get(abandoned)!.status).toBe('pending');
      expect(q.get(abandoned)!.not_before).toBe(0);
      expect(q.get(stillPending)!.status).toBe('pending'); // was never running, untouched either way

      // The reclaimed job is claimable again — this is the actual point of reclaiming.
      // (It's created before `stillPending`, so claim() picks it up first.)
      const reclaimed = q.claim()!;
      expect(reclaimed.id).toBe(abandoned);
    });

    it('preserves attempts on the reclaimed job', () => {
      q.enqueue(target);
      const first = q.claim()!;
      q.fail(first.id, 'boom'); // attempts=1, back to pending
      const second = q.claim(Number.MAX_SAFE_INTEGER)!; // running again, attempts=1

      q.reclaimAbandoned();

      expect(q.get(second.id)!.attempts).toBe(1);
      expect(q.get(second.id)!.status).toBe('pending');
    });

    it('is a no-op (returns 0) when nothing is running', () => {
      q.enqueue(target);
      expect(q.reclaimAbandoned()).toBe(0);
    });
  });
});
