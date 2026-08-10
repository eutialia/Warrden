# Deferred: where the design describes more product than exists

The Studio redesign came with a five-screen mock (Queue, Needs review, Subtitles,
History, Settings). Its own handoff says it is *"a design reference, not a spec —
page structure and content are a best guess at Warrden's features"*, and that is
what it turned out to be: several screens show data the agent does not record and
decisions it does not currently make.

The rule applied while implementing it: **where the design and the code disagree,
the code wins.** Every layout and token rule was applied against data that already
exists; nothing here had a backing field invented so a mock could render.

What follows is the difference. None of it is a bug, and none of it blocks the
redesign — each row is a product decision about what Warrden should *do*, which is
why it is written down rather than built.

## The gaps

| # | Design shows | Exists today | What building it takes |
| --- | --- | --- | --- |
| 1 | **Needs review: two candidates side by side** — scores (92 vs 89), size, group reputation ("unproven" / "46 accepted"), and Take REPACK / Take FLUX | Attention kinds are `acquire.no-candidates` and `acquire.none-viable`. Candidate arrays live in `acquire_records.candidates_json`, but nothing raises an item for a *close call*, and there is no per-candidate score | A "too close to call" attention kind raised by the refiner at a configurable margin, the candidate rows carried on the item, and a pick-this-one endpoint. Depends on #4 |
| 2 | **Import conflict** — the file on disk against the new one with both sizes, and Replace / Keep both / Discard | `ingest.rescue-proposed` carries a proposed file list (already rendered), but no comparison against what is on disk and no three-way outcome | Stat the destination during rescue, store both sizes on the item, add the two extra outcomes |
| 3 | **Poster thumbnails** (52×78) beside each review item | No artwork is stored and there is no image proxy | A proxy route against the arr's `MediaCover` API plus a cache. Small, and purely cosmetic |
| 4 | **Subtitle confidence and timing drift** per match, a 0.85 floor, and Held / Applied / Rejected outcomes | `placed_files.data` records neither. The sidecar matcher makes a yes/no decision with no score attached; the floor is invented | The matcher has to emit a score and a drift measurement, stored per placed file. **The one that would make Needs review honest** — it turns "couldn't decide" into a number you can tune |
| 5 | **Sources with account state** (VIP quota, token set, rate-limited), hits over 7 days, and a per-source on/off switch | `site_profiles` has access tier, notes, fail count, last success and last failure. No credentials, no counters, no enable flag | An `enabled` column and a hit counter are small. Account and quota state means per-site credential handling, which is a much larger piece |
| 6 | **Agent thresholds** in Settings — subtitle floor, score tie window, always-hold-unproven-groups, overwrite-larger-files | None exist. Config has `picking.seederFloor`, size bounds, and the browser's step budget and cooldown | Each is a pipeline behaviour before it is a field: the refiner and matcher have to consult them. Largely follows from #1 and #4 |
| 7 | **Per-instance reachability** — a dot and "last event 2m ago" in Connections | Not probed. The standing stance is that the dashboard does not report the liveness of Warrden or of other applications | A reachability ping per arr. Blocked on the stance rather than on effort — arr reachability may be worth an exception, since an unreachable arr does stop work |
| 8 | **Webhook secret** per instance, pasted into the arr's Connect settings | No such concept. The arrs authenticate with an API key, and the webhook route trusts the public URL | A shared secret generated per instance and verified on the webhook route. Worth doing on its own merits, independent of the design |
| 9 | **Global search** and breadcrumbs in the top bar | Activity has its own search. No cross-page search, no breadcrumbs | A search endpoint over jobs, attention items and placed files. Breadcrumbs alone are trivial, but say little with a five-item sidebar |

## Reading order, if it helps

**#4 first.** It unblocks #1 and #6, and it is the difference between Needs review
saying "I could not decide" and saying why.

**#8 regardless.** It is a security improvement that happens to appear in a mock,
not a design request.

Everything else is taste or convenience, and can wait for a reason to exist.

## What was built instead

The parts of the mock the code could already answer are done: the day-grouped
history, the queue table, the mount capacities, the last-24-hours counters, the
7-day clean rate, the source ordering and health dots, and the whole token and
layout system. See `.design-sync/conventions.md` for the rules those follow.
