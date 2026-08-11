# Serves every deployed site: maps the request's hostname to a deployment id and
# streams that object out of R2. The smallest of the five — no git, no npm at
# runtime, no browser.
#
# Build from the REPO ROOT, not this directory:
#   docker build -f apps/request-handler/Dockerfile -t request-handler .
# The build context has to be the whole monorepo because the prune stage below
# needs the root lockfile and the workspaces it references.

# ---------- 1. prune ----------------------------------------------------------
# `turbo prune` emits a monorepo containing only this app and the workspaces it
# actually depends on, plus a lockfile cut down to match (403KB -> 71KB here).
# Without it, a change in any unrelated service would invalidate this image's
# install layer, because the root lockfile is shared by all of them.
FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.10.9 prune vercel-request-handler --docker

# ---------- 2. install --------------------------------------------------------
# Only the package.json files land here first. Docker caches this layer on their
# contents alone, so editing source does not re-run npm ci.
FROM node:22-bookworm-slim AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN npm ci

# ---------- 3. build ----------------------------------------------------------
FROM installer AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
# turbo prune copies only what package manifests reference, so a tsconfig that
# `extends` a root file is left behind and tsc fails with TS5083. Nothing in the
# pruned output hints at this — it has to be copied explicitly.
COPY tsconfig.base.json ./tsconfig.base.json
RUN npx turbo run build --filter=vercel-request-handler

# ---------- 4. runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
# dumb-init is PID 1 so SIGTERM reaches node. Without it node runs as PID 1, does
# not get default signal handlers, and `docker stop` waits the full 10s then kills
# it — turning every deploy into a hard kill mid-request.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Never root: this process is reachable from the internet.
RUN groupadd -r app && useradd -r -g app app
WORKDIR /repo

COPY --from=builder --chown=app:app /repo/node_modules ./node_modules
COPY --from=builder --chown=app:app /repo/package.json ./package.json
COPY --from=builder --chown=app:app /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=app:app /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=app:app /repo/apps/request-handler/package.json ./apps/request-handler/package.json
COPY --from=builder --chown=app:app /repo/apps/request-handler/dist ./apps/request-handler/dist

USER app
WORKDIR /repo/apps/request-handler
EXPOSE 3001
# Env comes from compose, not from a .env file baked into the image.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
