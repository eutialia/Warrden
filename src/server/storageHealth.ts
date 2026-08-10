import { accessSync, constants, existsSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { standardMounts, type StandardMountId } from '../config/standardMounts.js';

export type StorageCheckStatus = 'ok' | 'missing' | 'unreadable' | 'unwritable' | 'not-mounted';

export interface StorageCheck {
  /** Stable mount role — series | anime | movies | downloads. */
  id: StandardMountId;
  /** Human label for the dashboard. */
  label: string;
  /** Path shown as the configured/expected location. */
  path: string;
  /** Path as seen inside Warrden (same as path for the four standard mounts). */
  localPath: string;
  role: StandardMountId;
  status: StorageCheckStatus;
  detail: string;
  /** Always true for the four standard mounts — UI must not offer an editor. */
  immutable: boolean;
  /** How full the volume is. Absent when the mount is unreachable, or when the
   * filesystem won't answer — a missing number is not the same as a full disk, so
   * the UI has to be able to tell the two apart. */
  usage?: { totalBytes: number; usedBytes: number };
}

/**
 * Probes the four standard mounts (Series / Anime / Movies / Downloads).
 * Path mappings stay file/env-only — never edited or shown here.
 *
 * A path that merely *exists* is not enough: the image must not pre-create `/tv` etc.,
 * and we also require a real mount point (device id differs from parent) so an empty
 * leftover directory never reports as OK.
 */
/** How long a probe stays good enough for a page that polls. */
const CACHE_MS = 30_000;
let cached: { at: number; checks: StorageCheck[] } | null = null;

/**
 * The probe, but safe to call from a route the dashboard polls. Every check here is a
 * blocking syscall against a network mount, and Node has one thread: a hung NFS share
 * would otherwise stall webhooks and the job queue behind it, once per poll per open tab.
 * The explicit "Re-check now" button calls `probeStorage` instead and always sees fresh
 * results.
 */
export function cachedStorage(now = Date.now()): StorageCheck[] {
  if (cached && now - cached.at < CACHE_MS) return cached.checks;
  const checks = probeStorage();
  cached = { at: now, checks };
  return checks;
}

export function probeStorage(): StorageCheck[] {
  return standardMounts().map((mount) => {
    const access = probeAccess(mount.path, mount.label, /* requireMountPoint */ true);
    return {
      id: mount.id,
      label: mount.label,
      path: mount.path,
      localPath: mount.path,
      role: mount.id,
      immutable: true,
      ...access,
      ...(access.status === 'ok' ? { usage: diskUsage(mount.path) } : {}),
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
 * True when `p` is its own mount point (device id differs from parent). Empty directories
 * that live on the container rootfs share the parent's device and fail this check —
 * which is what we want for "forgot to bind-mount /tv".
 */
export function isMountPoint(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return false;
    const parent = dirname(p);
    if (parent === p) return true;
    const pst = statSync(parent);
    return st.dev !== pst.dev;
  } catch {
    return false;
  }
}

function probeAccess(
  localPath: string,
  label: string,
  requireMountPoint: boolean,
): Pick<StorageCheck, 'status' | 'detail'> {
  if (!existsSync(localPath)) {
    return {
      status: 'missing',
      detail: `${label} not found at ${localPath} — bind this volume when creating the container`,
    };
  }

  if (requireMountPoint && !isMountPoint(localPath)) {
    return {
      status: 'not-mounted',
      detail: `${label} exists as an empty container path, not a bind mount — add -v hostPath:${localPath} when starting the container`,
    };
  }

  try {
    accessSync(localPath, constants.R_OK);
  } catch {
    return {
      status: 'unreadable',
      detail: `Exists but is not readable by Warrden`,
    };
  }

  return {
    status: 'ok',
    detail: `Mounted and readable at ${localPath}`,
  };
}
