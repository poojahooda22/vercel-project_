# Build plan — multi-tenancy, monorepo, Docker, CI/CD, deploy

Working order. Each phase ends at a checkpoint that must pass before the next starts.

---

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Frontend hosting | **self-hosted container** | same-origin auth for free; it's the skill being learned |
| Routing | **Caddy path-based** | `app.domain/api/*` → API keeps browser same-origin |
| Registry | **ghcr.io** | Docker Hub free = 1 private repo, we need 4 |
| Package manager | npm (verify `turbo prune` support first) | Bun rejected: Playwright's `chromium.launch()` hangs |
| Runtime | Node 22 | already runs `.ts` natively; no Bun advantage |
| Droplet | DO Basic, 2 vCPU, 4 GB, **BLR1** | measured idle ≈ 500 MB; builds spike 1–2 GB |

**URL map**

| URL | Serves |
|---|---|
| `poojahooda.com` | existing portfolio (Vercel) — untouched |
| `app.poojahooda.com` | dashboard |
| `app.poojahooda.com/api/*` | upload service |
| `{id}.poojahooda.com` | deployed sites (public, no auth) |

---

## Phase 1 — Multi-tenancy and auth

Deployed sites stay **public**. Only the dashboard and API become per-user.

### 1.1 Schema

**`vercel-upload-service/src/schema.ts`** *(edit)*
```sql
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS user_id text REFERENCES "user"("id");
CREATE INDEX IF NOT EXISTS deployments_user_recent ON deployments (user_id, created_at DESC);
```
`user.id` is `text` (confirmed in the Better Auth migration). Same Neon database — the
`NEON_DB` line hashes identically in both `.env` files.

The index is not optional: every dashboard read becomes
`WHERE user_id = $1 ORDER BY created_at DESC`.

### 1.2 Session verification

**`vercel-upload-service/src/session.ts`** *(new)*
- Read the Better Auth session cookie from `req.headers.cookie`.
  **Read the real cookie name off the running app first — do not guess it.**
- `SELECT "userId" FROM "session" WHERE token = $1 AND "expiresAt" > now()`
- Export `requireUser(req, res): Promise<string | null>` → userId, or null (caller sends 401)

No new dependency, no HTTP call to the frontend. One indexed lookup.

### 1.3 Ownership on every query

**`vercel-upload-service/src/db.ts`** *(edit)*

| Function | Change |
|---|---|
| `createDeployment` | takes `userId`, stores it |
| `listDeployments` | `WHERE user_id = $1` |
| `getDeployment` | `WHERE id = $1 AND user_id = $2` |
| `deleteDeployment` | `WHERE id = $1 AND user_id = $2` |

Ownership goes **in the WHERE clause**, never in an `if` before the query — zero rows
affected is the check, and it cannot race.

### 1.4 Routes

**`vercel-upload-service/src/index.ts`** *(edit)*
- `POST /deploy`, `GET /deployments`, `GET /status`, `DELETE /deployments/:id` → require a user
- `GET /screenshot/:id` → decide: public (simpler) or owner-only
- Replace `app.use(cors())` with an origin allowlist, or drop CORS entirely once
  same-origin via Caddy

### 1.5 Frontend

- **`vercel-frontend/middleware.ts`** *(new)* — redirect to `/login` without a session.
  Verified today: `GET /` returns 200 with no cookies and renders "Projects".
- **`vercel-frontend/lib/config.ts`** *(edit)* — API base becomes `/api` (same origin).
  `NEXT_PUBLIC_UPLOAD_SERVICE` disappears.
- **`vercel-frontend/lib/deployments.ts`** — same-origin fetch sends cookies by default,
  so no `credentials` flag needed **provided dev also runs behind Caddy**.

### Checkpoint 1
Two accounts. A's deployment invisible to B. B's `DELETE` of A's id returns 404, and A's
deployment still exists. Logged-out `GET /` redirects to `/login`.

### Deferred to 1c — before public signup only
`buildProject` has **no timeout, no output cap, no resource limit** (verified). With open
signup, `POST /deploy` runs strangers' `npm install` on the droplet. Needs: wall-clock
timeout, container memory/CPU caps, per-user rate limit, verified email before first deploy.
**Keep signup closed until this exists.**

---

## Phase 2 — Turborepo shell

Pure restructuring. **No source edits.**

```
package.json          workspaces: ["apps/*", "packages/*"]
turbo.json            build, typecheck, dev
tsconfig.base.json
.npmrc
```

Moves:
```
vercel-frontend/           → apps/frontend/
vercel-upload-service/     → apps/upload-service/
vercel-deploy-service/     → apps/deploy-service/
vercel-request-handler/    → apps/request-handler/
vercel-screenshot-service/ → apps/screenshot-service/
```

Each service's `tsconfig.json` extends the base. Intra-service imports (`./db`, `./aws`)
do not change.

### Checkpoint 2
`turbo run build` builds all five. All six processes start. A deploy runs end-to-end:
upload → build → serve → screenshot. **Nothing else changes until this passes.**

---

## Phase 3 — Shared package

**`packages/shared/`** — `package.json`, `tsconfig.json`, `src/`:

| File | Extracted from |
|---|---|
| `env.ts` | `required()` — duplicated in **8 files** |
| `s3.ts` | S3 client construction — **5 files** |
| `redis.ts` | `createClient()` — **3 services** |
| `types.ts` | `Deployment`, `DeploymentState` |

One helper at a time, verifying between each. Not all at once.

---

## Phase 4 — Docker (local)

```
.dockerignore
docker-compose.yml
apps/frontend/Dockerfile
apps/upload-service/Dockerfile
apps/deploy-service/Dockerfile
apps/request-handler/Dockerfile
apps/screenshot-service/Dockerfile
```

**`.dockerignore`** must contain `.env`, `.env.*`, `node_modules`, `.git`, `dist`, `.next`.
The reference repo's has only `node_modules` — that is how credentials end up inside a
pushed image.

**Per-image notes**

| Image | Base | Special |
|---|---|---|
| frontend | `node:22-slim` | needs `output: "standalone"` in `next.config.ts` (absent today) |
| upload-service | `node:22-slim` | `apt-get install git` — `simple-git` shells out |
| request-handler | `node:22-slim` | nothing extra; smallest |
| deploy-service | `node:22-slim` | keeps **npm at runtime** — it builds user repos |
| screenshot-service | `mcr.microsoft.com/playwright:v1.62.1-*` | tag must match installed Playwright; Alpine will not work (musl vs glibc) |

All multi-stage, non-root `USER`, `dumb-init`/`tini` as PID 1 so workers stop cleanly.

**`docker-compose.yml`** — 7 services: caddy, frontend, upload-service, request-handler,
deploy-service, screenshot-service, redis.
- **Redis gets a named volume** — it currently has none; `docker rm` loses every queued job
- **Redis healthcheck** + `depends_on: condition: service_healthy` — four deploys died
  silently because nothing noticed Redis was down
- Only Caddy publishes ports
- Dev runs Caddy too, so dev and prod share one origin model

### Checkpoint 4
`docker compose up` → full pipeline works through Caddy on `localhost`, including a
deployment served at `{id}.localhost`.

---

## Phase 5 — Production compose + Caddy

```
Caddyfile
docker-compose.prod.yml
.env.example
```

```caddy
app.poojahooda.com {
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy upload-service:3000
    }
    handle {
        reverse_proxy frontend:3002
    }
}

*.poojahooda.com {
    reverse_proxy request-handler:3001
    tls { dns cloudflare {env.CF_API_TOKEN} }
}
```

Wildcard certs **require DNS-01** — Let's Encrypt: HTTP-01 *"cannot be used to issue
wildcard certificates"*, DNS-01 *"allows you to issue wildcard certificates."* Hence the
Cloudflare token. **Caddy needs a build including the Cloudflare DNS module.**

`docker-compose.prod.yml`: no bind mounts, no dev command overrides, images pulled by tag,
`restart: unless-stopped`.

---

## Phase 6 — CI/CD

```
.github/workflows/ci.yml
.github/workflows/cd.yml
```

**ci.yml** — every push/PR: install, `turbo run typecheck build`.

**cd.yml** — push to `main`: matrix over the 5 services → build → push to ghcr.io → SSH →
`docker compose pull && docker compose up -d`.

Avoid the reference repo's deploy bug: it runs `docker stop X && docker run --name X`,
which fails on the second deploy because the container was never removed, and fails on the
first because there is nothing to stop. `docker compose up -d` handles both.

**GitHub secrets:** `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`. Registry auth uses the built-in
`GITHUB_TOKEN`. **Application secrets never enter CI or images** — they live in `.env` on
the droplet.

---

## Phase 7 — Deploy *(your account work)*

1. Cloudflare free account; add `poojahooda.com`; switch nameservers at Hostinger from
   `ns1/ns2.dns-parking.com`. Existing records come along — the portfolio keeps working.
2. Cloudflare API token scoped to DNS edit for that zone.
3. DigitalOcean droplet: Docker marketplace image, **BLR1**, SSH key, 2 GB swap.
4. DNS: `A app → droplet`, `A * → droplet`. Apex and `www` untouched.
5. Copy `docker-compose.prod.yml`, `Caddyfile`, `.env`; `docker compose up -d`.

---

## What I need from you

| When | What |
|---|---|
| Phase 1 | Confirm: is `GET /screenshot/:id` public, or owner-only? |
| Phase 2 | Confirm the repo folder may be restructured (git history preserved via `git mv`) |
| Phase 5 | Cloudflare API token — **paste into `.env` on the droplet yourself, never to me** |
| Phase 7 | DO account, droplet, nameserver switch |

Everything through Phase 6 runs on your laptop at zero cost.
