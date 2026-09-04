# Site agent

The subtitle search agent is Warrden's own tool loop, not a framework. Hard step budget (`browser.stepBudget`), restricted verbs, retry and escalation in code. Only navigation and ranking choices belong to the model. Code lives in `src/agent/`.

There is no site-specific code. The loop's verbs (GET, POST, cookies, downloads) are site-agnostic. Everything site-shaped is data: a knowledge file, a seed, and typed crumbs in `site_profiles`.

## Access ladder

`curl`, then headless Chromium. `camoufox` and `remote` are declared seams, not required for v1. A run starts at the site profile's remembered tier and escalates on bot-wall signals. After seven days of success, the next run tries one cheaper tier (tier decay).

Politeness: concurrency 1 per site. Per-site cooldowns and a run-scoped cookie jar under the data directory matter more than prompt cache for a multi-title night.

Every destination is checked by `destinationGuard.ts` before connect: no loopback, no RFC1918, no link-local, no DNS rebinding between check and connect. Redirects are re-checked.

## What the agent learns into the database

On success, `src/agent/run.ts` writes typed crumbs into `site_profiles`:

- `last_working_tier`
- `search_url_patterns` (capped), when they differ from the configured template
- success and failure timestamps, fail count (drives cooldown)

These stay in SQLite because they are typed, bounded, and queryable. They do not move into prose.

## Knowledge file

Each site gets one markdown file at `dataDir/sites/<siteKey>.md`, keyed by `siteKey()` (`src/config/siteLabel.ts`). `https://subhd.tv` becomes `subhd.tv.md`. The file lives on the data volume, so it survives restarts and you can edit it with any text editor.

The operator adds a site URL in Settings. Nothing else is required. The agent learns how that site behaves from its own runs.

Sections are stable so delta operations have somewhere to land: Access, Search, Download, Pitfalls, Operator notes. Agent-owned bullets are conditional IF/THEN rules, one per line, each ending in a `(confirmed YYYY-MM-DD)` stamp. A conditional is falsifiable on the next run. "The search is flaky" is not.

`## Operator notes` is yours and the agent's only read-only ground. Delta operations may never target it. It is copied through byte-exact on every write, and it is exempt from the injection scan because it is trusted input. Empty, it is omitted from the prompt. When it has content it is injected above the learned sections and labelled authoritative: where you and the agent's notes disagree, you win.

Ceilings: 10,000 characters across the agent-owned sections, enforced on write. A write that would overflow is dropped and the old file stands.

## Seeds

`seeds/sites/subhd.tv.md` ships in the image. The first run against a site with no file copies the matching seed in. With no seed, the agent starts from the empty skeleton. Seeds are a head start, not a contract. The file is agent-owned from the moment it is created. subhd.tv keeps a seed because its JSON download endpoint is not discoverable from the HTML.

## Read once, write once

At the start of a site's run the file is loaded, scanned, and injected into the system prompt. The loop must load knowledge before its first `search` step.

One reflection call per site run (`site-notes`), after the pipeline knows what the download actually produced. It receives the current file, the run transcript, and the outcome, and returns typed delta operations plus a verdict. Protocol lessons write only on a verified success. Agents that wrote lessons regardless of outcome scored worse than agents with no memory at all.

The file is treated as a set of distinct facts, each owning exactly one bullet. If this run's observation concerns a fact the file already covers, the op is `update` of that bullet, not a second bullet.

## Threat scanner

Web-agent memory is an injection target. `threatPatterns.ts` is a tripwire on every load and every write: exfil, delimiter spoofing, instructions to hide secrets from you. A poisoned bullet is dropped. The scanner is not a full defender. It is the tripwire the rest of the design assumes.

A provider error (`LlmError`) during search fails the job. It does not blame the site, bump `fail_count`, or run reflection. A dead route or filesystem error still counts as a site fault.

Captcha: one automated attempt in-loop (SVG in the response, read, re-POST). On failure, continue or raise Attention. No infinite retries.

The dashboard Sites page is the editor for the knowledge file and the place you disable a site that the agent marked unusable.
