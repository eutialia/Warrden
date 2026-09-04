# Deferred: where the design describes more product than exists

None of this is a bug, and none of it blocks running Warrden. Each row is a product decision about what Warrden should do next, which is why it is written down rather than built.

The rule while implementing: **where the design and the code disagree, the code wins.** Nothing here had a backing field invented so a mock could render.

## Studio mock vs the dashboard

The Studio redesign came with a five-screen mock. Its own handoff says it is a design reference, not a spec. Several screens show data the agent does not record and decisions it does not currently make.

| # | Design shows | Exists today | What building it takes |
| --- | --- | --- | --- |
| 1 | Needs review: two candidates side by side, scores, group reputation, Take REPACK / Take FLUX | Attention kinds are `acquire.no-candidates` and `acquire.none-viable`. Candidate arrays live in `acquire_records.candidates_json`, but nothing raises an item for a close call, and there is no per-candidate score | A "too close to call" attention kind raised at a configurable margin, the candidate rows on the item, and a pick-this-one endpoint. Depends on #4 |
| 2 | Import conflict: the file on disk against the new one, Replace / Keep both / Discard | `ingest.rescue-proposed` carries a proposed file list, but no comparison against what is on disk and no three-way outcome | Stat the destination during rescue, store both sizes on the item, add the two extra outcomes |
| 3 | Poster thumbnails beside each review item | No artwork is stored and there is no image proxy | A proxy route against the arr's `MediaCover` API plus a cache |
| 4 | Subtitle confidence and timing drift per match, a floor, Held / Applied / Rejected | `placed_files` records drift for the host gate, but the sidecar matcher is still yes/no with no score attached to the review item | The matcher emits a score stored per placed file. That is the one that would make Needs review honest |
| 5 | Sources with account state (VIP quota, token, rate-limited), hits over 7 days, per-source on/off | `site_profiles` has access tier, knowledge file, fail count, last success and last failure. No credentials, no counters, no enable flag | An `enabled` column and a hit counter are small. Account and quota state means per-site credential handling |
| 6 | Agent thresholds in Settings: subtitle floor, score tie window, always-hold-unproven-groups, overwrite-larger-files | Config has `picking.seederFloor`, size bounds, and the browser's step budget and cooldown | Each is a pipeline behaviour before it is a field. Largely follows from #1 and #4 |
| 7 | Per-instance reachability: a dot and "last event 2m ago" in Connections | Not probed. The standing stance is that the dashboard does not report the liveness of Warrden or of other applications | A reachability ping per arr. Blocked on the stance rather than on effort |
| 8 | Webhook secret per instance, pasted into the arr's Connect settings | No such concept. The arrs authenticate with an API key, and the webhook route trusts the public URL | A shared secret generated per instance and verified on the webhook route. Worth doing on its own merits |
| 9 | Global search and breadcrumbs in the top bar | Activity has its own search. No cross-page search, no breadcrumbs | A search endpoint over jobs, attention items, and placed files |

**#4 first.** It unblocks #1 and #6, and it is the difference between Needs review saying "I could not decide" and saying why.

**#8 regardless.** It is a security improvement that happens to appear in a mock, not a design request.

## Pipeline seams that are specified and not built

These are from the architecture, not from the mock.

- **Scheduled acquire backfill and dashboard "search now".** Reconcile only catches missed add events. It cannot see a title that was already in the library when Warrden bootstrapped, nor retry one that was searched once and found nothing. Both are the same gap: the arr listed something while Warrden was not in the loop. The Attention item for `no-candidates` / `none-viable` exists. The automatic decaying retry behind it does not. `POST /api/acquire` exists (re-run and curl). A wanted/missing picker on the dashboard does not.
- **VAD / golden-section drift reference.** When the video has no embedded subtitle track, the candidate places as `unverified`. `whisper.cpp` stays reserved for a later transcript spot-check.
- **Deep search via Prowlarr.** Dashboard-triggered alternate acquire path with LLM-generated term variants and arr release-push. Not in v1.
- **Per-site language declaration.** Site config is `baseUrl` plus optional `searchUrlTemplate`. Languages are global. A site that cannot serve the still-missing languages still gets a full browse run.
- **Parallel site search** within one job. Default remains serial until per-site rate limits and session isolation are solid.
- **Auth and notification channels.** v1 is trusted LAN and dashboard Attention only.
- **Bitmap / PGS OCR.** Attention and manual, not an automated path.

## Accepted residual risks

- An arr import that completes entirely within the rescue planning window can empty the queue, so the pre-execute re-check reads settled and rescue proceeds against a pre-import snapshot. Mitigated by the 10-minute rescue dwell and copy-mode imports.
- Bundle-import accept re-checks the queue (busy returns 409) but does not re-list with `filterExistingFiles` at accept time.
- Force-grab staleness compares against the attention item's `ts`, which refreshes on re-raise.
- `require_parameters: true` composed with json_schema output means a model/effort pairing with no eligible OpenRouter route fails jobs terminally instead of silently degrading.

## What was built instead of the mock extras

The parts of the mock the code could already answer are done: the folded activity list, the target drawer, the storage panel, the last-24-hours counters, source ordering and health, and the token and layout system in `web/src/tokens.css`.
