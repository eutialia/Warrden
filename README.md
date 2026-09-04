# Warrden

A housekeeping agent for Sonarr and Radarr. It picks a release, rescues files the arr import leaves behind, and fetches subtitles. Downloading and importing stay with the arrs.

**Alpha.** Do not point this at a library you care about. It is not a product yet.

## Run it

There is no published image. Build from a checkout.

```sh
cp compose.override.example.yaml compose.override.yaml
# point the host paths at your media
npm run docker
```

The dashboard is at `http://localhost:9797`. Set **publicUrl** in Settings before you add an arr.

To hack on the code:

```sh
npm run dev:all   # API on :9797, UI on :5173
```

Set the four storage paths under Settings, Storage. The Docker defaults (`/tv` and the rest) do not exist on the host.

## Docs

[Architecture](docs/architecture.md) and [pipeline overview](docs/pipeline-overview.md). The rest of `docs/` covers acquire, ingest, subtitle, the site agent, storage, and the dashboard.

## License

[GPL-3.0](LICENSE).
