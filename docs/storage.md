# Storage

Warrden works with four libraries. Their paths come from `config.storage` and are editable under Settings, Storage, because where the media lives depends on how you deployed: bind mounts under Docker, NFS paths in an LXC, your own mounts when the process runs on the machine.

| Role | Config key | Default | What it is |
| --- | --- | --- | --- |
| Series | `storage.series` | `/tv` | Sonarr Series root folder |
| Anime | `storage.anime` | `/anime` | Sonarr Anime root folder |
| Movies | `storage.movies` | `/movies` | Radarr library root |
| Downloads | `storage.downloads` | `/downloads` | Torrent client completed root |

A blank path means you do not have that library. Warrden skips the role everywhere: the storage panel reports it as not configured, and the mount gate does not require it.

Paths must be absolute or blank. A relative path resolves against the working directory, which differs between `npm run dev` and the container, so the schema rejects it.

Code: `src/config/storage.ts`, health probe `src/server/storageHealth.ts`, mount walk `src/fs/mountPoint.ts`.

## Docker, LXC, and a direct process

Under Docker, Warrden runs inside the container. A host path typed into Settings names nothing the container can open. Bind the four roles in `compose.override.yaml` (git-ignored). The defaults match the container paths, so a new Docker install binds to `/tv` and runs without editing Settings.

Copy `compose.override.example.yaml` and point the host paths at this machine's mounts. If you instead let Docker mount SMB shares itself, credentials go in `.env` (`SMB_USERNAME`, `SMB_PASSWORD`). That workaround exists because the Docker daemon runs as root and cannot read a GVFS mount that belongs to your user session.

LXC and a direct process see the shares already in the filesystem. Set the four fields once. `.env` is not required.

## Path mappings

`pathMappings` answers a different question and stays file-only. The arr calls a file `/data/Series/X`. Warrden opens it at `/mnt/media/Series/X`. `effectiveDownloadRoots` derives arr-side download roots from mappings whose target is the Downloads path. With no such mapping, the arr and Warrden see the same path. With Downloads disabled there are no roots at all.

## Whether a path is really there

`containingMount(p)` walks up from `p` while each parent has the same device id, and returns the highest ancestor that still matches. That ancestor is the filesystem holding `p`. For `/tv` as a bind mount the answer is `/tv` itself. For `/mnt/media/Series` on an NFS share the answer is `/mnt/media`. For a directory on the machine's own disk the answer is `/`.

| Condition | Status |
| --- | --- |
| Path is blank | `not-configured` |
| Path does not exist | `missing` |
| Containing mount is `/` and the directory is empty | `looks-unmounted` |
| Containing mount is `/` and the directory has entries | `ok` |
| Containing mount is any other filesystem | `ok` |
| Path exists and is not readable | `unreadable` |
| `stat` throws `ESTALE` (a dropped CIFS share) | `unreadable` |

A dropped CIFS share can still answer `existsSync` and `accessSync`. The probe leads with a guarded `stat` so ESTALE does not take `/api/overview` down. One failing role degrades its row. It does not fail the page.

The mount gate is the set of configured roles. There is no second list of marker files.
