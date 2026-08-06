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

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

VOLUME /data
EXPOSE 9797
CMD ["node", "dist/index.js"]
