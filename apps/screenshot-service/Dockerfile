# Captures a screenshot of each deployed site once it is reachable.
#
#   docker build -f apps/screenshot-service/Dockerfile -t screenshot-service .
#
# The heaviest image, and the only one that cannot use node:22-slim: it needs a
# real Chromium plus its system libraries and fonts. The official Playwright image
# ships all three, already matched to the library version.
#
# The tag MUST equal the installed playwright version (1.62.1, verified against
# node_modules). Playwright refuses to drive a browser build it was not shipped
# with, so a drifting tag fails at runtime with "Executable doesn't exist".
#
# Alpine is not an option here: Playwright's browser builds are glibc, Alpine is
# musl, and Chromium simply will not start.

FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.10.9 prune vercel-screenshot-service --docker

FROM node:22-bookworm-slim AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
# The browsers come from the runtime base image, so skip Playwright's postinstall
# download here — it would add ~150MB to a layer that then gets discarded.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

FROM installer AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
COPY tsconfig.base.json ./tsconfig.base.json
RUN npx turbo run build --filter=vercel-screenshot-service

# ---------- runtime -----------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runner
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /repo
# pwuser ships with the Playwright image and is what Microsoft intends browsers to
# run as. Reusing it avoids creating a second non-root user whose id does not own
# the browser cache.
COPY --from=builder --chown=pwuser:pwuser /repo/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /repo/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=pwuser:pwuser /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=pwuser:pwuser /repo/apps/screenshot-service/package.json ./apps/screenshot-service/package.json
COPY --from=builder --chown=pwuser:pwuser /repo/apps/screenshot-service/dist ./apps/screenshot-service/dist

# Deliberately NOT --no-sandbox. The serverless Chromium builds disable the
# sandbox because Lambda is a throwaway root microVM; this is a long-lived worker
# next to live R2 and Neon credentials, rendering arbitrary user-deployed pages.
USER pwuser
WORKDIR /repo/apps/screenshot-service
# dumb-init is already PID 1 in this base image's entrypoint conventions, but the
# worker also traps SIGTERM itself to close the browser — a Chromium left running
# after the node process dies is a leaked process per restart.
CMD ["node", "dist/index.js"]
