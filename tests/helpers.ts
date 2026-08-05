import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a fresh temp directory for a test, e.g. as a data dir for config/db files. */
export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'warrden-'));
}
