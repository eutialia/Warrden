# Warrden

Warrden is a housekeeping agent that sits behind Sonarr and Radarr and closes the gaps a
human normally fills by hand. It watches for new series and movies, picks the correct
release out of a messy candidate list using an LLM policy, grabs it through the arr's own
API, and (for Sonarr) teaches the arr to keep picking correctly on its own from then on.
Once a release is grabbed, it also rescues what the arr's own import leaves behind: audio
and subtitle sidecars the arr never imports on its own, leftover episode files from
season-pack torrents, and imports the arr got stuck on. Downloading and the actual import
still belong to Sonarr/Radarr and the torrent client; Warrden only does the decision-making
and cleanup they can't.

This is Phase 2 of the project: release acquisition (Phase 1) plus ingest (this phase). The
subtitle pipeline is planned for a later phase — see the design spec linked below.

## Quickstart

Warrden is a single container. It needs a data directory for its SQLite database and
config, and network access to your Sonarr/Radarr instances. There's no published image
yet — build it from a checkout of this repo:

```sh
docker build -t warrden .
docker run -d \
  --name warrden \
  -p 9797:9797 \
  -v warrden-data:/data \
  warrden
```

Using a named volume (`warrden-data` above) rather than a bind mount lets Docker set its
ownership to match the container's non-root user automatically; a bind-mounted host
directory needs to be pre-owned by uid/gid `1000` for the same reason.

On first start, Warrden writes a default `config.json` into the data volume and serves a
dashboard at `http://<host>:9797`. Before adding any arr instance, set `server.publicUrl`
on the **Config** page to a URL your Sonarr/Radarr instances can reach the container at —
this is the address Warrden registers as its own webhook. Registration runs on every
startup and is by name (`"Warrden"`), not one-time: an instance with no Warrden webhook
gets one created; an instance whose webhook is already subscribed to download/upgrade
events (import events, needed for Ingest) is left as-is. The one exception is a webhook
left over from Phase 1, before it subscribed to those events — that one is deleted and
recreated exactly once, at the then-current `publicUrl`, to pick up import events; from
then on it's treated the same as any other fully-subscribed webhook. Either way, changing
`publicUrl` after an instance's webhook is already fully subscribed does not re-point
it — delete the "Warrden" webhook in the arr's own settings first if you need to move it.
Then add your arr instances (name, kind, base URL, API key), set picking and ingest
preferences, and choose an LLM provider.

Every config save requires a container restart to fully take effect (the save
confirmation says so) — some fields are read live, but arr connections and the LLM
provider/keys are only wired up at startup.

**Tested against:** Acquire (Phase 1) is live-verified against Sonarr v4. Radarr support is
implemented against the same v3 API shape but not yet live-verified against a real Radarr
instance. The release-profile API shape Warrden relies on for pinning assumes Sonarr v4 or
newer. Ingest (Phase 2) is covered by unit and integration tests against mocked arr/LLM/
filesystem behavior, but live verification against a running Sonarr/Radarr and torrent
client is still pending.

## Ingest

Ingest runs once per import (on-download/on-upgrade webhook, plus a reconciliation-loop
backstop for anything a webhook missed) and rescues what the arr's own import leaves
behind:

- **Sidecar rescue** — sweeps the torrent's own source folder(s) for `.mka` audio and
  `.srt`/`.ass` subtitle files the arr doesn't import on its own, matches each one to the
  episode or movie it belongs to (filename matching first, one batched LLM call — the
  `sidecar-match` call-site — for anything cryptic), and copies (never moves — the torrent
  keeps seeding) it into place beside the video, renamed to the arr's own convention.
- **Bundle rescue** — a season-pack or multi-movie torrent the arr only partially imports
  leaves whole leftover video files behind; these are mapped to series/season/episode
  (deterministic parsing first, an LLM call — the `bundle-map` call-site — plus the arr's
  own episode list for absolute numbering and specials) and pushed through the arr's
  manual-import API in copy mode. A high/medium-confidence mapping imports immediately; a
  low-confidence one is proposed as an **Attention** item instead, and only runs once a
  human accepts it.
- **Stuck-import rescue** — anything the arr's own manual-import queue gave up on gets the
  same mapping treatment as bundle rescue.
- **Upgrade cleanup** — when an episode or movie's video file disappears (a re-import, an
  upgrade, a manual delete), any sidecar Warrden placed for it is removed too, since a
  sidecar with no video beside it is just clutter. This is provenance-driven (it reacts to
  the video being gone, not to the webhook's own `isUpgrade` flag), so it also catches
  renames and out-of-band deletes, not just upgrades.

**Settle gate:** ingest for a target won't start sweeping until the arr's own import queue
shows nothing in progress for it — otherwise it would race a season-pack import that's
still landing files. It reschedules itself (uncounted against the job's retry budget)
every 2 minutes while the arr is still busy, up to 24 hours, after which it gives up and
raises an Attention item rather than waiting forever.

**Mount safety:** before touching the filesystem, ingest checks that every path in
`ingest.mountMarkers` exists (see the configuration reference below); a missing marker
pauses that job with an Attention item and a retry, rather than silently treating an
unmounted NAS share as "nothing to sweep."

**Destruction limits:** Warrden never deletes or overwrites a file it didn't place itself.
Concretely: it only ever removes a sidecar that has its own `placed_files` provenance row;
it refuses to place a file where something already exists with no such row (a "foreign"
file); and it refuses to overwrite a slot another still-live sidecar's provenance already
claims. A file Warrden placed that goes missing by hand — while its source torrent and
target video both still exist — is simply re-copied back into place on the next ingest run
for that target (the next webhook, or the next reconciliation pass); it isn't a permanent
deletion, just an undone one.

**Bundle rescue requires `ingest.downloadRoots`:** the leftover-video sweep only runs for a
torrent's own source folder once that folder resolves through a configured
`ingest.downloadRoots` entry — a folder Warrden can't place under a configured root falls
back to a narrower, dirname-only guess that's excluded from bundle rescue on purpose (it
can be a download client's shared "completed" folder, not something scoped to just this
torrent). Without a matching entry, bundle rescue for that torrent is a no-op; sidecar
rescue and stuck-import-by-`downloadId` rescue are unaffected. `ingest.downloadRoots` is
therefore effectively required for bundle rescue to do anything. See the example below.

## Configuration reference

All configuration lives in `config.json` inside the data directory and is editable from
the dashboard's Config page. Fields not set fall back to the defaults below.

| Field | Default | Description |
| --- | --- | --- |
| `server.port` | `9797` | Port the HTTP server (API + dashboard) listens on. |
| `server.publicUrl` | `http://localhost:9797` | URL Warrden advertises to the arrs when self-registering its webhook; must be reachable from them. |
| `arrs[].name` | — | Unique label for the instance; also the key used internally, so renaming one requires re-entering its API key. |
| `arrs[].kind` | — | `sonarr` or `radarr`. |
| `arrs[].baseUrl` | — | Base URL of the arr instance. |
| `arrs[].apiKey` | — | API key for the arr instance. |
| `pathMappings[].from` / `.to` | `[]` | Translates a path the arr reports (`.from`) into Warrden's own filesystem view (`.to`) — needed whenever Ingest's filesystem work sees the same files under a different mount point than the arr does. Not used by Acquire, which never touches files directly. |
| `ingest.mountMarkers` | `[]` | Warrden-local paths that must exist before Ingest touches the filesystem — typically a canary file at the root of each mounted share. Empty means no mount verification. |
| `ingest.downloadRoots` | `[]` | Arr-side paths of the torrent clients' download roots, used to find each torrent's own folder. Effectively required for bundle rescue (see [Ingest](#ingest) above) — without it, bundle rescue never fires. |
| `picking.tags` | `[]` | Freeform tags describing release preferences, folded into the LLM's picking policy. |
| `picking.seederFloor` | `3` | Minimum seeders a candidate must have to be considered. |
| `picking.minSizeMB` | `50` | Minimum release size, in MB, to filter out sample/junk releases. |
| `picking.maxSizeMB` | `60000` | Maximum release size, in MB, to filter out oversized releases. |
| `llm.activeProfile` | `prod` | Which of `llm.profiles` (`dev` or `prod`) is currently in effect. |
| `llm.profiles` | `{ dev: {}, prod: {} }` | Per-profile, per-call-site model configuration (provider, model, optional fallback). Call-sites: `release-pick` (Phase 1); `sidecar-match`, `bundle-map` (Phase 2, Ingest). |
| `llm.keys.openrouter` / `.openai` / `.anthropic` | unset | API keys for the corresponding LLM provider. Not required for the `claude-code` provider, which uses subscription auth instead. |
| `reconcileIntervalMinutes` | `15` | How often the reconciliation loop diffs each arr's full series/movie list against what Warrden has already seen, as a backstop for missed webhooks (both Acquire and Ingest). The same interval also doubles as the grace period before a newly-registered `warrden-` tag/profile becomes eligible for garbage collection. |

Secrets (`arrs[].apiKey`, `llm.keys.*`) are shown as `•••` on the Config page once set.
Leave a field as `•••`, or retype it to rotate it. For `llm.keys` specifically, clearing
a field back to blank is *also* a no-change — a blank field only means "never set" if it
was already blank when the page loaded; to actually delete a stored `llm.keys` value, use
that field's "Remove stored key" checkbox. (`arrs[].apiKey` has no such checkbox — it's a
required field, so blanking it is rejected outright rather than treated as a deletion;
remove the whole arr instance to drop it.)

### Example: mount markers and path mappings

A NAS share mounted at `/mnt/media` on the machine running Warrden, but seen as `/data`
by Sonarr (a common split when the arr runs in its own container with a different bind
mount):

```json
{
  "pathMappings": [{ "from": "/data", "to": "/mnt/media" }],
  "ingest": {
    "mountMarkers": ["/mnt/media/.warrden-mount-ok"],
    "downloadRoots": ["/data/torrents"]
  }
}
```

`/mnt/media/.warrden-mount-ok` is any file that only exists once the share is actually
mounted — an empty placeholder dropped at the mount root works fine. `/data/torrents` is
the download client's root as Sonarr sees it, not as Warrden sees it: `downloadRoots` is
matched against arr-reported paths before `pathMappings` translates them.

## More detail

See [`docs/specs/2026-08-05-warrden-design.md`](docs/specs/2026-08-05-warrden-design.md)
for the full design: architecture, pipelines, error handling, and phasing.
