# Architecture

Warrden is an event-driven housekeeping agent that sits behind Sonarr and Radarr. You add a title in the arr. Warrden picks a release, rescues the files the arr's import leaves behind, and places matched, sync-checked subtitles. Downloading and importing stay with the arr and the torrent client.

Deterministic code does everything it can. The LLM runs only where it beats traditional code, in three roles:

1. **Release picking.** Choose a release from messy candidate titles against your policy.
2. **Fuzzy matching.** Map cryptic filenames, archive contents, and leftover videos in a pack.
3. **Subtitle site browsing.** The one multi-step agent loop: navigate a public site, pick a pack, download it.

Everything else is host code: grabs through the arr API, copy and rename, archive extract, drift scoring, resync, placement.

## What v1 does not do

- Replace Sonarr, Radarr, Prowlarr, or the torrent client.
- Talk to the torrent client. Grabs and imports go through arr APIs only.
- Use private or login-required subtitle sources. Public sites only.
- Send notifications. Escalation is the dashboard Attention page.
- Integrate with a media server. Files follow arr naming so any server picks them up on scan.
- Run Bazarr in the loop. Warrden owns the subtitle lifecycle.
- OCR bitmap subtitle tracks (PGS, VobSub). Those go to Attention.
- Spin nested containers for media tools. `ffmpeg`, `ffprobe`, `alass`, `ffsubsync`, `7z`, and `unrar` live in the Warrden image.

## Pick once, then teach Sonarr

Warrden does not intercept routine grabs and does not use delay profiles. The arr stays authoritative for RSS, subscriptions, and import bookkeeping.

On add, or on a manual re-pick from the dashboard, Warrden runs interactive search and grabs through the arr's own release API. That looks like a human using interactive search.

For a Sonarr series, Warrden then pins future grabs by writing a release profile. Sonarr's RSS stays correct without Warrden in the weekly loop. Profiles are keyed per release group, not per series: one `warrden: [Group]` must-contain profile per group. Pinning a series attaches that group's tag. Fifty series across six groups is six profiles.

Radarr needs no teaching. Movies are one-shot grabs.

**Manage what we create.** Every object Warrden creates in an arr (tags, release profiles, the webhook notification) is registered in SQLite, visible and deletable on Arr objects, prefixed `warrden-` where it lives in the arr, and garbage-collected when the series is removed or re-pinned.

## Process shape

One TypeScript service. Docker, LXC, or a direct process. Components:

- **HTTP server** (`src/server/`) receives arr webhooks, serves the dashboard, and streams events over SSE.
- **SQLite in WAL mode** holds the job queue, event log, placed-file provenance, site profiles, managed-object registry, and debug traces. The Warrden process is the only writer.
- **Job queue** (`src/jobs/`) runs singleton jobs keyed `(pipeline, arrInstance, targetKind, targetId)` with a dirty-flag re-queue. Jobs are idempotent. Recovery is re-run, never resume-from-step. Waiting (settle, mount, backoff) is `not_before` on the job, not an LLM `wait` tool.
- **LLM layer** (`src/llm/`) wraps the Vercel AI SDK behind one configured `llm.model` (OpenRouter). Call-site names (`release-pick`, `site-search`, `site-notes`, and the matchers) are labels on traces and billing, not separate models. Leave `llm.model` unset and every LLM feature is off. The browse loop is Warrden's own step-budgeted loop; no agent framework owns control flow.
- **Filesystem** uses the same media the arrs use. `config.storage` names the four library paths. `pathMappings` translates arr-side paths when the arr and Warrden do not see the same tree. Mount liveness is checked before any filesystem work. See [Storage](storage.md).

The dashboard is a React SPA served by the same process. v1 assumes a trusted LAN: no auth.

## Two loops for subtitles

Subtitle work is two systems, not one mega-agent.

| Loop | Owns | Does not own |
| --- | --- | --- |
| **Browse agent** (`src/agent/`) | Query variants, site navigation, ranking and download of packs, one captcha attempt, learning into the site knowledge file | Library writes, resync, permanent placement |
| **Media pipeline** (`src/pipelines/subtitle/`, `src/media/`) | Extract, match, drift gate, resync (`alass` then `ffsubsync`), atomic place and provenance, quarantine | HTTP dances or free-form browsing |

The browse agent may call inspection tools. It must not `place` or `resync` without the host score gates. See [Site agent](site-agent.md) and [Subtitle](subtitle.md).

## Webhooks are hints. State is truth.

A reconciliation loop (`src/reconcile/`) polls arr library lists and import history on an interval (default 15 minutes) and diffs against local state. A missed webhook delays work. It never loses it.

On startup, and on every config save that changes arr instances or `server.publicUrl`, Warrden checks the webhook named "Warrden" on each arr. If a notification exists but is wrong, it updates in place (`PUT`). If none exists, it creates one. It never deletes then creates. An end state with no working webhook is an Attention item, not a warning.

## Errors and destruction

- LLM outputs are schema-validated. Invalid output retries. A permanent provider error (4xx except 408 and 429, invalid prompt, structured-output exhaustion) fails the job on the first attempt and goes to Attention. Transient failures back off. Interactive search results are cached in memory per (job, season) for 30 minutes so a retry does not re-sweep every indexer.
- When reasoning effort is configured, OpenRouter requests set `provider.require_parameters: true` so routing stays on providers that honor it. A response that reports zero reasoning tokens against a requested effort emits `llm.effort-ignored`.
- Site failures are health events, not crashes: degrade the site, try the next one.
- A missing or stale storage path pauses filesystem work and raises Attention.
- Placement is temp name then rename, so a scanner never sees a partial file.
- Warrden never deletes or moves video files. Deletion rights cover only provenance-tracked files it placed itself.

## Concurrency

One active job per `(pipeline, arrInstance, targetKind, targetId)`. External state must be settled before acting on it.

- Triggers during a run set the dirty flag. The job re-queues once on completion. A season pack's worth of Download webhooks collapses into one ingest run. Ingest enqueue also waits 30 seconds (`notBefore`) so a webhook storm settles to one run after the last webhook.
- Ingest waits until the arr queue is no longer busy with that download. Clean `importPending` is busy (Sonarr is about to import), not stuck. Stuck is `status: 'completed'` and (`trackedDownloadState: 'importBlocked'` or `trackedDownloadStatus: 'warning'`). Busy wins when both kinds of record are present. Rescue re-checks the live queue immediately before `executeManualImport`.
- Per-site browser concurrency is 1. The global job runner is serial.
- SQLite WAL, single-process writer. Copy, never move, keeps the download dir owned by the torrent client.

## Where to read next

- [Pipeline overview](pipeline-overview.md) for the end-to-end sequence and the engine/agent split.
- [Acquire](acquire.md), [Ingest](ingest.md), [Subtitle](subtitle.md) for each pipeline.
- [Deferred gaps](deferred-design-gaps.md) for product the design describes that the code does not do yet.
