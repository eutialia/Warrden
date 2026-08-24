import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@/api';
import { bundleImportData, disableSiteData, isForceGrab } from '@/lib/attentionAccept';

/**
 * Every fixture is the shape a real emitter writes: `eventEnvelope(...)` puts `scope`/
 * `action`/`facts` at the top level and carries the protocol keys (`accept`, `evidence`,
 * the target triple) beside them. See `planBundleImport` (src/pipelines/ingest/run.ts),
 * `raiseUnusable` (src/pipelines/subtitle/run.ts) and `appendNonGrabAttentionEvent`
 * (src/pipelines/acquire/run.ts).
 */

function item(data: Record<string, unknown>): AttentionItem {
  return { id: 1, ts: 0, kind: 'x', message: 'm', job_id: 7, data, status: 'open', resolved_at: null };
}

const BUNDLE_IMPORT = item({
  scope: 'ingest',
  action: 'rescue-proposed',
  facts: { title: 'Frieren', reason: 'match is uncertain', counts: { files: 3 } },
  verdict: { tone: 'warning' },
  instance: 'sonarr',
  targetKind: 'series',
  targetId: 136,
  accept: {
    action: 'bundle-import',
    instance: 'sonarr',
    files: [{ path: '/dl/S01E01.mkv' }, { path: '/dl/S01E02.mkv' }, { path: '/dl/Season 2/S02E01.mkv' }],
  },
});

const DISABLE_SITE = item({
  scope: 'subtitle',
  action: 'site-unusable',
  facts: { site: 'acg.rip', reason: 'search returns nothing on any tier', reasons: ['curl', 'chromium'] },
  verdict: { tone: 'danger' },
  instance: 'subtitle-site',
  targetKind: 'site',
  targetId: 'acg.rip',
  dedupeKey: 'acg.rip',
  evidence: ['[curl] search: 403', '[chromium] search: empty result list'],
  accept: { action: 'disable-site', baseUrl: 'https://acg.rip', reason: 'search returns nothing on any tier' },
});

const FORCE_GRAB = item({
  scope: 'acquire',
  action: 'none-viable',
  facts: { title: 'Dune', season: 1, reason: 'every candidate is a cam rip' },
  verdict: { tone: 'warning' },
  instance: 'radarr',
  targetKind: 'movie',
  targetId: 1,
  reasoning: 'every candidate is a cam rip',
  accept: { action: 'force-grab', instance: 'radarr', guid: 'guid-1', indexerId: 4, pickedTitle: 'Dune 2160p', releaseGroup: 'X' },
});

/** What `legacyAccept` (src/db/migrateEventEnvelopes.ts) leaves behind: the old top-level
 * discriminator is gone — the envelope owns `action` — and only the keys each accept
 * schema reads were copied under `accept`. `evidence` is not among the carried keys, so a
 * migrated site-unusable item shows none. */
const MIGRATED_DISABLE_SITE = item({
  scope: 'subtitle',
  action: 'site-unusable',
  facts: { site: 'acg.rip', reason: 'looks unusable', reasons: ['curl'] },
  verdict: { tone: 'danger' },
  instance: 'subtitle-site',
  targetKind: 'site',
  targetId: 'acg.rip',
  dedupeKey: 'acg.rip',
  accept: { action: 'disable-site', baseUrl: 'https://acg.rip', reason: 'looks unusable' },
});

describe('bundleImportData', () => {
  it('reads files from the accept payload and the rest from the envelope', () => {
    expect(bundleImportData(BUNDLE_IMPORT)).toEqual({
      reasoning: 'match is uncertain',
      fileCount: 3,
      files: [{ path: '/dl/S01E01.mkv' }, { path: '/dl/S01E02.mkv' }, { path: '/dl/Season 2/S02E01.mkv' }],
    });
  });

  it('falls back to the list length when the envelope carries no count', () => {
    const noCount = item({ scope: 'ingest', action: 'rescue-proposed', accept: { action: 'bundle-import', files: [{ path: '/a.mkv' }] } });
    expect(bundleImportData(noCount)).toEqual({ fileCount: 1, files: [{ path: '/a.mkv' }] });
  });

  it.each([
    ['another kind', DISABLE_SITE],
    ['no accept payload', item({ scope: 'ingest', action: 'rescue-proposed', facts: { counts: { files: 3 } } })],
    ['no usable file paths', item({ accept: { action: 'bundle-import', files: [{ path: 4 }] } })],
    ['an empty file list', item({ accept: { action: 'bundle-import', files: [] } })],
  ])('returns null for %s', (_label, row) => {
    expect(bundleImportData(row)).toBeNull();
  });
});

describe('disableSiteData', () => {
  it('reads the site from the accept payload and the tiers from the envelope', () => {
    expect(disableSiteData(DISABLE_SITE)).toEqual({
      baseUrl: 'https://acg.rip',
      reason: 'search returns nothing on any tier',
      tiersAttempted: ['curl', 'chromium'],
      evidence: ['[curl] search: 403', '[chromium] search: empty result list'],
    });
  });

  it('reads a migrated row, which keeps its tiers but not its evidence', () => {
    expect(disableSiteData(MIGRATED_DISABLE_SITE)).toEqual({
      baseUrl: 'https://acg.rip',
      reason: 'looks unusable',
      tiersAttempted: ['curl'],
      evidence: [],
    });
  });

  it.each([
    ['another kind', FORCE_GRAB],
    ['no accept payload', item({ scope: 'subtitle', action: 'site-unusable', facts: { reasons: ['curl'] } })],
    ['a payload missing its baseUrl', item({ accept: { action: 'disable-site', reason: 'x' } })],
  ])('returns null for %s', (_label, row) => {
    expect(disableSiteData(row)).toBeNull();
  });
});

describe('isForceGrab', () => {
  it.each([
    ['a force-grab payload', FORCE_GRAB, true],
    ['a none-viable item with nothing to grab', item({ scope: 'acquire', action: 'none-viable', facts: { title: 'Dune' } }), false],
    ['a payload missing its guid', item({ accept: { action: 'force-grab', instance: 'radarr' } }), false],
    ['another kind', BUNDLE_IMPORT, false],
  ])('is %s → %s', (_label, row, expected) => {
    expect(isForceGrab(row)).toBe(expected);
  });
});

/** The pre-migration shape put the discriminator at `data.action`, which the envelope now
 * owns. Nothing reads it any more because the migration rewrote every stored row
 * (`legacyAccept` backfills `data.accept`); a row still in the old shape would have to have
 * dodged the migration entirely, and reading it would mean treating an envelope's own
 * `action` as an accept discriminator. */
describe('the pre-migration shape', () => {
  it.each([
    ['bundle-import', item({ action: 'bundle-import', instance: 'sonarr', files: [{ path: '/a.mkv' }], fileCount: 1 })],
    ['disable-site', item({ action: 'disable-site', baseUrl: 'https://acg.rip', reason: 'x', tiersAttempted: ['curl'] })],
    ['force-grab', item({ action: 'force-grab', instance: 'radarr', guid: 'g' })],
  ])('is not read as a %s proposal', (_label, row) => {
    expect(bundleImportData(row)).toBeNull();
    expect(disableSiteData(row)).toBeNull();
    expect(isForceGrab(row)).toBe(false);
  });
});
