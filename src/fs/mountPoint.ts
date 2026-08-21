import { readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** What `containingMount` needs from a filesystem. Injectable because a test cannot mount
 * an NFS share to produce a second device id. */
export type StatDev = (p: string) => { dev: number };

/**
 * The mount point of the filesystem holding `p`.
 *
 * Walks up while each parent reports the same device id, and returns the highest ancestor
 * that still matches. That ancestor is where the filesystem was mounted. For `/tv` as a
 * bind mount the answer is `/tv` itself. For `/mnt/media/Series` on an NFS share the answer
 * is `/mnt/media`. For a directory on the machine's own disk the answer is `/`.
 *
 * Throws if `p` does not exist. Callers check that first.
 */
export function containingMount(p: string, stat: StatDev = statSync): string {
  const dev = stat(p).dev;
  let current = p;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return current;
    let parentDev: number;
    try {
      parentDev = stat(parent).dev;
    } catch {
      // A parent we cannot stat ends the walk: `current` is the highest ancestor we were
      // able to confirm shares the device.
      return current;
    }
    if (parentDev !== dev) return current;
    current = parent;
  }
}

/** True when `p` is a directory with no entries. A path that cannot be read is not empty,
 * it is unknown, and reporting it as empty would turn an unreadable share into the
 * "you forgot the bind mount" message. */
export function isEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}
