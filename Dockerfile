# Stage 1: build the service and the SPA, and resolve node_modules once. Both `npm ci`s
# run here (root + web/) since the dashboard is a separate npm project under web/, not a
# workspace of the root one.
#
# better-sqlite3 ships a prebuilt linux addon (node_modules/better-sqlite3/prebuilds),
# but npm's own "does this package need node-gyp?" heuristic doesn't reliably honor that
# package's `"gypfile": false` opt-out, so it can still shell out to node-gyp instead of
# using the prebuild. python3/make/g++ make that fallback succeed either way.
#
# The base is the glibc `node:22-bookworm-slim` (not the musl `-alpine` variant): the
# subtitle pipeline's Playwright chromium is glibc-only, and the built native modules
# must link the same libc they'll run against in the runtime stage.
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY . .
RUN npm run build:web
RUN npm run build
# Drop devDependencies from the already-resolved (and, for better-sqlite3, already-built)
# tree instead of re-running `npm ci` in the runtime stage — cheaper, and sidesteps the
# node-gyp quirk above a second time.
RUN npm prune --omit=dev

# Stage 2: runtime image. No compiler toolchain needed — node_modules is copied prebuilt
# from the builder stage.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV WARRDEN_DATA_DIR=/data
# Playwright's browsers are installed to a fixed, node-readable root (below) rather than
# the per-user cache dir, so the `node` runtime user can find them at launch.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Split from the build outputs below on purpose. A COPY's cache key is the content it
# copies, so these two only change when the dependency tree does, which keeps the expensive
# tool install underneath them cached across ordinary source edits. Putting the build
# outputs here too would invalidate that layer on every commit.
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Media tools for the subtitle pipeline, which shells out to these at runtime
# (src/media/tools.ts): ffmpeg/ffprobe (probing + embedded-track extraction) and the
# alass/ffsubsync drift-resync tools, plus Playwright's headless chromium for the
# fan-site browser tier (src/agent/). They're installed here (the runtime stage, before
# dropping to `node`) because the pipeline execs them; the compiler and build-only
# packages required to BUILD ffsubsync and alass are discarded right after, so the final
# image carries no toolchain.
#   - ffmpeg/ffprobe: Debian package (`ffmpeg`).
#   - ffsubsync: Python package; pip compiles the webrtcvad wheel from source, so
#     python3-dev/build-essential come in as a discardable build stage companion.
#   - alass: no arch-agnostic prebuilt (upstream ships linux-x64 + windows only), so it's
#     built from the `alass-cli` crate via a minimal rustup toolchain; the compiled
#     `alass-cli` binary is copied to the `alass` name the runtime execs.
#   - chromium: playwright's `--with-deps` installer pulls the glibc build the runtime
#     needs along with its system libraries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      p7zip-full \
      python3 python3-pip python3-dev build-essential curl ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir ffsubsync \
    && curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal \
    && export PATH="$HOME/.cargo/bin:$PATH" \
    && cargo install --locked alass-cli \
    && cp "$HOME/.cargo/bin/alass-cli" /usr/local/bin/alass \
    && mkdir -p /ms-playwright \
    && npx playwright install --with-deps chromium \
    && rm -rf "$HOME/.rustup" "$HOME/.cargo" /tmp/rustup.sh \
    && apt-get remove -y -qq python3-dev build-essential g++ gcc make >/dev/null 2>&1 \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R node:node /ms-playwright

# Owned by `node` (the image's built-in non-root user) before it's declared as a volume,
# so a fresh named volume inherits that ownership instead of root's.
# Do NOT pre-create media mount dirs here — empty dirs would always "exist" and the
# Storage health panel would lie. Docker creates the mount point when you bind-mount:
#   -v host/Series:/tv  -v host/Anime:/anime  -v host/Movies:/movies  -v host/Downloads:/downloads
RUN mkdir -p /data && chown node:node /data

# Last, so a source-only rebuild redoes just these three layers. `npx playwright` above
# needs node_modules already present to resolve the pinned version rather than fetching a
# fresh one from the registry, which is why the dependency copies stay above it.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/web/dist ./web/dist
COPY --from=builder --chown=node:node /app/seeds ./seeds

USER node

VOLUME /data
EXPOSE 9797
# `curl` is already present (installed above for the rustup bootstrap), but Node's
# built-in `fetch` avoids relying on an extra binary for the healthcheck. Hardcodes
# the *default* `server.port`
# (9797, matching `EXPOSE` above) — a `config.json` that overrides the port needs a
# matching override here too, since a healthcheck can't read the container's own config.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:9797/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
