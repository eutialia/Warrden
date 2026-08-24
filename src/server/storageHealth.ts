import { accessSync, constants, statSync, statfsSync } from 'node:fs';
import type { Config } from '../config/schema.js';
import { storageRoles, type StorageRoleId } from '../config/storage.js';
import { containingMount, isEmptyDir, type StatDev } from '../fs/mountPoint.js';

export type StorageCheckStatus = 'ok' | 'not-configured' | 'missing' | 'looks-unmounted' | 'unreadable';

export interface StorageCheck {
  id: StorageRoleId;
  /** Human label for the dashboard. */
  label: string;
  /** The configured path, or '' when the role is disabled. */
  path: string;
  status: StorageCheckStatus;
  detail: string;
  /** How full the volume is. Absent when the path is unreachable, or when the filesystem
   * will not answer: a missing number is not the same as a full disk. */
  usage?: { totalBytes: number; usedBytes: number };
}

/** How long a probe stays good enough for a page that polls. */
const CACHE_MS = 30_000;
let cached: { at: number; checks: StorageCheck[] } | null = null;

/**
 * The probe, but safe to call from a route the dashboard polls. Every check is a blocking
 * syscall against a network path, and Node has one thread: a hung NFS share would stall
 * webhooks and the job queue behind it, once per poll per open tab.
 */
export function cachedStorage(config: Config, now = Date.now(), stat?: StatDev): StorageCheck[] {
  if (cached && now - cached.at < CACHE_MS) return cached.checks;
  const checks = probeStorage(config, stat);
  cached = { at: now, checks };
  return checks;
}

/** Drops the cached probe. Called when the operator saves new paths, so the panel answers
 * for what they just typed instead of for what was there half a minute ago. */
export function resetStorageCache(): void {
  cached = null;
}

/** `stat` is injectable so a test can prove the classification rather than the disk layout
 * of the machine running it: whether a temp directory shares a device id with `/` differs
 * between a Mac, CI, and a container. */
export function probeStorage(config: Config, stat?: StatDev): StorageCheck[] {
  return storageRoles(config).map((role) => {
    if (!role.configured) {
      return {
        id: role.id,
        label: role.label,
        path: '',
        status: 'not-configured' as const,
        detail: `No path set. Warrden skips ${role.label} entirely.`,
      };
    }
    // One unhappy mount degrades its own row and nothing else. This probe is the first
    // thing the dashboard asks for, so a syscall we failed to anticipate must not take
    // the whole page down with it.
    let access: Pick<StorageCheck, 'status' | 'detail'>;
    try {
      access = probeAccess(role.path, role.label, stat);
    } catch (err) {
      access = { status: 'unreadable', detail: `${role.path} could not be probed: ${errnoLabel(err)}` };
    }
    return {
      id: role.id,
      label: role.label,
      path: role.path,
      ...access,
      ...(access.status === 'ok' ? { usage: diskUsage(role.path) } : {}),
    };
  });
}

/**
 * How much of the volume behind `p` is in use, counted the way `df` counts it: used is
 * total minus all free blocks, including the slice most filesystems reserve for root.
 * Charging that reserve to "used" would report a brand-new 18 TB volume as nearly a
 * terabyte full, which is not what anyone comparing this against `df` expects.
 */
function diskUsage(p: string): StorageCheck['usage'] {
  try {
    const fs = statfsSync(p);
    const total = fs.blocks * fs.bsize;
    if (total <= 0) return undefined;
    return { totalBytes: total, usedBytes: (fs.blocks - fs.bfree) * fs.bsize };
  } catch {
    // Network filesystems can refuse statfs while still being readable. The mount is
    // fine; we just have nothing to say about its size.
    return undefined;
  }
}

/**
 * Whether the media is really there.
 *
 * A path that exists is not enough. Docker creates an empty `/tv` on the container's own
 * filesystem when you forget the bind mount, and ingest would then look like it found
 * nothing rather than like it looked in the wrong place. So an empty directory that sits on
 * the root filesystem reports `looks-unmounted`.
 *
 * Anything on another filesystem passes, which is the NFS and SMB case: `/mnt/media/Series`
 * is a directory inside the share, not the share itself. A directory on the root filesystem
 * with files in it passes too, which is media on a laptop's own disk.
 *
 * The first question is `stat`, not `exists`: a dead SMB share answers `existsSync` and
 * `access` with yes and then fails every real syscall, so an existence check would wave it
 * through to a `stat` that throws.
 */
function probeAccess(path: string, label: string, stat: StatDev = statSync): Pick<StorageCheck, 'status' | 'detail'> {
  try {
    stat(path);
  } catch (err) {
    return statFailure(path, label, err);
  }

  try {
    accessSync(path, constants.R_OK);
  } catch {
    return { status: 'unreadable', detail: `${path} exists but Warrden cannot read it` };
  }

  if (containingMount(path, stat) === '/' && isEmptyDir(path)) {
    return {
      status: 'looks-unmounted',
      detail: `${path} is an empty directory on this machine's own filesystem, not a mounted share`,
    };
  }

  return { status: 'ok', detail: `Reachable at ${path}` };
}

/** ESTALE, the errno a mount returns once the server behind it went away. libuv has no name
 * for it on Linux, so it arrives as `code: 'Unknown system error -116'`. */
const ESTALE = 116;

/** Why a `stat` on a configured path failed, in words an operator can act on. Only a truly
 * absent path is `missing`; everything else is a mount that is present but not answering,
 * which is a different fix (remount the share) than a different fix (correct the path). */
function statFailure(path: string, label: string, err: unknown): Pick<StorageCheck, 'status' | 'detail'> {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
    return { status: 'missing', detail: `${label} not found at ${path}` };
  }
  if (e?.code === 'ESTALE' || Math.abs(e?.errno ?? 0) === ESTALE) {
    return { status: 'unreadable', detail: `${path} is a stale mount — the share dropped and has to be remounted` };
  }
  return { status: 'unreadable', detail: `${path} exists but Warrden cannot read it (${errnoLabel(err)})` };
}

/** Prefers the symbolic code, falls back to the raw number for the errnos libuv cannot name. */
function errnoLabel(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code && !e.code.startsWith('Unknown')) return e.code;
  if (typeof e?.errno === 'number') return `errno ${e.errno}`;
  return e instanceof Error ? e.message : String(err);
}
