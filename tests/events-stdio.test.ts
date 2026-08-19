import { describe, it, expect, vi } from 'vitest';
import { EventLog } from '../src/events/log.js';
import { bindEventLogToStdio, formatEventLine, writeEventToStdio } from '../src/events/stdio.js';
import { freshDb } from './helpers.js';

describe('formatEventLine', () => {
  it('renders ts, level, kind, and message as a single grep-friendly line', () => {
    expect(
      formatEventLine({
        ts: Date.UTC(2026, 7, 18, 15, 4, 5, 123),
        level: 'info',
        kind: 'webhook.received',
        message: 'OnDownload for "Show" (sonarr)',
      }),
    ).toBe('2026-08-18T15:04:05.123Z info       webhook.received  OnDownload for "Show" (sonarr)');
  });

  it('pads attention to the same level column as info/warn', () => {
    expect(
      formatEventLine({
        ts: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
        level: 'attention',
        kind: 'job.attention',
        message: 'Import cleanup failed permanently',
      }),
    ).toBe('2026-01-01T00:00:00.000Z attention  job.attention  Import cleanup failed permanently');
  });
});

describe('writeEventToStdio', () => {
  const row = {
    id: 1,
    ts: Date.UTC(2026, 7, 18, 12, 0, 0, 0),
    kind: 'job.failed',
    job_id: 12,
    message: 'Job #12 (ingest) failed: mount missing',
    data: {},
  } as const;

  it.each([
    { level: 'info' as const, method: 'log' as const },
    { level: 'warn' as const, method: 'warn' as const },
    { level: 'attention' as const, method: 'error' as const },
  ])('writes $level to console.$method', ({ level, method }) => {
    const spy = vi.spyOn(console, method).mockImplementation(() => {});
    writeEventToStdio({ ...row, level });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe(formatEventLine({ ...row, level }));
  });
});

describe('bindEventLogToStdio', () => {
  it('writes persisted appends and ignores broadcast-only trace pings', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const events = new EventLog(freshDb());
    const unbind = bindEventLogToStdio(events);

    events.append({
      kind: 'webhook.received',
      message: 'OnDownload for "Show" (sonarr)',
      data: { instance: 'sonarr', candidates: ['this must not appear'] },
    });
    events.broadcast({ kind: 'trace.appended', jobId: 3, message: '', data: { seq: 5 } });

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/info\s+webhook.received  OnDownload for "Show" \(sonarr\)$/);
    expect(String(log.mock.calls[0]![0])).not.toContain('this must not appear');

    unbind();
    events.append({ kind: 'after.unbind', message: 'should be silent' });
    expect(log).toHaveBeenCalledOnce();
  });
});
