# The build worker. Pops an id, downloads the staged repo from R2, and runs
#   npm install && npm run build
# on code it did not write.
#
#   docker build -f apps/deploy-service/Dockerfile -t deploy-service .
#
# This image is different in kind from the others. It keeps a full Node toolchain
# at RUNTIME because building a user's project IS its job — there is no slimming
# this down to a compiled bundle. Treat it as the untrusted-code container:
# nothing else should share its credentials, and compose caps its memory and CPU.

FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.10.9 prune vercel-deploy-service --docker

FROM node:22-bookworm-slim AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN npm ci

FROM installer AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
COPY tsconfig.base.json ./tsconfig.base.json
RUN npx turbo run build --filter=vercel-deploy-service

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
# git is here for user repos whose install step fetches a git dependency, which
# npm resolves by shelling out to git. Without it those builds fail confusingly.
# ca-certificates for the same reason as the upload service: git over HTTPS fails
# with "CAfile: none" without it, while Node's own TLS keeps working and hides it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app app
WORKDIR /repo

COPY --from=builder --chown=app:app /repo/node_modules ./node_modules
COPY --from=builder --chown=app:app /repo/package.json ./package.json
COPY --from=builder --chown=app:app /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=app:app /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=app:app /repo/apps/deploy-service/package.json ./apps/deploy-service/package.json
COPY --from=builder --chown=app:app /repo/apps/deploy-service/dist ./apps/deploy-service/dist

# Non-root matters most here: this is the container that executes strangers' npm
# lifecycle scripts. It does not remove the risk — only isolation does — but it
# means an escaped build is not already root inside the container.
USER app
WORKDIR /repo/apps/deploy-service
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
