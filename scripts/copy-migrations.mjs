// tsc does not emit non-TypeScript assets, so the migration .sql files need a
// manual copy into dist/ alongside the compiled db.js after each build. db.ts
// resolves its migrations dir relative to its own module URL, so this must land
// at dist/db/migrations to mirror the src/db/migrations layout.
//
// Paths are resolved relative to this script's own location (not process.cwd())
// so the copy works regardless of where `npm run build` is invoked from. The
// dest dir is wiped first so a migration renamed/removed in src doesn't linger
// as stale .sql in dist across incremental builds.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/db/migrations');
const dest = join(root, 'dist/db/migrations');

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
