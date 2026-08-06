# Stage 1: build the service and the SPA, and resolve node_modules once. Both `npm ci`s
# run here (root + web/) since the dashboard is a separate npm project under web/, not a
# workspace of the root one.
#
# better-sqlite3 ships a prebuilt linuxmusl addon (node_modules/better-sqlite3/prebuilds),
# but npm's own "does this package need node-gyp?" heuristic doesn't reliably honor that
# package's `"gypfile": false` opt-out, so it can still shell out to node-gyp instead of
# using the prebuild. python3/make/g++ make that fallback succeed either way.
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
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
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV WARRDEN_DATA_DIR=/data

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/web/dist ./web/dist

# Owned by `node` (the image's built-in non-root user) before it's declared as a volume,
# so a fresh named volume inherits that ownership instead of root's.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data
EXPOSE 9797
# `curl`/`wget` aren't installed on this base image; Node's built-in `fetch` avoids
# pulling either in just for the healthcheck. Hardcodes the *default* `server.port`
# (9797, matching `EXPOSE` above) — a `config.json` that overrides the port needs a
# matching override here too, since a healthcheck can't read the container's own config.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:9797/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
