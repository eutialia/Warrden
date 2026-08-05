// tsc does not emit non-TypeScript assets, so the migration .sql files need a
// manual copy into dist/ alongside the compiled db.js after each build. db.ts
// resolves its migrations dir relative to its own module URL, so this must land
// at dist/db/migrations to mirror the src/db/migrations layout.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
