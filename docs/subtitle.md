# Subtitle

The subtitle pipeline covers videos that still lack a configured language after ingest. Browse finds a pack. Host code extracts, maps, scores drift, resyncs, and places. Code lives in `src/pipelines/subtitle/` and `src/media/`.

Trigger: after ingest (debounced singleton job), or a manual request. Series and movies both run. A movie is a single-title pack rather than a season pack.

A run succeeds when every video for the target has a placed, non-quarantined external track in any one of the configured languages. "Archive downloaded" is not success.

## Reconcile

`ffprobe` every on-disk video for the target. Determine which lack a configured language, embedded or external. None missing, done.

Coverage is any-of: one configured language is enough. Config `zh-Hans, zh-Hant` is satisfied by either, not both. Sidecar language is read from the segments after the video stem, the same way Jellyfin's `ExternalPathParser` does.

## Archive cache

A previously downloaded pack for this target may already cover new episodes or a re-import. The cache is tried before a site search. Entries whose files have left the disk are skipped.

## Browse, then host

Configured public sites are searched serially. Each site is one browse run with the site knowledge file injected. See [Site agent](site-agent.md). A downloaded archive is handed to the media pipeline:

1. Extract (zip, tar, 7z, rar). Nested packs unpack. GBK zip names, UTF-16/BOM/GBK text, and 0-byte files are handled. `7z` and `unrar` ship in the image.
2. Map files to episodes: deterministic parse, then LLM (`archive-map`). The model sees every episode the library has, with wanted gaps marked. A file that belongs to a season that is not wanted comes back as null rather than being forced onto a gap by number.
3. Drift gate, then place or quarantine.

Query variants come from the arr primary title, alternate titles, and title forms in the configured subtitle languages (`resolveTargetMeta`, `buildSearchHints`). Site UI language is not search language. Soft rank boosts: the pinned acquire group if any, and `subtitle.preferredGroups`. Neither is a hard filter. Drift is the quality gate.

## Drift gate

Host-owned, fully automatic (`src/pipelines/subtitle/drift.ts`). The reference is an embedded text track when the video has one. No embedded track, the candidate places as `unverified`. VAD or golden-section sampling is not built.

Scoring uses dialogue cues, not karaoke or typesetting. `dialogueCues` drops cues whose text contains karaoke or motion override tags (`\k`, `\pos(`, `\move(`, `\t(`, and kin). If too few dialogue cues survive, the filter is skipped so a fully `\pos`'d track still scores. A table shorter than `minScorableCues` (20) is `unscorable`, not a lucky accept.

`scoreAtOffset` returns the median of per-cue overlap, not the mean, so unmatched songs and signs in one track do not sink a synced file. Ties break toward zero offset.

| Result | What happens |
| --- | --- |
| `in-sync` (overlap at or above `acceptRatio` 0.80, offset within one step) | Place as-is |
| `drifted` | `alass`, then `ffsubsync` if needed. Re-score. Place if it lands. Else quarantine, try the next candidate |
| `unscorable` | Skip this candidate |

All candidates fail: Attention, residual gaps named per episode.

## Place

Atomic per arr naming (`buildSidecarName`). Provenance is recorded: site, original archive or filename, applied offset, drift label. Warrden deletes only files it placed.

Resync binaries are probed with the flag each one accepts (`ffprobe -version`, `alass --version`, `ffsubsync --version`) and get a 10-minute timeout, not the 30-second media-probe timeout.
