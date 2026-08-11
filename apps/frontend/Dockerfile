# The dashboard. Self-hosted rather than on Vercel, so the whole platform runs on
# infrastructure we control — and so the dashboard and API share one origin behind
# Caddy, which is what makes the session cookie work without any cross-site setup.
#
#   docker build -f apps/frontend/Dockerfile -t frontend .
#
# Depends on `output: "standalone"` in next.config.ts. Without it there is no
# .next/standalone directory and the final COPY below fails.

FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.10.9 prune vercel-frontend --docker

FROM node:22-bookworm-slim AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN npm ci

FROM installer AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
COPY tsconfig.base.json ./tsconfig.base.json
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, not read
# at runtime — so they are build args, and changing one means rebuilding the image.
ARG NEXT_PUBLIC_UPLOAD_SERVICE
ARG NEXT_PUBLIC_REQUEST_HANDLER_HOST
ENV NEXT_PUBLIC_UPLOAD_SERVICE=$NEXT_PUBLIC_UPLOAD_SERVICE
ENV NEXT_PUBLIC_REQUEST_HANDLER_HOST=$NEXT_PUBLIC_REQUEST_HANDLER_HOST
RUN npx turbo run build --filter=vercel-frontend

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -r app && useradd -r -g app app
WORKDIR /repo

# standalone already contains the pruned node_modules it needs, so node_modules is
# deliberately NOT copied here — that is the whole point of the mode.
COPY --from=builder --chown=app:app /repo/apps/frontend/.next/standalone ./
COPY --from=builder --chown=app:app /repo/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=app:app /repo/apps/frontend/public ./apps/frontend/public

USER app
EXPOSE 3002
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
# standalone emits server.js at the workspace-relative path, not the repo root.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/frontend/server.js"]
