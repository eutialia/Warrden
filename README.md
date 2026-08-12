# Warrden

Warrden is a housekeeping agent for Sonarr and Radarr. It picks the right release out of
a messy candidate list with an LLM policy and grabs it through the arr's own API, rescues
the files the arr's import leaves behind (audio and subtitle sidecars, leftover episodes
from season packs, stuck imports), and fetches external subtitles from fan sites when a
video still misses a configured language. Downloading and importing stay with
Sonarr/Radarr and the torrent client; Warrden does the decisions and cleanup they can't.

## Quickstart

Warrden is a single container. It needs a data directory for its SQLite database and
config, and network access to your arr instances. There's no published image yet, so
build it from a checkout:

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

Warrden always expects exactly these four media mounts (they aren't editable in the
dashboard):

| Role | Container path | What to bind |
| --- | --- | --- |
| Series | `/tv` | Sonarr Series root folder |
| Anime | `/anime` | Sonarr Anime root folder |
| Movies | `/movies` | Radarr library root |
| Downloads | `/downloads` | Torrent client download / completed root |

Prefer a named volume for `/data` (as above): Docker sets its ownership to the
container's non-root user for you. A bind-mounted host directory has to be pre-owned by
uid/gid `1000`.

On first start, Warrden writes a default `config.json` into the data volume and serves a
dashboard at `http://<host>:9797`. Before adding any arr instance, set `server.publicUrl`
on the Config page: that's the address Warrden registers as its own webhook, so your arrs
must be able to reach it. The webhook (named "Warrden") is re-checked on every startup
and recreated whenever it's missing or not subscribed to both On Download and On
Upgrade, so a restart repairs a broken registration. A healthy webhook is left alone,
which also means changing `publicUrl` later does not re-point it; delete the "Warrden"
webhook in the arr's own settings first if you need to move it.

Then add your arr instances (name, kind, base URL, API key), set picking preferences,
and choose an LLM provider. Config saves need a container restart to fully apply; some
fields are read live, but arr connections and LLM keys are only wired up at startup.

Tested against: acquire is live-verified on Sonarr v4, and the release-profile pinning
assumes v4 or newer. The movie ingest path is live-verified on Radarr v5 over SMB
mounts, including the size-match fallback, the foreign-file guard, and the stuck-import
filters. Series ingest and the LLM matching steps are covered by unit and integration
tests against mocked arrs, but haven't had a live pass yet.

## Ingest

Ingest runs once per target per import burst: webhooks enqueue a job, further webhooks
fold into it instead of piling up, and a reconciliation loop catches anything a webhook
missed. Before touching the filesystem it waits for the arr's import queue to go idle
for that target and checks that all four mounts are really mounted; either condition
reschedules the job (without burning a retry) rather than sweeping a half-imported
season pack or an unmounted NAS share.

- **Sidecar rescue.** Copies `.mka` audio and `.srt`/`.ass` subtitles from the torrent's
  folder into place beside their video, renamed to the arr's convention. Always a copy,
  never a move, so the torrent keeps seeding. Series sidecars are matched by filename
  first, with one batched LLM call for the cryptic rest. Movies skip the LLM but keep a
  filename-stem guard so a bundled extra's subtitles don't get attached to the main
  film. A movie with no usable import history gets its source folder re-derived by an
  exact file-size match across `ingest.downloadRoots`.
- **Bundle rescue (series only).** Maps leftover episode files from partially imported
  season packs (parsing first, LLM for the rest) and pushes them through the arr's
  manual-import API in copy mode. A low-confidence mapping is proposed as an Attention
  item and waits for a human instead of importing.
- **Stuck-import rescue.** Retries what the arr's manual-import queue gave up on.
  Replacing a file that already exists on disk is always a human decision, so that case
  is proposed as an Attention item too.
- **Upgrade cleanup.** When a video file disappears (upgrade, rename, manual delete),
  the sidecars Warrden placed beside it are removed as well.

Warrden never deletes or overwrites a file it didn't place itself. Every placement is
recorded in a provenance table, and a file without a provenance row is treated as
foreign and left alone. Note that bundle rescue only sees a torrent folder it can
resolve under `ingest.downloadRoots` (derived from the `/downloads` path mapping by
default); a folder outside every configured root is excluded from it on purpose.

## Subtitle pipeline

The subtitle pipeline covers a target's videos with external subtitles in the configured
languages. It runs as a follow-on to ingest, or on demand via `POST /api/subtitle`
(`{ arrInstance, targetKind, targetId }`). Preferred fansub groups and the pinned
release group are soft ranking hints, never hard filters. Each run:

1. `ffprobe` inventories every video and its embedded subtitle tracks; a video that
   already carries every configured language needs nothing.
2. Previously downloaded packs in the archive cache are matched against what's missing
   before anything new is fetched.
3. Configured sites are searched in order until nothing is missing, each driven by a
   browser agent with `curl` and `chromium` fetch tiers. The agent keeps its own
   knowledge file per site under the data directory (`sites/<host>.md`), seeded on
   first use from `seeds/sites/` when a ready-made one exists (subhd.tv ships in the
   image) and otherwise starting empty. The file is hand-editable at any time; a
   `## Operator notes` section is reserved for the operator and the agent never
   writes to it. After a successful run the agent updates the rest of the file with
   what it learned, so a site's protocol gets cheaper to work with over time.
4. Each archive's files are matched to episodes: filename parsing first, an LLM call
   for the cryptic rest.
5. Every candidate is scored against the episode's embedded track. A drifted candidate
   is resynced with `alass`, then `ffsubsync`, and placed only if it then scores
   in-sync; one with no embedded reference is placed unverified; an unscorable one is
   quarantined.
6. Survivors are copied into place under the arr's naming convention and recorded in
   provenance, with the same never-overwrite rule as ingest.

Whatever the pipeline can't close (no survivor after every site, or a quarantined
candidate) raises an Attention item.

The pipeline shells out to `ffprobe`/`ffmpeg` (effectively required), `alass` and
`ffsubsync` (drift resync, optional), `7z`/`unrar` (rar/7z archives), and a headless
chromium for the browser tier. The container image bundles all of them; a bare checkout
degrades gracefully when one is missing rather than failing to boot.

## Configuration reference

All configuration lives in `config.json` inside the data directory and is editable from
the dashboard's Config page. Unset fields fall back to the defaults below.

| Field | Default | Description |
| --- | --- | --- |
| `server.port` | `9797` | Port the HTTP server (API + dashboard) listens on. |
| `server.publicUrl` | `http://localhost:9797` | URL Warrden advertises to the arrs when registering its webhook. |
| `arrs[].name` | — | Unique label, also the internal key; renaming means re-entering the API key. |
| `arrs[].kind` | — | `sonarr` or `radarr`. |
| `arrs[].baseUrl` | — | Base URL of the arr instance. |
| `arrs[].apiKey` | — | API key for the arr instance. |
| `pathMappings[].from` / `.to` | `[]` | config.json only. Translates a path the arr reports into Warrden's container path; `to` should be one of the four standard mounts. Empty means the arrs already use those paths. |
| `ingest.mountMarkers` | `[]` | Legacy/test only. Empty enforces the four standard mounts. |
| `ingest.downloadRoots` | `[]` | Legacy/test only. Empty derives the arr-side download root from `pathMappings`. |
| `subtitle.languages` | `[]` | Target languages, most-wanted first (e.g. `["zh-Hans", "zh-Hant"]`). A video counts as covered only with every one present. |
| `subtitle.preferredGroups` | `[]` | Soft rank boost for fansub group names. |
| `subtitle.sites[].baseUrl` | — | Base URL of a subtitle site; this is the site's identity and its host is the label shown in the dashboard. |
| `subtitle.sites[].searchUrlTemplate` | omitted | Search URL with `{query}`. Without it the agent discovers the search endpoint itself. |
| `browser.stepBudget` | `20` | Ceiling on LLM steps for one site-search run. |
| `browser.siteCooldownSeconds` | `30` | Re-hit floor per site after a failure; exponential, capped at 6h. |
| `picking.tags` | `[]` | Freeform release-preference tags folded into the picking policy. |
| `picking.seederFloor` | `3` | Minimum seeders for a candidate. |
| `picking.minSizeMB` | `50` | Minimum release size in MB. |
| `picking.maxSizeMB` | `60000` | Maximum release size in MB. |
| `llm.activeProfile` | `prod` | Which of `llm.profiles` is in effect. |
| `llm.profiles` | `{ dev: {}, prod: {} }` | Per-call-site model config. Call-sites: `release-pick`, `sidecar-match`, `bundle-map`, `archive-map`, `site-search`, `site-notes`. Leaving `site-notes` unconfigured turns self-learning off — the agent still reads whatever knowledge file exists but never writes one back. |
| `llm.keys.openrouter` / `.openai` / `.anthropic` | unset | Provider API keys. The `claude-code` provider uses subscription auth and needs none. |
| `eventRetentionDays` | `30` | Days of event history to keep; `0` keeps everything. Items waiting on review are never trimmed. |
| `reconcileIntervalMinutes` | `15` | How often the reconciliation loop diffs each arr's full list as a webhook backstop; doubles as the grace period before a new `warrden-` tag/profile can be garbage-collected. |

Secrets show as `•••` once set. Leave them as `•••` to keep them, or retype to rotate.
Clearing an `llm.keys` field is not a deletion; use its "Remove stored key" checkbox.
`arrs[].apiKey` is required, so blanking it is rejected; remove the instance to drop it.

### Path mappings example

Warrden always uses `/tv`, `/anime`, `/movies`, and `/downloads` inside the container.
If Sonarr/Radarr see those libraries at other paths, map them in `config.json` (the
Settings page won't edit this):

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

With that mapping the arr-side download root is `/mnt/nas/Downloads` automatically. Best
is to give Sonarr/Radarr the same four container paths so `pathMappings` can stay empty.

Dev / non-Docker path overrides (not in the UI): `WARRDEN_MOUNT_SERIES`,
`WARRDEN_MOUNT_ANIME`, `WARRDEN_MOUNT_MOVIES`, `WARRDEN_MOUNT_DOWNLOADS`.

## Design rules

The dashboard is an operator tool: dense, quiet when things are fine, loud only when a
human has to decide something. Three rules carry the look. Colour means state, never
decoration: hue appears only for success / warning / info / destructive, through
`ToneBadge`, `StatusBadge`, `StatusDot` or the `TONE_*` maps behind them, while
categories get an icon and a neutral chip. Cards have no fill, shadow, or corner;
separation is a hairline rule and whitespace, and anything that genuinely lifts off the
page is a popover. Newsreader carries titles and numbers at weight 400, Instrument Sans
everything else, Geist Mono machine strings only.

Every colour, radius and font is a token in
[`web/src/tokens.css`](web/src/tokens.css); both themes are complete, so no page should
hand-write a `dark:` override.

## More detail

See [`docs/specs/2026-08-05-warrden-design.md`](docs/specs/2026-08-05-warrden-design.md)
for the full design: architecture, pipelines, error handling, and phasing.

## License

[GPL-3.0](LICENSE), like the arr ecosystem it sits behind.
