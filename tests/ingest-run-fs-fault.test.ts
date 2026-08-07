import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { runIngestJob } from '../src/pipelines/ingest/run.js';
import { enqueueAndClaim, ingestFixture } from './helpers.js';

// A path this file's `statSync` override throws for — set per-test, cleared after. `vi.mock`
// below is hoisted above every import in this file (Vitest's usual hoisting), so its factory
// can only safely close over a plain local variable like this one, not an imported binding.
let ghostPath: string | undefined;

/**
 * Simulates the exact race `fileSizeEquals` (src/pipelines/ingest/run.ts) exists to guard
 * against: `walkFiles`/`readdirSync` lists a file that's still there at listing time, but an
 * active torrent client on the same (often SMB-mounted) share deletes or moves it before
 * this ever gets around to `statSync`-ing it. Every other `node:fs` export passes straight
 * through to the real implementation — only `statSync` is intercepted, and only for
 * `ghostPath` — so this has no effect on anything else the ingest pipeline (or its test
 * fixtures) do with the filesystem.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (ghostPath !== undefined && String(path) === ghostPath) {
        const err = new Error(`ENOENT: no such file or directory, stat '${String(path)}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.statSync as any)(path, ...rest);
    },
  };
});

describe('runIngestJob — movie source-video stat hardening', () => {
  it('a video that vanishes between listing and stat (an active torrent client on the same share) is a non-match, not a crash', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv' });
    // A real sidecar the sweep must still place — proves the job doesn't just "survive",
    // it keeps doing its actual job around the stat failure.
    writeFileSync(join(fx.torrentDir, 'Movie.chs.ass'), 'sub-content');

    // Present at readdir/walkFiles time; ghostPath is armed AFTER writing it, so
    // fileSizeEquals's own statSync call is the one that throws, not an earlier readdir.
    const ghost = join(fx.torrentDir, 'ghost.mkv');
    writeFileSync(ghost, 'video');
    ghostPath = ghost;

    const job = enqueueAndClaim(fx.ctx, { pipeline: 'ingest', targetKind: fx.targetKind, targetId: fx.targetId, arrInstance: fx.arrInstance });

    await expect(runIngestJob(fx.ctx, job)).resolves.toBeUndefined();

    const placedTarget = join(fx.libraryDir, 'Movie.zh-Hans.ass');
    expect(existsSync(placedTarget)).toBe(true);
    expect(readFileSync(placedTarget, 'utf-8')).toBe('sub-content');
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'movie', 7)).toHaveLength(1);

    ghostPath = undefined;
  });
});
