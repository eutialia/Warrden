# Acquire

Acquire picks a release from the arr's interactive search and grabs it through the arr API. After a successful Sonarr grab it pins the release group so RSS stays correct without Warrden in the weekly loop. Code lives in `src/pipelines/acquire/`.

Trigger: SeriesAdd / MovieAdded webhook, reconcile catching a missed add, or a manual re-pick from Attention or Activity.

## Season mode

Pack vs weekly is a facts question Sonarr already answered. `classifySeason` (`src/pipelines/acquire/seasonMode.ts`) reads `seasons[].statistics` before search. The LLM only ranks inside that shape.

| Mode | Rule | How we know |
| --- | --- | --- |
| **unaired** | Skip. No search, no LLM, no Attention item. | `episodeCount === 0` |
| **complete** | Pack-first. A single is fallback only if no acceptable pack remains. | `episodeCount === totalEpisodeCount` and no `nextAiring` |
| **airing** | Single-first (missing aired episodes). Packs only if no single survived. | some episodes remain, or a `nextAiring` is set |
| **unknown** | Search as before (top seeders). | Sonarr omitted statistics |

An unaired skip is not "no usable releases". A future-season listing on TVDB is not a miss.

## Search, filter, pick

1. Fetch the full interactive-search list from the arr API, unfiltered. Both packs and singles come back. Sonarr's UI "Season Pack" checkbox is a client-side `fullSeason` filter on this same list. Acquire does not send it, because singles are the fallback.
2. Deterministic pre-filter (`prefilter.ts`): drop arr-flagged rejections, apply `picking.seederFloor` and size bounds, collapse the same torrent across indexers by `infoHash` (keep the higher-seeded copy), then cap. Cap ranking is mode-aware: complete seasons keep packs first so weekly rips cannot drown the one season pack; airing seasons keep singles first.
3. Pick (`pick.ts`): the host builds an eligible set from season mode. The LLM is always called, even for a pool of one. A singleton short circuit that grabbed without a quality check was deleted. Prefer is a rank boost, never a veto. Avoid is semantic (dual/multi includes the original language). If the model names a candidate number, that is a pick even when it also says `none`.
4. Grab via the arr release API. The arr owns the download from here.
5. Sonarr only: attach the group-keyed release profile and tag (`pin.ts`). If a complete season fell back to a single, also fire Sonarr's `SeasonSearch` so the rest of the season backfills under the pin. Airing seasons do not get that kick. RSS stays in charge.

The model answers with a 1-based candidate number, never a guid. `pickRelease` maps that number back to the real candidate.

## Already satisfied

A re-pick against a title the arr already has must not raise "no candidates". `seasonSatisfaction` (`satisfied.ts`) compares `episodeFileCount` to aired `episodeCount`. A movie is satisfied when `hasFile` is true. When the arr omitted file counts, the fallback is rejection text (`Existing file meets cutoff`, `not an upgrade for existing`) and only then. The record is `already-satisfied`, the event is `acquire.already-satisfied`, and a stale Attention item for that target is resolved. Activity paints this as "Already have it", a settled success.

## None viable

If no candidate clears the bar after a real search, the job ends cleanly with an Attention item. In shape-owned modes (`complete` / `airing`), an LLM `none` becomes Attention carrying the top eligible candidate. Accept is force-grab: `POST /api/attention/:id/accept` with `data.accept.action === 'force-grab'`. Unknown and movie `none` stay a veto without that offer.

The item is re-triggerable. There is no automatic re-search loop yet. See [Deferred gaps](deferred-design-gaps.md).

## Steady-state cost

After a successful series pin, routine episodes no longer re-enter `release-pick`. Prompt caching on acquire is a first-run and re-pick optimization, not a weekly tax. Multi-step LLM cost concentrates on the subtitle browse agent.
