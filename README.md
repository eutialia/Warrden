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

This is Phase 3 of the project: release acquisition (Phase 1), ingest (Phase 2), and the
subtitle pipeline (this phase). See the design spec linked below.

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
  -v /path/to/Series:/tv \
  -v /path/to/Anime:/anime \
  -v /path/to/Movies:/movies \
  -v /path/to/Downloads:/downloads \
  warrden
```

Warrden always expects **exactly four media mounts** (not editable in the dashboard):

| Role | Container path | What to bind |
| --- | --- | --- |
| **Series** | `/tv` | Sonarr Series root folder |
| **Anime** | `/anime` | Sonarr Anime root folder |
| **Movies** | `/movies` | Radarr library root |
| **Downloads** | `/downloads` | Torrent client download / completed root |

Using a named volume (`warrden-data` above) rather than a bind mount for `/data` lets Docker
set its ownership to match the container's non-root user automatically; a bind-mounted host
directory needs to be pre-owned by uid/gid `1000` for the same reason.

On first start, Warrden writes a default `config.json` into the data volume and serves a
dashboard at `http://<host>:9797`. Before adding any arr instance, set `server.publicUrl`
on the **Config** page to a URL your Sonarr/Radarr instances can reach the container at —
this is the address Warrden registers as its own webhook. Registration is by name
(`"Warrden"`) and re-checked on every startup, not a one-time thing: whenever the
Warrden-named webhook on an instance isn't subscribed to both On Download and On Upgrade,
it's (re)created at the *then-current* `publicUrl`. If there's no webhook at all yet, one
is simply created. If one already exists but isn't fully subscribed — a Phase 1-vintage
webhook that predates those events, or one a human unticked "On Import" on by hand in the
arr's own settings — it's deleted first, then recreated the same way. Either way this
check runs again every startup, so fixing a bad state is just a container restart away,
however it got into that state. A webhook already subscribed to both is left alone;
changing `publicUrl` afterward does **not** re-point it — delete the "Warrden" webhook in
the arr's own settings first if you need to move it. If a delete-then-recreate fails
partway (the delete lands but the create doesn't, even after one immediate retry), the
instance is left with no Warrden webhook at all until the next startup tries again. Then
add your arr instances (name, kind, base URL, API key), set picking preferences, and choose
an LLM provider. Storage mounts are fixed at container create time — check them under
**Settings → Storage mounts**.

Every config save requires a container restart to fully take effect (the save
confirmation says so) — some fields are read live, but arr connections and the LLM
provider/keys are only wired up at startup.

**Tested against:** Acquire (Phase 1) is live-verified against Sonarr v4. The
release-profile API shape Warrden relies on for pinning assumes Sonarr v4 or newer.
Ingest's movie path is live-verified against a real Radarr v5 over SMB mounts: sidecar
sweep with deterministic language tagging, the size-match source fallback for a movie
with no import history, the extra-video stem guard (side-story subs refused), the
foreign-file guard (a hand-placed sidecar left untouched), the stuck-import rescue
filters (22 real leftover videos, all correctly refused), and idempotent re-runs. The
series ingest path, LLM sidecar/bundle matching, and bundle-rescue execution are covered
by unit and integration tests against mocked arr/LLM/filesystem behavior but not yet
live-verified.

## Ingest

Ingest runs once per target per import burst (an on-download/on-upgrade webhook enqueues a
job for that target; anything else that lands while it's still pending folds into that same
row, and anything that lands while a run is already in progress is folded into a single
follow-up run rather than one job per webhook; a reconciliation-loop backstop covers
anything a webhook missed entirely) and rescues what the arr's own import leaves behind:

- **Sidecar rescue** — sweeps the torrent's own source folder(s) for `.mka` audio and
  `.srt`/`.ass` subtitle files the arr doesn't import on its own, and copies (never moves —
  the torrent keeps seeding) each one into place beside its video, renamed to the arr's own
  convention. For a series, each sidecar is matched to the episode it belongs to —
  filename matching first, one batched LLM call (the `sidecar-match` call-site) for
  anything cryptic. A movie has only ever one file to attach to, so there's no LLM
  matching step for movies — but a torrent folder shipping more than one video (a main
  film plus a side-story/extra, each with its own same-named subtitle set) still gets a
  deterministic check: a sidecar attaches to the movie's file unless a sibling video in
  the same folder shares its filename stem and isn't the video the arr actually imported,
  in which case it's skipped as that extra's own caption instead. For a movie with no
  import history to find its torrent folder from (imported before Warrden existed, or old
  enough to have aged out of arr history), the source folder is instead re-derived by an
  exact file-size match against the movie's current file — see `ingest.downloadRoots`
  below.
- **Bundle rescue (series only)** — a season-pack torrent the arr only partially imports
  leaves whole leftover episode files behind; these are mapped to season/episode
  (deterministic parsing first, an LLM call — the `bundle-map` call-site — plus the arr's
  own episode list for absolute numbering and specials) and pushed through the arr's
  manual-import API in copy mode. A high/medium-confidence mapping imports immediately; a
  low-confidence one is proposed as an **Attention** item instead, and only runs once a
  human accepts it. Movies have no equivalent stage — a leftover video in a movie's own
  torrent folder is always treated as an extra (trailer, behind-the-scenes, ...) and is
  never auto-imported as the movie itself.
- **Stuck-import rescue** — retries anything the arr's own manual-import queue gave up on.
  For a series, this is folded into bundle rescue's own mapping pass above. For a movie,
  it's simpler and LLM-free: each stuck item (after dropping anything the arr already
  rejected, or that names a different movie) maps 1:1 onto the job's own movie — there's
  only one file to map to, so there's nothing to pick between. Either way, a movie that
  already has a file on disk gets the same treatment as bundle rescue's low-confidence
  case: proposed as an **Attention** item instead of executed, since replacing an existing
  file is a human decision.
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
`ingest.mountMarkers` exists (see the configuration reference below). A missing marker
raises an Attention item and reschedules the job — same uncounted-reschedule shape as the
settle gate above, not a counted retry — every 5 minutes until every marker is back,
rather than silently treating an unmounted NAS share as "nothing to sweep."

**Destruction limits:** Warrden never deletes or overwrites a file it didn't place itself.
Concretely: it only ever removes a sidecar that has its own `placed_files` provenance row;
it refuses to place a file where something already exists with no such row (a "foreign"
file); and it refuses to overwrite a slot another still-live sidecar's provenance already
claims. A file Warrden placed that goes missing by hand — while its source torrent and
target video both still exist — is simply re-copied back into place on the next ingest run
for that target (the next webhook, or the next reconciliation pass); it isn't a permanent
deletion, just an undone one.

**`ingest.downloadRoots` is required for more than just bundle rescue:** the leftover-video
sweep only runs for a torrent's own source folder once that folder resolves through a
configured `ingest.downloadRoots` entry — a folder Warrden can't place under a configured
root falls back to a narrower, dirname-only guess that's excluded from bundle rescue on
purpose (it can be a download client's shared "completed" folder, not something scoped to
just this torrent). Without a matching entry, bundle rescue for that torrent is a no-op;
sidecar rescue and stuck-import-by-`downloadId` rescue are unaffected — but only as long as
import history exists for the target AND its recorded folder still exists locally. For a
movie missing either (no history at all, or a folder that's since vanished), ingest instead
re-derives the source folder by an exact file-size match scanned across
`ingest.downloadRoots` itself, so for that case `downloadRoots` is required for sidecar
rescue to find anything too, not just bundle rescue. See the example below.

## Subtitle pipeline

The subtitle pipeline covers a target's videos with external subtitles in the configured
languages, rescuing what the arr never fetches itself. It runs when episodes/movies still
miss any target language, triggered automatically as a follow-on to ingest, or by hand with
`POST /api/subtitle` (`{ arrInstance, targetKind, targetId }`) from the dashboard or an API
call. **Series and movies both use this path** (ingest sidecars still cover packs that already
shipped `.srt`/`.ass`; site search covers the rest). Preferred fansub groups and the pinned
acquire release group are soft ranking hints only — never hard filters.

The flow per series run:

1. **Reconcile** — `ffprobe` inventories every on-disk episode file and its embedded
   subtitle streams; episodes that already carry *every* configured language (embedded or
   external) need nothing.
2. **Archive cache** — a previously-downloaded subtitle pack cached under
   `dataDir/subtitle/cache` is matched against still-missing episodes before any new
   download, so a mid-season episode that landed after its pack was fetched reuses the pack
   instead of re-fetching it.
3. **Per-site search** — each configured `subtitle.sites` entry is searched one at a time in
   order, stopping once nothing is missing. Each site is driven by a browser agent (see
   v1 scope below) that downloads the archive, which is extracted and cached.
4. **Archive mapping** — each archive's files are matched to episodes: deterministic
   filename parsing first (the `archive-map` call-site covers whatever's cryptic).
5. **Drift gate** — every candidate is compared against the episode's own embedded subtitle
   track (extracted with ffmpeg). In-sync candidates are placed as-is; a drifted one is
   resynced with `alass`, then `ffsubsync` if that doesn't land in-sync, and placed only if
   it then scores in-sync; a candidate with no embedded reference is placed `unverified`
   without resync. An unscorable or never-landed candidate is moved to
   `dataDir/subtitle/quarantine`.
6. **Atomic placement** — survivors are copied (never moved, and never overwriting a file
   Warrden didn't itself place) beside their video under the arr's naming convention, each
   recorded in `placed_files` provenance.

Any episode with no survivor after the cache and every site, and every quarantined
candidate, raises an **Attention** item — these are gaps the pipeline couldn't close on its
own.

**v1 scope:** the site-search path uses a **protocol adapter** when the configured site
matches one (today: **subhd.tv** — structured search, LLM pack pick, cookie-warm download,
one automated captcha attempt), otherwise the generic HTML agent with fetch tiers `curl`
and `chromium`. Archives: zip/tar/tar.gz natively; **rar/7z** via `7z` or `unrar` on PATH
(the container image includes `p7zip-full`).

**External tool requirements:** the pipeline shells out to `ffprobe`/`ffmpeg` (probing and
embedded-track extraction), `alass`/`ffsubsync` (drift resync), and a headless chromium for
the browser tier. The shipped container bundles them, but the pipeline degrades gracefully
rather than failing to boot if one is absent. Missing `alass` skips straight to `ffsubsync`;
if *both* resync tools are missing, a drifted candidate can't be resynced and is
quarantined instead. `ffprobe`/`ffmpeg` are effectively required — without them, no
reconcile or drift gate can run. None of these are needed at build time in a bare
checkout; they're only consumed at runtime.

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
| `pathMappings[].from` / `.to` | `[]` | **config.json only** (not in the web UI). Translates a path the arr reports (`.from`) into Warrden's container path (`.to`). `to` should be one of `/tv`, `/anime`, `/movies`, `/downloads`. Empty means Sonarr/Radarr already use those same paths. |
| `ingest.mountMarkers` | `[]` | **Legacy/test only.** Empty → enforce the four standard mounts `/tv`, `/anime`, `/movies`, `/downloads`. Non-empty overrides that list (not exposed in the UI). |
| `ingest.downloadRoots` | `[]` | **Legacy/test only.** Empty → derive the arr-side download root from `pathMappings` targeting `/downloads`, else `/downloads`. Used to find each torrent's own folder for bundle rescue and the movie size-match fallback. |
| `subtitle.languages` | `[]` | Target subtitle languages for the subtitle pipeline, most-wanted first (e.g. `["zh-Hans", "zh-Hant"]`). A video is considered covered only when it carries *every* one as an embedded or external track. |
| `subtitle.preferredGroups` | `[]` | Soft rank boost for fansub/release group names when browsing packs. Never exclusive — if none match, search continues with other groups. |
| `subtitle.sites[].name` | — | Unique label for a subtitle fan site the pipeline searches. |
| `subtitle.sites[].baseUrl` | — | Base URL of the site; registered as the site's profile root. |
| `subtitle.sites[].searchUrlTemplate` | omitted | Search-page URL with `{query}` where the URL-encoded search term goes. Optional: without it the agent must discover the search endpoint itself (recorded into the site profile on success). |
| `browser.stepBudget` | `20` | Hard ceiling on LLM steps (tool calls) for one site-search agent run against a single site. |
| `browser.siteCooldownSeconds` | `30` | Polite re-hit floor per site after a failure; exponential on repeated failures, capped at 6h. |
| `picking.tags` | `[]` | Freeform tags describing release preferences, folded into the LLM's picking policy. |
| `picking.seederFloor` | `3` | Minimum seeders a candidate must have to be considered. |
| `picking.minSizeMB` | `50` | Minimum release size, in MB, to filter out sample/junk releases. |
| `picking.maxSizeMB` | `60000` | Maximum release size, in MB, to filter out oversized releases. |
| `llm.activeProfile` | `prod` | Which of `llm.profiles` (`dev` or `prod`) is currently in effect. |
| `llm.profiles` | `{ dev: {}, prod: {} }` | Per-profile, per-call-site model configuration (provider, model, optional fallback). Call-sites: `release-pick` (Phase 1); `sidecar-match`, `bundle-map` (Phase 2, Ingest); `archive-map`, `site-search` (Phase 3, Subtitle). |
| `llm.keys.openrouter` / `.openai` / `.anthropic` | unset | API keys for the corresponding LLM provider. Not required for the `claude-code` provider, which uses subscription auth instead. |
| `reconcileIntervalMinutes` | `15` | How often the reconciliation loop diffs each arr's full series/movie list against what Warrden has already seen, as a backstop for missed webhooks (both Acquire and Ingest). The same interval also doubles as the grace period before a newly-registered `warrden-` tag/profile becomes eligible for garbage collection. |

Secrets (`arrs[].apiKey`, `llm.keys.*`) are shown as `•••` on the Config page once set.
Leave a field as `•••`, or retype it to rotate it. For `llm.keys` specifically, clearing
a field back to blank is *also* a no-change — a blank field only means "never set" if it
was already blank when the page loaded; to actually delete a stored `llm.keys` value, use
that field's "Remove stored key" checkbox. (`arrs[].apiKey` has no such checkbox — it's a
required field, so blanking it is rejected outright rather than treated as a deletion;
remove the whole arr instance to drop it.)

### Example: path mappings (config.json only)

Warrden always uses `/tv`, `/anime`, `/movies`, and `/downloads` inside the container. If
Sonarr/Radarr see those libraries at different paths, map them in `config.json` (Settings
will not edit this):

```json
{
  "pathMappings": [
    { "from": "/mnt/nas/Media/Series", "to": "/tv" },
    { "from": "/mnt/nas/Media/Anime", "to": "/anime" },
    { "from": "/mnt/nas/Media/Movies", "to": "/movies" },
    { "from": "/mnt/nas/Downloads", "to": "/downloads" }
  ]
}
```

With that mapping, the arr-side download root used for torrent-folder detection is
`/mnt/nas/Downloads` automatically. Prefer matching Sonarr/Radarr bind mounts to the
same four paths so `pathMappings` can stay empty.

Dev / non-Docker path overrides (not in the UI): `WARRDEN_MOUNT_SERIES`,
`WARRDEN_MOUNT_ANIME`, `WARRDEN_MOUNT_MOVIES`, `WARRDEN_MOUNT_DOWNLOADS`.

## Design rules

The dashboard is an operator tool: dense, quiet when things are fine, loud only when a
human has to decide something. Three rules carry the look, and breaking any one of them
is what makes a screen stop matching the rest.

1. **Colour means state, never decoration.** Warm greige is the whole surface palette. Hue
   appears only for success / warning / info / destructive, and only through `ToneBadge`,
   `StatusBadge`, `StatusDot` or `PipelineBadge`. Categories — which pipeline a job belongs
   to, what kind of object a row is — get an icon and a neutral chip. A screen that colours
   categories reads as a rainbow and destroys the signal.
2. **Cards have no fill, no shadow, no corner.** Separation comes from a hairline rule and
   whitespace, never a box. If a surface genuinely needs to lift off the page it is a
   popover, not a card.
3. **Newsreader for titles and numbers, Instrument Sans for everything else, Geist Mono for
   machine strings.** Titles sit at weight 400 — the serif carries the emphasis. Never mono
   for prose, never sans for a large number or a release name.

Both themes are complete, so never hand-write a `dark:` colour override. The full contract,
including the class vocabulary, lives in
[`.design-sync/conventions.md`](.design-sync/conventions.md), which also ships as the
design system's README.

## More detail

See [`docs/specs/2026-08-05-warrden-design.md`](docs/specs/2026-08-05-warrden-design.md)
for the full design: architecture, pipelines, error handling, and phasing.
