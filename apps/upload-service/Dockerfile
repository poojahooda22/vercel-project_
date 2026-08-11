# The ingest API. Clones a user's repo and stages it in R2, then enqueues a build.
#
#   docker build -f apps/upload-service/Dockerfile -t upload-service .
# Context must be the repo root — the prune stage needs the root lockfile.
#
# Special requirement: the `git` BINARY at runtime. simple-git shells out to it,
# so a slim node image without it fails at the first clone, not at build time.

FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.10.9 prune vercel-upload-service --docker

FROM node:22-bookworm-slim AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN npm ci

FROM installer AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
# Not emitted by prune; a tsconfig that extends it fails with TS5083 without this.
COPY tsconfig.base.json ./tsconfig.base.json
RUN npx turbo run build --filter=vercel-upload-service

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
# git: required at RUNTIME by simple-git, not just to build.
# ca-certificates: without it git cannot verify GitHub's TLS and every clone dies
#   with "server certificate verification failed. CAfile: none". Node is unaffected
#   because it bundles its own CA store, so R2 and Neon work and only git breaks —
#   which makes this look like a git bug rather than a missing package.
# dumb-init: PID 1, so `docker stop` is a clean SIGTERM rather than a 10s kill.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app app
WORKDIR /repo

COPY --from=builder --chown=app:app /repo/node_modules ./node_modules
COPY --from=builder --chown=app:app /repo/package.json ./package.json
COPY --from=builder --chown=app:app /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=app:app /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=app:app /repo/apps/upload-service/package.json ./apps/upload-service/package.json
COPY --from=builder --chown=app:app /repo/apps/upload-service/dist ./apps/upload-service/dist

# Clones land in dist/output/<id> relative to the compiled code, so this must be
# writable by the app user — the COPY above already assigns ownership.
USER app
WORKDIR /repo/apps/upload-service
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
