import { accessSync, constants, existsSync, statSync } from 'node:fs';
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
}

/**
 * Probes the four standard mounts (Series / Anime / Movies / Downloads).
 * Path mappings stay file/env-only — never edited or shown here.
 *
 * A path that merely *exists* is not enough: the image must not pre-create `/tv` etc.,
 * and we also require a real mount point (device id differs from parent) so an empty
 * leftover directory never reports as OK.
 */
export function probeStorage(): StorageCheck[] {
  return standardMounts().map((mount) => ({
    id: mount.id,
    label: mount.label,
    path: mount.path,
    localPath: mount.path,
    role: mount.id,
    immutable: true,
    ...probeAccess(mount.path, mount.label, /* requireMountPoint */ true),
  }));
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
