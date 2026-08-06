# Warrden

Warrden is a housekeeping agent that sits behind Sonarr and Radarr and closes the gaps a
human normally fills by hand. It watches for new series and movies, picks the correct
release out of a messy candidate list using an LLM policy, grabs it through the arr's own
API, and (for Sonarr) teaches the arr to keep picking correctly on its own from then on.
Everything else — downloading, importing, and file management — stays with Sonarr/Radarr
and the torrent client; Warrden only makes the one decision they can't.

This is Phase 1 of the project: release acquisition only. Ingest (subtitle and sidecar
file rescue) and the subtitle pipeline are planned for later phases — see the design spec
linked below.

## Quickstart

Warrden is a single container. It needs a data directory for its SQLite database and
config, and network access to your Sonarr/Radarr instances.

```sh
docker run -d \
  --name warrden \
  -p 9797:9797 \
  -v /path/to/warrden-data:/data \
  ghcr.io/your-org/warrden:latest
```

On first start, Warrden writes a default `config.json` into the data volume and serves a
dashboard at `http://<host>:9797`. Use the **Config** page to add your arr instances
(name, kind, base URL, API key), set picking preferences, and choose an LLM provider —
then restart the container to pick up the LLM provider change. Everything else applies
live.

Warrden registers its own webhook with each configured arr instance on startup; no manual
webhook setup is required in Sonarr/Radarr.

**Tested against:** Sonarr v4 and Radarr v5. The release-profile API shape Warrden relies
on for pinning assumes Sonarr v4 or newer.

## Configuration reference

All configuration lives in `config.json` inside the data directory and is editable from
the dashboard's Config page. Fields not set fall back to the defaults below.

| Field | Default | Description |
| --- | --- | --- |
| `server.port` | `9797` | Port the HTTP server (API + dashboard) listens on. |
| `server.publicUrl` | `http://localhost:9797` | URL Warrden advertises to the arrs when self-registering its webhook; must be reachable from them. |
| `arrs[].name` | — | Unique label for the instance; also the key used internally, so renaming one requires re-entering its API key. |
| `arrs[].kind` | — | `sonarr` or `radarr`. |
| `arrs[].baseUrl` | — | Base URL of the arr instance. |
| `arrs[].apiKey` | — | API key for the arr instance. |
| `pathMappings[].from` / `.to` | `[]` | Path translations between Warrden's filesystem view and the arr's, for phases that touch files directly (not used by Acquire). |
| `picking.tags` | `[]` | Freeform tags describing release preferences, folded into the LLM's picking policy. |
| `picking.seederFloor` | `3` | Minimum seeders a candidate must have to be considered. |
| `picking.minSizeMB` | `50` | Minimum release size, in MB, to filter out sample/junk releases. |
| `picking.maxSizeMB` | `60000` | Maximum release size, in MB, to filter out oversized releases. |
| `llm.activeProfile` | `prod` | Which of `llm.profiles` (`dev` or `prod`) is currently in effect. |
| `llm.profiles` | `{ dev: {}, prod: {} }` | Per-profile, per-call-site model configuration (provider, model, optional fallback). Phase 1 has one call-site: `release-pick`. |
| `llm.keys.openrouter` / `.openai` / `.anthropic` | unset | API keys for the corresponding LLM provider. Not required for the `claude-code` provider, which uses subscription auth instead. |
| `reconcileIntervalMinutes` | `15` | How often the reconciliation loop polls each arr's history/queue as a backstop for missed webhooks. |

Secrets (`arrs[].apiKey`, `llm.keys.*`) are shown as `•••` on the Config page once set;
leave them as-is to keep the stored value, or clear and retype to change them.

## More detail

See [`docs/specs/2026-08-05-warrden-design.md`](docs/specs/2026-08-05-warrden-design.md)
for the full design: architecture, pipelines, error handling, and phasing.
