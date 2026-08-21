// `npm run dev` runs the API alone, and the dashboard it serves is whatever was last
// built into web/dist. That goes stale the moment you touch web/src, and silently, so the
// UI you're looking at can be days behind your source. This runs the API watcher and the
// vite dev server together instead: vite serves web/src straight from disk with HMR and
// proxies /api to the API's port, so there is no build step to forget.
//
// Each child is spawned detached, into its own process group. npm spawns tsx and vite as
// grandchildren, so signalling npm alone would leave those orphaned and holding the
// ports; killing the negative pid takes the whole group down.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const TASKS = [
  // WARRDEN_SERVE_WEB=false keeps the API from also serving whatever is in web/dist: vite
  // owns the UI here, and a stale copy on the API's port is just a way to debug a ghost.
  { name: 'api', args: ['run', 'dev'], env: { WARRDEN_SERVE_WEB: 'false' } },
  { name: 'web', args: ['--prefix', 'web', 'run', 'dev'] },
];

const labelWidth = Math.max(...TASKS.map((task) => task.name.length));
let shuttingDown = false;

const children = TASKS.map(({ name, args, env }) => {
  const child = spawn('npm', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  // Each stream keeps its own side of the parent's stdio, so `2>` and anything grepping
  // the two apart still works once the prefix is on.
  for (const [stream, write] of [
    [child.stdout, console.log],
    [child.stderr, console.error],
  ]) {
    createInterface({ input: stream }).on('line', (line) => {
      write(`${name.padEnd(labelWidth)} | ${line}`);
    });
  }

  child.on('error', (err) => {
    console.error(`${name.padEnd(labelWidth)} | failed to start: ${err.message}`);
    shutdown(1);
  });

  // Half of this pair is useless on its own, so they live and die together: a crashed
  // API shouldn't leave a dev server up serving a dashboard with no backend.
  child.on('exit', (code, signal) => {
    if (!shuttingDown) shutdown(code ?? (signal ? 1 : 0));
  });

  return child;
});

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone; nothing to signal.
    }
  }
}

// Ctrl-C reaches this script only: the children sit in their own groups, so the
// forwarding above is what actually stops them.
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
