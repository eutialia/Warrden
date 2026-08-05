import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const createdDirs: string[] = [];

process.on('exit', () => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates a fresh temp directory for a test, e.g. as a data dir for config/db files. */
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warrden-'));
  createdDirs.push(dir);
  return dir;
}
