# Activity, Attention, and debug traces

The dashboard is an operator tool: dense, quiet when things are fine, loud only when a human has to decide something. Live updates travel over SSE. Pages: Overview, Activity, Needs review, Debug, Subtitle sources, Arr objects, Settings.

## Event envelope

Every `events.data` carries `{scope, action, facts?, verdict?}`. Emitters write facts. The UI composes labels from facts. `message` stays the human line for the CLI and `docker logs`.

Three rules (`src/events/envelope.ts`):

- **Facts, never display strings.** `facts.season` is `4`, not `"Season 4"`. The one exception is `facts.detail`, which is prose the LLM itself wrote.
- **Immutable.** Every envelope is frozen at construction. The tracer captures payloads as lazy closures, so a shared object mutated after emit would let the trace record a state that never existed at emit time.
- **Append-only.** There is no update path for an event row.

A Download webhook is normalized the same way for Sonarr and Radarr: episodes, file, release, `downloadId`. The full raw body stays on the debug trace. `file.path` is relative. The series library root does not leak into the event.

## Activity is per target

The Activity list is one row per `(arr_instance, target_kind, target_id)`, not per job. Two series with the same name stay apart. Retries of one Sonarr id fold together. There are no day sections. Time is relative, absolute in a tooltip, cutting over to a date at 30 days.

Click a row: a drawer with that target's three pipeline phases as a timeline. Each run is one node. Runs are never folded against each other. Every label is derived from recorded data. The drawer is the only run-detail surface. `/jobs/:id` is gone.

Phase dots take the worst state across that phase's runs. A phase that failed twice and then succeeded is not clean.

`already-satisfied` is a settled success on the acquire phase, not a warning. A retried failure labels as an attempt, not "Run finished".

## Attention

Needs review is the escalation queue. Failed picks, failed drift gates, low-confidence bundle mappings, degraded sites, captcha failures, unresolved subtitle gaps. Actionable in place: retry, re-pick with a hint, force-grab, accept a bundle import, disable a site, dismiss.

Accept payloads live under `data.accept`, not on the envelope's own `action`. `POST /api/attention/:id/accept` dispatches on that field.

## Debug traces

Gated by `debug.enabled`. One toggle, no log-level selection. When on, payloads are stored raw, secrets included. A full-viewport warning frame is on every page while debug mode is on.

The trace unit is per job (`jobs.id`). Within a job, steps are sequential. Agent steps are keyed by the action the model chose (`agent.search`, `agent.download`, `agent.escalate`, …), so an executed action is told from a refusal by kind alone. `GET /api/traces/:jobId` carries the job's LLM cost: `calls` counts `llm.call` rows, and the token sums are over `llm.attempt` payloads.

The debug page is a superset of the Activity drawer: the target list on the left is the Activity list with each target's runs expanded; the Story tab is the drawer's run body. Above the trace, a lane strip draws the run by actor (trigger, arr, agent, llm, media, writes, verdicts) on a time axis that compresses idle gaps over two seconds. The waterfall below is the trace tree with an `at · took` column. Selecting a step opens the inspector; an `llm.call` shows its prompt, output, usage and the agent step its decision caused. The debug page never triggers or mutates anything.

Retention is 7 days, pruned by the daily scheduler, independent of `eventRetentionDays`. Flipping the switch on mid-job starts capturing from that point. Flipping it off stops capture but keeps existing traces until prune.
