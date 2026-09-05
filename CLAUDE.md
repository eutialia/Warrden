# CLAUDE.md

This is Warrden, the housekeeping agent behind Sonarr and Radarr. It runs for one person on a trusted LAN. `docs/` is the spec and the code is the truth; when they disagree, fix the doc. Product gaps go in the table in `docs/deferred-design-gaps.md`, not into the code.

# Things I have already decided

Don't re-open these. Argue with me if you think one is wrong, but don't quietly route around it.

- The arrs are the front-end. Warrden never downloads, imports, renames, or talks to the torrent client. If Sonarr already knows the answer, call its API instead of building anything.
- The LLM always picks the release, even when there's one candidate. A veto becomes an attention item with force-grab; it is never silently honored or overridden.
- Subtitle sites are data, not code: a URL plus one markdown knowledge file. No adapters, no provider classes, no Bazarr-style plugins. The agent writes knowledge only by add or update, never remove, and never touches `## Operator notes`.
- One decoder per archive format. No fallback chain, no "try the other tool."
- Language tags are BCP 47 with script subtags. A bare `.zh` is not recognized, on purpose. There is no Bazarr compatibility layer and there won't be.
- Events carry one normalized envelope of facts. Emitters write facts, the UI composes labels from facts, nobody regex-parses a message. A row that can't be migrated into the envelope gets deleted, not papered over with a fallback.
- The stuck-queue rules in ingest (importPending is busy, the ten-minute dwell, the re-check before ManualImport) each guard a real double-import I watched happen. Don't simplify them.

# How I like to work here

- Finishing a change means `/code-review --fix` and a conventional commit. Always ask for permission before pushing and creating a PR.
- Reuse what's there. `tests/helpers.ts` owns the fixtures; the shadcn components under `web/src/components/ui` are vendored, use them before writing your own.
- UI takes rounds. Mock it as a temporary route against the live app with real data, screenshot it with whatever browser you can access, iterate, then implement and delete the route. Fix the element that's wrong, not its container. Don't call it done after one pass.
- If you spawn workers, I watch them. Give workers the full spec (files, done-condition, scope fence) and let it run; it verifies itself, so skip the ritual, but it will widen the task if you let it. Poll anything long-running and tell me where it is without being asked.
- Docs are short and stated as fact. The README is an alpha checkout note and stays that size.
