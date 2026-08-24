import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { migrateEventEnvelopes, type MigrationReport } from './migrateEventEnvelopes.js';

/**
 * One-shot CLI for the envelope migration. Deliberately NOT wired into `openDb`'s
 * `migrations/` runner: that runs on every boot, and this pass DELETES rows whose kind it
 * cannot name. Deciding to lose history is an operator's call, made after reading a dry
 * run — not something a container restart does quietly.
 *
 *   npx tsx src/db/migrateEventEnvelopesCli.ts <path-to.db>          # dry run, reports only
 *   npx tsx src/db/migrateEventEnvelopesCli.ts <path-to.db> --apply  # rewrites in place
 */
export function formatReport(report: MigrationReport, dryRun: boolean): string {
  const lines: string[] = [dryRun ? 'DRY RUN — nothing was written' : 'APPLIED'];
  const kinds = [...new Set([...Object.keys(report.migrated), ...Object.keys(report.deleted), ...Object.keys(report.skipped)])].sort();
  const width = Math.max(4, ...kinds.map((k) => k.length));
  lines.push(`${'kind'.padEnd(width)}  migrated  deleted  skipped`);
  for (const kind of kinds) {
    lines.push(
      `${kind.padEnd(width)}  ${String(report.migrated[kind] ?? 0).padStart(8)}  ${String(report.deleted[kind] ?? 0).padStart(7)}  ${String(report.skipped[kind] ?? 0).padStart(7)}`,
    );
  }
  const sum = (t: Record<string, number>): number => Object.values(t).reduce((a, b) => a + b, 0);
  lines.push(`${'TOTAL'.padEnd(width)}  ${String(sum(report.migrated)).padStart(8)}  ${String(sum(report.deleted)).padStart(7)}  ${String(sum(report.skipped)).padStart(7)}`);
  lines.push(`${report.total} row(s) examined`);
  return lines.join('\n');
}

function main(argv: string[]): void {
  const [path, ...flags] = argv;
  if (path === undefined) {
    console.error('usage: migrateEventEnvelopesCli <path-to.db> [--apply]');
    process.exitCode = 2;
    return;
  }
  const dryRun = !flags.includes('--apply');
  const db = new Database(path);
  try {
    console.log(formatReport(migrateEventEnvelopes(db, { dryRun }), dryRun));
  } finally {
    db.close();
  }
}

// Only when this file IS the entry point — importing it (tests, tooling) must never run
// a migration as a side effect.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
