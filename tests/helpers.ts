import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const createdDirs: string[] = [];

/** Creates a fresh temp directory for a test, e.g. as a data dir for config/db files. */
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warrden-'));
  createdDirs.push(dir);
  return dir;
}

/**
 * Removes every directory created via tmpDir() so far, in this test file's module
 * instance. Called from tests/setup.ts — `process.on('exit')` doesn't fire reliably
 * under Vitest's worker pool, so cleanup has to be a Vitest lifecycle hook instead.
 */
export function cleanupTmpDirs(): void {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
