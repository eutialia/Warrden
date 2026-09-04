# Ingest

Ingest sweeps what the arr imported and rescues what it ignored: subtitle and audio sidecars, leftover videos from a multi-season pack, and items stuck at manual import. Code lives in `src/pipelines/ingest/`.

Trigger: Download webhook after the arr imported (or upgraded) a file, or reconcile catching a missed import. Download webhooks enqueue ingest with `notBefore = now + 30s`. The queue coalesces duplicates, so a webhook storm collapses to one run 30 seconds after the last webhook.

## Settle first

The arr's queue must show the source download fully processed before ingest sweeps. Otherwise the job reschedules. That avoids racing a season-pack import still in flight.

Clean `importPending` is busy: Sonarr is about to import. Stuck is `status: 'completed'` and (`trackedDownloadState: 'importBlocked'` or `trackedDownloadStatus: 'warning'`). Busy wins when both kinds of record are present. Bundle rescue re-assesses the live queue immediately before `executeManualImport` and defers if busy.

## Sidecars

Sweep the source folder for `.mka` audio and subtitle files (`.srt`, `.ass`). Fonts and other extras are ignored. Copy, never move, so seeding stays intact. Rename to the arr convention beside the imported file (`buildSidecarName`).

Match is deterministic filename parsing first (`sidecars.ts`). The LLM (`matchLlm.ts`, call-site `sidecar-match`) runs only when names are cryptic. Language tags on external sidecars follow Jellyfin's `ExternalPathParser` rule: the dot segments after the video stem. An unmatched sidecar raises `ingest.unmatched`. It does not open a scored hold queue.

## Bundle rescue

Leftover video files (a multi-season or specials torrent grabbed as one season) are mapped to series, season, and episode. Deterministic parse first, then LLM plus the arr's TVDB episode list for absolute numbering and specials (call-site `bundle-map`). The mapping is pushed through the arr manual-import API in copy mode. The arr does placement and renaming. Low-confidence matches raise Attention for approval rather than importing silently.

Items stuck at "manual import required" get the same treatment.

## Upgrades

On `isUpgrade`, delete stale Warrden-placed sidecars for that episode or movie first. Provenance-tracked files only. Then sweep fresh.

## Hand-off

A successful ingest queues a subtitle job for the same target, series and movies alike. The subtitle job is debounced through the singleton queue.
