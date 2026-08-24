import { describe, expect, it } from 'vitest';
import { ensureEnvelope, eventEnvelope, readEnvelope } from '../src/events/envelope.js';
import { EventLog } from '../src/events/log.js';
import { freshDb } from './helpers.js';

describe('eventEnvelope', () => {
  it('puts the envelope over the extras so no loose key can shadow it', () => {
    const data = eventEnvelope({ scope: 'acquire', action: 'pick' }, { action: 'force-grab', instance: 'sonarr' });
    expect(data).toMatchObject({ scope: 'acquire', action: 'pick', instance: 'sonarr' });
  });

  it.each([
    { name: 'the whole envelope', mutate: (d: Record<string, unknown>) => (d.action = 'tampered') },
    { name: 'a nested facts object', mutate: (d: Record<string, unknown>) => ((d.facts as Record<string, unknown>).site = 'evil.tv') },
    {
      name: 'an array inside facts',
      mutate: (d: Record<string, unknown>) => ((d.facts as { episodes: unknown[] }).episodes.push({ season: 9, episode: 9 })),
    },
    {
      name: 'an object inside an array inside facts',
      mutate: (d: Record<string, unknown>) => ((d.facts as { episodes: Record<string, unknown>[] }).episodes[0]!.season = 99),
    },
  ])('freezes $name', ({ mutate }) => {
    // The tracer captures payloads as lazy closures, so a shared envelope mutated after
    // emit would let the trace record a state that never existed at append time.
    const data = eventEnvelope({ scope: 'subtitle', action: 'unresolved', facts: { site: 'subhd.tv', episodes: [{ season: 1, episode: 2 }] } });
    expect(() => mutate(data as unknown as Record<string, unknown>)).toThrow(TypeError);
  });

  it('drops undefined facts rather than storing them as present-but-empty', () => {
    const data = eventEnvelope({ scope: 'acquire', action: 'pick', facts: { title: 'X', season: undefined } });
    expect(Object.keys(data.facts!)).toEqual(['title']);
  });

  it('omits facts entirely when every one of them was undefined', () => {
    expect(eventEnvelope({ scope: 'run', action: 'finished', facts: { title: undefined } })).not.toHaveProperty('facts');
  });

  it('round-trips through JSON unchanged, which is how it is stored', () => {
    const data = eventEnvelope({ scope: 'subtitle', action: 'visit', facts: { site: 'a.tv', steps: 2 }, verdict: { tone: 'success' } });
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe('readEnvelope', () => {
  it.each([
    { name: 'a full envelope', data: { scope: 'run', action: 'finished', facts: { pipeline: 'ingest' }, verdict: { tone: 'success' } }, ok: true },
    { name: 'scope and action alone', data: { scope: 'run', action: 'finished' }, ok: true },
    // The accept payloads used to sit at the top level with their own `action`; requiring
    // `scope` is what stops one of those reading as an already-migrated row.
    { name: 'a legacy accept payload', data: { action: 'disable-site', baseUrl: 'https://x.test' }, ok: false },
    { name: 'a bare legacy payload', data: { instance: 'sonarr', seasonNumber: 1 }, ok: false },
    { name: 'nothing at all', data: {}, ok: false },
  ])('$name', ({ data, ok }) => {
    expect(readEnvelope(data) !== null).toBe(ok);
  });
});

describe('ensureEnvelope', () => {
  it('leaves an emitter-built envelope exactly as it is', () => {
    const built = eventEnvelope({ scope: 'acquire', action: 'pick', facts: { season: 3 } });
    expect(ensureEnvelope('acquire.pick', built)).toEqual(built);
  });

  it.each([
    { kind: 'ingest.stale-cleaned', scope: 'ingest', action: 'stale-cleaned' },
    { kind: 'reconcile.gc-skip-tag-foreign-profile', scope: 'reconcile', action: 'gc-skip-tag-foreign-profile' },
    // No dot to split on: the whole kind is the action, under a scope that says as much.
    { kind: 'healthcheck', scope: 'system', action: 'healthcheck' },
  ])('derives $scope/$action from $kind', ({ kind, scope, action }) => {
    expect(ensureEnvelope(kind, {})).toMatchObject({ scope, action });
  });

  it('lifts the facts a loosely-shaped payload already carried, under the vocabulary names', () => {
    const data = ensureEnvelope('subtitle.quarantined', {
      instance: 'Sonarr',
      site: 'subhd.tv',
      seasonNumber: 2,
      sourceFile: '/cache/a.ass',
      reasoning: 'could not verify timing',
      count: 3,
    });
    expect(data.facts).toEqual({
      instance: 'Sonarr',
      site: 'subhd.tv',
      season: 2,
      sourcePath: '/cache/a.ass',
      reason: 'could not verify timing',
      counts: { count: 3 },
    });
  });

  it.each([
    { name: 'an arr import', key: 'path' },
    { name: 'a placed subtitle', key: 'placedPath' },
    { name: 'a set-aside subtitle', key: 'quarantinedPath' },
    { name: 'a destination that was already claimed', key: 'targetPath' },
    // Same names the one-time migration maps, so a stored row and a fresh one of the same
    // kind carry the same `file`.
  ])('reads the file $name is about off `$key`', ({ key }) => {
    expect(ensureEnvelope('subtitle.placed', { [key]: '/library/a.ass' }).facts).toMatchObject({ file: { path: '/library/a.ass' } });
  });

  it('keeps the attention protocol fields at the top level, where the dedupe reads them', () => {
    const data = ensureEnvelope('ingest.rescue-proposed', {
      instance: 'sonarr',
      targetKind: 'series',
      targetId: 42,
      dedupeKey: 'x',
      accept: { action: 'bundle-import' },
    });
    expect(data).toMatchObject({ instance: 'sonarr', targetKind: 'series', targetId: 42, dedupeKey: 'x', accept: { action: 'bundle-import' } });
  });
});

describe('EventLog.append', () => {
  it('gives every stored row an envelope, whatever its emitter passed', () => {
    const events = new EventLog(freshDb());
    events.append({ kind: 'reconcile.gc', message: 'swept' });
    expect(readEnvelope(events.list()[0]!.data)).toMatchObject({ scope: 'reconcile', action: 'gc' });
  });

  it('broadcasts the same shape it persists, so an SSE listener and a refetch agree', () => {
    const events = new EventLog(freshDb());
    const seen: Record<string, unknown>[] = [];
    events.subscribe((e) => seen.push(e.data));
    events.append({ kind: 'subtitle.missing', jobId: 1, message: 'm', data: { counts: { missing: 4 } } });
    events.broadcast({ kind: 'subtitle.missing', jobId: 1, message: 'm', data: { counts: { missing: 4 } } });
    expect(seen[1]).toEqual(seen[0]);
  });
});
