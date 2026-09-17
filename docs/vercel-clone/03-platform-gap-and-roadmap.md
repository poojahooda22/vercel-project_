# Gap Map and Roadmap — From "Deploys a Static Site" to a Forge-Class Platform

> **Status.** Assessment of the platform as it exists on disk at commit `e9e7622` (2026-08-12), written
> 2026-09-10. Every "we have" claim below cites a file and line read this session; every "Vercel does"
> claim cites a vercel.com/docs page fetched this session or one already cited in
> [00-architecture-research.md](00-architecture-research.md). Anything else is tagged `(general
> knowledge)` or `[unverified]`.
>
> **Prerequisites.** [00-architecture-research.md](00-architecture-research.md) (how Vercel works),
> [01-cluster-hosting-research.md](01-cluster-hosting-research.md) (the cluster and build-isolation
> findings), [02-build-plan.md](02-build-plan.md) (Phases 1–7, all shipped). This document does not
> repeat them; it points into them.

---

## 0. Plain-language summary (read this first)

**The diagnosis is correct.** What is running today is a working *deployment pipeline*, not a
*platform*. A person pastes a public GitHub URL, the system clones it, builds it, and serves it at
`{id}.poojahooda.com`. That end-to-end path is real and proven in production. But every property that
turns a pipeline into a platform is missing:

- **Nothing happens when the developer pushes new code.** The platform itself redeploys on every push
  to its own repo (GitHub Actions), but the sites it hosts do not. A tenant has to come back and paste
  the URL again, which mints a brand-new site at a brand-new address.
- **There is no such thing as a "project".** The database knows only *deployments*. There is no record
  that says "this repo, this branch, this owner, this is the one that is live". Without that record a
  webhook has nothing to look up, rollback has nothing to point at, and a custom domain has nothing to
  attach to. This is the missing keystone; most other gaps hang off it.
- **Logs exist only as text scrolling in a container.** When a build fails, the dashboard shows "build
  exited with code 1" and nothing else. Nobody can see the compiler error that caused it.
- **There are no metrics at all.** No request counts per site, no build-duration history, no queue
  depth, no error rate, no alert when something is wrong.
- **"No load balancer" is half right.** The proxy in front (Caddy) *can* balance and health-check, but
  it is pointed at exactly one copy of each service on one machine. There is nothing to balance across,
  no health endpoint to check, and no cache in front of the storage bucket, so every page view is a
  round-trip to Cloudflare R2. At thousands of sites the ceiling is that one box and that one
  round-trip.
- **Builds run strangers' code on the same machine that holds the platform's keys.** This is the one
  gap that is not a feature but a wall: until builds are isolated, the platform can only host repos we
  trust.

**What "the goal" looks like, concretely.** Connect a repo once → every push builds automatically → a
preview address per branch → one click promotes to production and one click rolls back → live build
logs and per-site traffic → custom domains → the whole thing survives a crash, a restart, and a
traffic spike. That is what Vercel sells, and it is what an internal platform of the Forge class
provides to its teams. Fox's Forge itself is not publicly documented (a web search returns only Fox
platform-engineering job postings), so this document measures against Vercel, whose behaviour is
documented, and against three open-source platforms already read at source level (Coolify, CapRover,
Dokploy).

**How far away that is.** Seven phases, each independently shippable, each stated with the tier it
reaches and what breaks at the next. The order matters: hygiene first (a platform that loses builds on
restart cannot be trusted with webhooks), then projects and push-to-deploy, then logs, then metrics,
then scale, then isolation, then custom domains. Isolation is late in the build order but first in the
"before public signup" order.

---

## 1. What / Problem / How

**What are we building?** A self-hosted deployment platform where a developer connects a Git repo and
gets, without further action: a build on every push, an immutable preview URL per commit, a production
pointer with promote and rollback, live build logs, per-site traffic and error metrics, custom domains,
and serving that scales past one machine. In one sentence: the four properties Vercel sells
(zero-ops DX, builds run for you, immutable deploys with instant rollback, traffic you never think
about), listed with citations in the `arch-vercel-system-design` skill.

**What problem does it solve?** For an individual: "I pushed, why isn't it live?" and "the build broke,
where is the error?" For an organisation running an internal platform: every team gets the same paved
road, so nobody hand-builds a CI pipeline, a proxy config, a certificate, and a rollback procedure per
project. That is the entire value proposition of a Forge-class platform, and the reason such teams
exist.

**How?** Add the missing keystone (a `projects` record with a production pointer), put a webhook
receiver in front of the existing enqueue path, turn the worker's `console.log` into a per-deployment
log stream, add a `/metrics` endpoint per service and a collector, replicate the request handler behind
the proxy we already run with a cache tier derived from deployment immutability, and move builds into
an isolated runtime. Each step is a bounded change to code that already exists; the mechanisms are the
ones the research docs already selected.

---

## 2. Where we stand, verified on disk

Everything below was read this session at commit `e9e7622`. The **Tier** column uses the project's
scale (A = course clone, B = small real product, C = real Vercel) from
[00-architecture-research.md §8](00-architecture-research.md).

| Capability | What exists | Where | Tier |
|---|---|---|---|
| Ingest | Session-authenticated `POST /deploy` taking a raw `repoUrl`; anonymous full clone; every file except `.git` uploaded to R2; enqueue after upload | [upload-service/src/index.ts:60](../../apps/upload-service/src/index.ts#L60), [:86](../../apps/upload-service/src/index.ts#L86), [:112](../../apps/upload-service/src/index.ts#L112); `.git` skipped at [file.ts:9](../../apps/upload-service/src/file.ts#L9) | B (auth, ownership, env validation) |
| Deployment record | Postgres `deployments` row per upload; four-state machine `queued → building → deployed \| failed`, every transition a guarded `UPDATE` | [schema.ts:7-10](../../apps/upload-service/src/schema.ts#L7), [deploy-service/src/db.ts](../../apps/deploy-service/src/db.ts) | B |
| Project record | **None.** No table links a repo + branch + owner to a live deployment | [schema.ts](../../apps/upload-service/src/schema.ts) — only `deployments` | absent |
| Trigger on git push | **None.** The only "webhook" in the repo is a word in the research doc. The platform *itself* redeploys on push; tenant sites do not | [cd.yml:11](../../.github/workflows/cd.yml#L11) | absent |
| Build | `exec("cd … && npm install && npm run build")` on the worker host; exit code honoured; env allowlist; publish-dir detection; 2 GB / 1.5 CPU compose limit | [utils.ts:64](../../apps/deploy-service/src/utils.ts#L64), [:17](../../apps/deploy-service/src/utils.ts#L17), [docker-compose.prod.yml:109](../../docker-compose.prod.yml#L109) | A+ (limits, no isolation) |
| Build logs | `child.stdout`/`stderr` piped to `console.log` → container stdout. Not persisted, not per-deployment, not visible in the dashboard. Failure surfaces as `error_message = "build exited with code N"` | [utils.ts:69-72](../../apps/deploy-service/src/utils.ts#L69) | A |
| Runtime / access logs | Request handler logs only 502s; no per-request, per-site access log | [request-handler/src/index.ts](../../apps/request-handler/src/index.ts) | A |
| Metrics | **None.** No `/metrics`, no counters, no collector. Build duration is derivable from `building_at`/`finished_at` and shown per row, nothing more | [deployment-detail.tsx](../../apps/frontend/app/deployment-detail.tsx) `buildDuration` | absent |
| Queue | Redis list, `brPop` (destructive pop: a worker crash after pop loses the job). Deploy worker has **no** SIGTERM handler; the screenshot worker does. The "reaper" the schema index is built for **does not exist as code** | [deploy-service/src/index.ts:21](../../apps/deploy-service/src/index.ts#L21), [screenshot-service/src/index.ts:50](../../apps/screenshot-service/src/index.ts#L50), [schema.ts:73](../../apps/upload-service/src/schema.ts#L73) | A |
| Serving | One Express process, wildcard route, tenant id from the first Host label, one R2 `getObject` per request, SPA fallback, correct MIME map | [request-handler/src/index.ts:45-62](../../apps/request-handler/src/index.ts#L45) | A (correctness B, scale A) |
| Proxy / TLS | Caddy: wildcard cert via DNS-01, `*.{$DOMAIN}` → **one** request-handler container, `app.` → frontend + upload API | [Caddyfile.prod:67](../../Caddyfile.prod#L67), [:44](../../Caddyfile.prod#L44) | B for TLS, A for capacity |
| Health endpoints | **None** on either HTTP service | — | absent |
| Admission control | **None.** No rate limit, no queue-depth bound on `POST /deploy` | [upload-service/src/index.ts:60](../../apps/upload-service/src/index.ts#L60) | absent |
| Rollback / promote | Button rendered **disabled**: "Rollback needs deployment history per project — not built yet" | [deployment-detail.tsx:63-67](../../apps/frontend/app/deployment-detail.tsx#L63) | absent |
| Preview per branch | None; there is no branch concept | — | absent |
| Custom domains | None; only `{id}.poojahooda.com` | — | absent |
| Private repos | None; anonymous clone only (fails with a misleading error, per the deploy-state memory) | [upload-service/src/index.ts:86](../../apps/upload-service/src/index.ts#L86) | absent |
| Dashboard | Polls every 2–3 s; list, detail, delete, upload with env vars, screenshot | [upload-modal.tsx:91](../../apps/frontend/app/upload-modal.tsx#L91), [page.tsx:62](../../apps/frontend/app/page.tsx#L62) | B |
| Hosting | One EC2 box, `docker compose`, images built in CI and pulled; one Redis with AOF; Neon Postgres; R2 | [docker-compose.prod.yml](../../docker-compose.prod.yml) | B (single node) |

**One fact worth stating plainly:** the platform's own CI/CD is exactly the mechanism the tenants
lack. `cd.yml` reacts to a push, builds, and swaps the running version. The tenant-facing equivalent
is a webhook receiver in front of the enqueue path that already exists at
[index.ts:112](../../apps/upload-service/src/index.ts#L112). That is why Phase 9 below is smaller than
it looks.

---

## 3. The gap map

Each gap: what the Forge/Vercel class has (cited), what we have, what is missing, how to close it,
and where it breaks at the next tier. The four the operator named come first; the rest are gaps the
research had already identified and that the named four depend on.

### G1 — Push-to-deploy (the operator's gap #2)

**The class.** "Vercel for GitHub will deploy every push by default" (vercel.com/docs/git/vercel-for-github,
via the ingestion reference). The mechanism is a GitHub App or repository webhook. GitHub's receiver
contract, fetched this session: the payload is signed with HMAC-SHA256 in `X-Hub-Signature-256`
("GitHub uses an HMAC hex digest to compute the hash"); compare with a constant-time function ("Never
use a plain `==` operator … `crypto.timingSafeEqual`"); the header is absent if no secret is configured
(docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries). Delivery must be acknowledged
within 10 seconds or it "will record the delivery as a failure", and **"GitHub does not automatically
redeliver failed deliveries"** — redelivery is the receiver's job via UI or REST
(docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries). That last sentence
settles a flag the ingestion reference left `[unverified]`.

**Open-source precedent, read at source this session.** Coolify's receiver
(`coollabsio/coolify@v4.x:app/Http/Controllers/Webhook/Github.php`): strips the `sha256=` prefix from
`X-Hub-Signature-256` (~line 31), computes `hash_hmac('sha256', body, secret)` and compares with
`hash_equals` (~lines 80–84), resolves the application by repository + `git_branch` (~lines 52–68),
calls `queue_application_deployment(application, deployment_uuid, commit: payload.after, is_webhook:
true)` (~lines 127–134), and **returns 429 when the queue is full**. Pull-request events dispatch a
separate job for previews (~lines 165–180). That is the whole Tier B receiver in one file.

**We have.** Nothing. `POST /deploy` is a human action.

**Missing.** (a) A `projects` table — see G2, it is a hard prerequisite; (b) the receiver;
(c) a deploy-hook URL for systems that cannot sign (CMS, cron); (d) the newest-per-branch collapse
("if Vercel is already building a previous commit on the same branch … the most recent commit will
begin deployment and the other queued builds will be cancelled", vercel-for-github, via the ingestion
reference §1.4); (e) commit metadata on the deployment row (`git_ref`, `git_sha`, `trigger`).

**How.** `POST /webhooks/github` on the upload service: read the raw body (before `express.json`
parses it, the HMAC is over bytes), verify with `crypto.timingSafeEqual`, dedup on `X-GitHub-Delivery`
via `SET NX` with a 24 h TTL, ignore `deleted: true` and non-`push` events, look up the project by
`repository.full_name` + branch from `ref`, insert the deployment row with `git_sha = after`, enqueue,
return 202 — all before any clone. Move the clone off the request path into the worker (the ingestion
reference's accept-then-work-async shape; today the clone happens inside the request at
[index.ts:86](../../apps/upload-service/src/index.ts#L86), which already violates the 10 s budget for
any non-trivial repo). Add `POST /hooks/{token}` that re-enqueues a project's configured branch, rate
limited (Vercel's documented budget is 60/hour/project, deploy-hooks doc via the ingestion reference
§4). Newest-per-branch: on enqueue, mark older `queued` rows for the same project+branch as `canceled`
(a fifth state) so the worker's claim skips them.

**Tier.** B. **Breaks at C:** multi-provider Git Apps, PR comments and checks, fork-author gating for
secrets ("Vercel will require authorization … to deploy the pull request" from a fork, vercel-for-github
§ Deployment Authorizations for Forks) — the moment builds carry env vars and strangers can open PRs,
that gate is mandatory. We already inject `build_env`, so this lands the day the platform is public.

### G2 — Projects, production pointer, promote, rollback, branch previews

**The class.** "Each time you deploy, Vercel generates a unique URL"; rollback "points production
traffic to the deployment you specify without rebuilding … at the routing layer, so it takes effect
within seconds" (deployments and rollback docs, via `arch-vercel-system-design` ledger rows D1, D2).
Heroku's append-only release ledger and Netlify's atomic tree swap are the same mechanism, so it is
category-invariant, not a Vercel quirk ([00-architecture-research.md §7](00-architecture-research.md)).

**We have.** Immutable deployments (D1 is real: a fresh id per upload, `dist/{id}/` never rewritten),
which is the hard half. **Missing:** the pointer. There is no project, so there is no "production" to
point.

**How.** A `projects` table: `id, user_id, name, slug, repo_url, provider, repo_full_name,
production_branch, production_deployment_id (FK, nullable), webhook_secret, hook_token, created_at`.
Deployments gain `project_id, git_ref, git_sha, trigger ('manual'|'webhook'|'hook'|'rollback')`. Three
hostname shapes in the request handler: `{slug}.domain` resolves the production pointer,
`{slug}-git-{branch}.domain` resolves the newest deployed row for that branch, `{id}.domain` stays as
the immutable commit URL. Promote and rollback are one guarded `UPDATE projects SET
production_deployment_id = $new WHERE id = $p AND production_deployment_id = $expected`, the CAS shape
the `arch-deployment-model` skill specifies. The handler caches the pointer in Redis with a short TTL
and the UPDATE invalidates it; the `clone-alias-layer.md` reference in `arch-vercel-system-design`
holds the read-path and stale-alias analysis.

**Tier.** B. **Breaks at C:** alias fan-out to a global edge (the pointer must replicate to every PoP),
retention and GC of thousands of retained deployments per project (ledger row D5, documented only).

### G3 — Build logs and runtime logs (the operator's gap #3)

**The class.** Build logs "show the deployment progress … the version of the build tools, warnings or
errors … are stored indefinitely for each deployment", truncated at 4 MB, with secrets ≥ 32 chars
replaced by `[REDACTED]`, and exportable via Log Drains (vercel.com/docs/deployments/logs, fetched
2026-09-10). Runtime logs are per-request, "shown in realtime and grouped as per request", capped at
256 lines / 1 MB per request, and retained **1 hour on Hobby, 1 day on Pro, 3 days on Enterprise, 30
days with Observability Plus** (vercel.com/docs/logs/runtime, fetched 2026-09-10). Two products, two
retention policies: build logs are cheap and permanent, request logs are expensive and short-lived.

**We have.** Build output in the worker's stdout ([utils.ts:69-72](../../apps/deploy-service/src/utils.ts#L69)).
Request logs: only 502s.

**How — build logs.** In the worker, each stdout/stderr chunk becomes `XADD logs:{id} MAXLEN ~ 5000 *
t <ms> s <out|err> l <line>` on a Redis Stream. On terminal state, the worker concatenates the stream to
R2 at `logs/{id}.txt` and deletes the stream. The upload service exposes `GET /deployments/:id/logs`:
while `state IN ('queued','building')` it serves Server-Sent Events from `XREAD BLOCK` on the stream;
once terminal it serves the R2 object with `Cache-Control: immutable` (a deployment's log, like its
files, never changes). The dashboard detail page gets a live log panel. Redaction: replace any
`build_env` value ≥ 8 chars with `[REDACTED]` before `XADD` (Vercel's threshold is 32 for its own
reasons; ours should be lower because our values are short). Retention: indefinite, like Vercel, capped
at 4 MB per build; the AOF Redis already in compose keeps in-flight streams across a restart.

**How — runtime logs.** The request handler emits one structured JSON line per request to stdout
(`pino` is the conventional Node choice, `(general knowledge)`): `{deploymentId, host, path, status,
bytes, ms, cache: HIT|MISS}`. A collector (Vector or Grafana Alloy → Loki, or CloudWatch if staying on
AWS; `(general knowledge)`, choose in Phase 10) ingests stdout from every container. Retention 1–3
days, matching the class. The dashboard reads Loki per project. This is the same data source the
metrics in G4 aggregate, so it is built once.

**Tier.** B. **Breaks at C:** per-request logs at edge scale need sampling and a drain product; the
stream-per-build model needs a cap on concurrent streams (bounded by worker count K, so it is bounded
today).

### G4 — Metrics (the operator's gap #4)

**The class.** Vercel's dashboard shows per-project requests, error rate, cache hit ratio, function
duration, build duration and queue time; runtime-log fields already include `cache`, `status`,
`region`, `deploymentId` (runtime-logs doc, Log details table). The platform-operator side (queue
depth, worker saturation, R2 latency) is internal to Vercel and undocumented `[unverified]`.

**We have.** Nothing.

**How.** Two audiences, two surfaces:

- *Platform metrics* (for us): `prom-client` `/metrics` on each service `(general knowledge)`:
  `build_duration_seconds` histogram by outcome, `builds_total` counter by outcome, `build_queue_depth`
  gauge (`LLEN build-queue`), `builds_in_flight` gauge, `http_requests_total{service,status}`,
  `r2_fetch_seconds` histogram, `cache_hits_total`/`cache_misses_total`. Prometheus + Grafana as two
  more compose services, or Grafana Cloud's free tier to keep the box small. Alerts: queue depth over
  N for 10 min, 5xx ratio over 1 % for 5 min, no successful build in 24 h while builds were queued.
- *Per-site metrics* (for tenants): the request handler does `HINCRBY site:{projectId}:{yyyymmdd}
  requests 1` and `… bytes N` per request (one Redis op, no DB write on the hot path); a nightly job
  rolls the hashes into a `site_daily_stats` table and expires the hashes. Dashboard shows a 30-day
  requests/bytes/error sparkline per project. That is the "Web Analytics"-shaped view, without client
  scripts.

**Tier.** B. **Breaks at C:** a Redis counter per request stops scaling when the handler is replicated
across regions; the fix is per-replica aggregation flushed on an interval, then a time-series store.

### G5 — Serving at scale, or "where is the load balancer" (the operator's gap #1)

**The correction first.** Caddy's `reverse_proxy` "proxies requests to one or more backends with
configurable transport, load balancing, health checking", with `lb_policy` (`round_robin`,
`least_conn`, `ip_hash`, …), active checks (`health_uri`, `health_interval`, `health_status`), passive
checks (`fail_duration`, `max_fails`, `unhealthy_status`), and dynamic upstreams from SRV or A records
(caddyserver.com/docs/caddyfile/directives/reverse_proxy, fetched 2026-09-10). So a load balancer *is*
in the stack. It fronts exactly one upstream ([Caddyfile.prod:67](../../Caddyfile.prod#L67)) on one
machine, there is no `/healthz` for it to probe, and there is no cache between it and R2. The gap is not
"add a load balancer"; it is replicas, a probe, a cache tier, and eventually more than one machine.

**The class.** Vercel: "126+ PoPs", routing evaluated at the edge before any origin work, a CDN cache
that "stores responses across Vercel regions" (cdn doc, via `arch-vercel-system-design`). That is Tier
C and stays documented. What a Forge-class internal platform actually runs, `(general knowledge)`, is
one region, N replicas behind a proxy, a CDN in front for static assets, and Kubernetes or an
equivalent scheduler. That is our Tier B target.

**We have.** Correct serving (SPA fallback, MIME, 404 vs 502) and TLS; capacity of one process.

**How, in order of cost.**

1. **`/healthz` first** on both HTTP services, mounted before the wildcard route, asserting Redis
   reachability, reading nothing tenant-shaped. Without it the wildcard route turns a probe's
   `Host: <ip>` into deployment id `10` and marks a healthy replica dead
   ([01-cluster-hosting-research.md §11.1](01-cluster-hosting-research.md)).
2. **Replicate the request handler on the same box.** `deploy.replicas: N` on the compose service;
   Caddy `reverse_proxy request-handler:3001 { lb_policy least_conn  health_uri /healthz }` — compose
   DNS returns all replica IPs and Caddy's A-record dynamic upstreams pick them up. The replication
   verdict must be re-derived from the code on disk, not the reference repo: the handler holds no
   per-request state ([request-handler/src/index.ts:45-84](../../apps/request-handler/src/index.ts#L45)),
   so N copies are interchangeable and sticky sessions are unnecessary (`arch-scale-and-loadbalancing`
   branch B).
3. **A cache tier, derived from immutability.** Every object under `dist/{id}/` is write-once, so
   `Cache-Control: public, max-age=31536000, immutable` is *provably* correct for the `{id}.domain`
   URL (ledger row S2; RFC 8246). Two places to hold it: Caddy's cache module or Cloudflare's CDN in
   front of the wildcard. The memory notes the wildcard record is deliberately DNS-only today because
   the apex must never be proxied; proxying only `*.domain` while leaving the apex grey is a per-record
   choice and would make Cloudflare the edge cache for every tenant site at no cost — verify the
   wildcard-cert and Host-header behaviour under the orange cloud before flipping it (`[unverified]`;
   the `clone-host-header-trust-contract.md` reference has the conformance probes). The production
   pointer URL (`{slug}.domain`) must **not** be immutable-cached; it changes on promote.
4. **More than one machine.** The researched path is the DOKS plan in
   [01-cluster-hosting-research.md](01-cluster-hosting-research.md): Gateway API via Cilium (not
   ingress-nginx, retired March 2026), cert-manager DNS-01 for the wildcard, KEDA `ScaledJob` for
   builds, managed Valkey for the queue. Nothing in that plan is invalidated by the EC2 detour; the
   compose files are the interim.

**Tier.** Steps 1–3 reach B on one box; step 4 is B→C. **Breaks at C:** one proxy VIP saturates,
which needs ECMP and connection-preserving hashing (Maglev, Unimog, Katran); users worldwide need
anycast. Those are LB-library questions, by path:
`E:/Development/Portfolio-phase2/custom-load-balancer/.claude/skills/` (`layer-l7-routing`,
`lb-resilience-health`, `layer-anycast-bgp`, `paper-google-maglev`). Not restated here.

**Redis is the single point** the whole way through: queue, log streams, alias cache, counters.
Named, per the bridge skill's non-negotiable 8; AOF on, no replica. A managed Redis/Valkey with a
replica is the Tier B answer; sharding is Tier C.

### G6 — Durability, graceful shutdown, admission control (prerequisite hygiene)

**The class.** Vercel: deployment creation is durable-store-then-schedule, failure is a terminal
state, jobs survive a worker loss (ledger row B5). Coolify returns 429 when its queue is full (source,
above).

**We have.** `brPop` at [deploy-service/src/index.ts:21](../../apps/deploy-service/src/index.ts#L21):
the id leaves Redis before the build starts. No SIGTERM handler in the deploy worker, so **every
`docker compose up -d` that recreates the worker mid-build orphans that build in `building` forever**
([01-cluster-hosting-research.md §9.3](01-cluster-hosting-research.md)). The schema has an index
"for the reaper" ([schema.ts:73](../../apps/upload-service/src/schema.ts#L73)) but no reaper exists.
No rate limit, no queue bound.

**How.** `BLMOVE build-queue processing:{workerId} RIGHT LEFT 0`, `LREM` on completion; a reaper (a
cron in the upload service or a sixth compose service) that requeues rows `building` longer than the
build timeout and moves rows that fail twice to `failed` with reason `retries exhausted`; SIGTERM
handler that stops popping, lets the in-flight build finish up to `stop_grace_period`, then exits.
Admission: token bucket per user on `POST /deploy` and per project on the hook (Redis `INCR` with
`EXPIRE`, `429` + `Retry-After`), queue bound via `LLEN` before `LPUSH` (`503` + `Retry-After`), worker
count K derived from cores and memory — the three-gate design in
`arch-scale-and-loadbalancing` branch D, numbers reconciled against K/S. A build timeout (Vercel's is
45 min; ours should be 15) via a timer that sends `SIGKILL` to the child, recorded as `failed: timeout`.

**Tier.** B. **Breaks at C:** one Redis; managed queue semantics (visibility timeout, DLQ) buy
availability and cost per message.

### G7 — Build isolation (the wall)

**The class.** "A secure, isolated virtual environment … Build processes can't interfere with other
users' applications" (builds doc, via `arch-vercel-system-design` non-negotiable 2).

**We have.** `exec` on the worker host ([utils.ts:64](../../apps/deploy-service/src/utils.ts#L64)) with
an env allowlist ([utils.ts:17](../../apps/deploy-service/src/utils.ts#L17)) and a compose memory cap.
That is blast-radius reduction, not isolation: a `postinstall` script still has the network, the disk,
and the container's process. The R2 keys are withheld from the child, which is the single most
important line in the worker, but the worker process itself holds them, and a container escape is a
documented class ([01-cluster-hosting-research.md §8.2](01-cluster-hosting-research.md), four vendors
on record).

**How.** Three honest options are already researched ([§8.5](01-cluster-hosting-research.md)):
accept-and-say-so for single-tenant trust; build off-box on a microVM service (Fly Machines, Vercel
Sandbox, E2B); or own the nodes with gVisor/Kata. The interim step that is worth doing on the current
box regardless: run each build as a **separate container** (`docker run --rm --memory 2g --cpus 1.5
--pids-limit 512 --read-only -v build:/src node:22`), with the worker doing clone, copy-in, and upload
from *outside* the container so the build sees zero credentials. Network: `--network none` breaks
`npm install`, so the build container needs an egress allowlist (a registry mirror on a dedicated
compose network) instead `[design choice; verify npm's proxy behaviour before relying on it]`. Private
repos: a GitHub App with `Contents: read`, installation access tokens minted per clone via `POST
/app/installations/{id}/access_tokens`, valid for one hour (docs.github.com, fetched 2026-09-10),
never stored.

**Tier.** Container-per-build is B for trusted tenants. **Before public signup** the microVM option is
mandatory, not optional: the memory records that the current design is "single-tenant-trust only until
builds move off-cluster".

### G8 — Custom domains

**The class.** Every deploy platform terminates TLS for customer domains; the mechanism is
CNAME-to-platform plus on-demand certificate issuance `(general knowledge)`.

**We have.** Nothing beyond the wildcard.

**How.** A `domains` table (`project_id, hostname, verified_at, verification_token`); a `TXT` or CNAME
verification step; Caddy on-demand TLS with an `ask` endpoint that answers 200 only for verified
hostnames `[unverified this session — confirm at caddyserver.com/docs/automatic-https#on-demand-tls]`;
the request handler resolves `hostname → project → production pointer` through the same alias cache
as G2. **Tier.** B. **Breaks at C:** certificate volume (thousands of hosts) needs an encrypted cert
store and SNI routing at the edge.

### G9 — Out of scope, documented only

SSR and serverless functions (ledger row S5), ISR (S5), image optimisation (S6), a global edge (S3),
content-addressed upload dedup (I3), build cache (B7). Each is in the adopt-vs-document ledger with its
move condition. None blocks the Forge-class goal for static and SPA sites; SSR is the first one a real
tenant will ask for, and it is a different product (a runtime, not a file server).

---

## 4. Roadmap

Phases continue the numbering of [02-build-plan.md](02-build-plan.md); Phase 7 shipped 2026-08-12.
Each phase names the files it touches, the tier it reaches, and the observable that proves it.

| Phase | Closes | Scope (files) | Tier reached | Proof it worked |
|---|---|---|---|---|
| **8 — Hygiene** | G6, G5 step 1 | `request-handler/src/index.ts` (`/healthz`, validate id against DB); `upload-service/src/index.ts` (`/healthz`, rate limit, queue bound, shallow clone); `deploy-service/src/index.ts` (`BLMOVE`, SIGTERM, timeout); new reaper; `packages/shared` (state `canceled`) | B | Kill the worker mid-build → the build completes on restart. `compose up -d` during a build → no row stuck in `building`. 30 rapid deploys → the 11th gets `429`. |
| **9 — Projects + push-to-deploy** | G1, G2 | `schema.ts` (`projects`; deployment columns); `upload-service` (`POST /projects`, `POST /webhooks/github`, `POST /hooks/{token}`, `POST /projects/:id/promote`, rollback; clone moved to the worker); `request-handler` (three hostname shapes, alias cache); frontend (project page, enable the rollback button, branch previews) | B | Push to a connected repo → a new deployment appears within 60 s with no dashboard action. Push three commits fast → only the last builds. Rollback → the old build serves at `{slug}.domain` within 2 s, no rebuild. |
| **10 — Logs** | G3 | `deploy-service/src/utils.ts` (stream stdout/stderr to `logs:{id}`, redact, persist to R2); `upload-service` (`GET /deployments/:id/logs` SSE); `request-handler` (structured access log); compose (log collector); frontend (live log panel) | B | A failing build shows the compiler error line in the dashboard while the build is still running. A finished build's log is still readable a month later. |
| **11 — Metrics** | G4 | `packages/shared/src/metrics.ts` (`prom-client` registry); `/metrics` on all services; compose (Prometheus, Grafana) or Grafana Cloud; `request-handler` (per-site `HINCRBY`); nightly rollup; frontend (30-day sparkline) | B | Grafana shows queue depth, build p50/p95, 5xx rate. A tenant sees yesterday's request count for their site. An alert fires when the queue is stuck. |
| **12 — Serve at scale** | G5 steps 2–4 | compose (`replicas`), `Caddyfile.prod` (`lb_policy`, `health_uri`), cache tier (Caddy module or Cloudflare on `*.domain`), then the DOKS manifests from the cluster research | B, then B→C | Stop one handler replica → zero failed requests. Cache hit ratio above 90 % on a static site under load. Second node joins without downtime. |
| **13 — Isolation + private repos** | G7 | `deploy-service` (container-per-build, no creds inside); GitHub App (installation tokens); later: off-box microVM builder behind the same interface | B for trusted tenants; required before public signup | A repo with a `postinstall` that reads the env and the network sees no keys and no bucket. A private repo deploys. |
| **14 — Custom domains** | G8 | `schema.ts` (`domains`); `upload-service` (verify, `ask` endpoint); `Caddyfile.prod` (on-demand TLS); `request-handler` (hostname → project) | B | A tenant CNAMEs `www.theirs.com`, verifies, and it serves over HTTPS within a minute. |

**Why this order.** 8 before 9 because a webhook fires unattended; a platform that orphans builds on
restart will orphan them at 3 a.m. with nobody watching. 9 before 10 because logs are per-deployment
and the dashboard needs a project page to hang them on. 10 before 11 because the access log is the
metrics source. 12 is independent of 10–11 and can interleave. 13 is late in the build order and first
in the "open to strangers" order; nothing in 8–12 requires it as long as tenants are trusted.

**What each phase does not do.** None of them add SSR, functions, or an edge network. The result
after Phase 14 is a Tier B platform: one region, N replicas, one Redis with a replica, container
builds, a CDN cache in front. That is where a Forge-class internal platform for static and SPA sites
sits; the Tier C ceiling is documented in the research and not built.

### Phase 9 as built (2026-09-14)

Shipped: `projects` (one per user and repository, slug = production hostname label), the production
pointer with promote and rollback, `POST /webhooks/github` with accept-and-enqueue, the ingest loop
off the request path, `{slug}.domain` resolution in the request handler, and the project pages.
Deferred from the plan above: `{slug}-git-{branch}` preview hostnames and `POST /hooks/{token}`
(deploy hooks) — both are additive and nothing built here forecloses them. Decisions that differ
from the sketch in G1/G2, each taken after a review round proved the sketch wrong:

- **A push deploys only projects connected through the delivering installation.** Matching by
  repository name alone let a stranger's URL-import receive another tenant's private pushes (branch,
  commit SHAs, cadence) and let the repository's owner re-point a project they never owned. Projects
  added by URL therefore never deploy on push; picking the repository under Connect GitHub attaches
  the installation and turns pushes on.
- **The delivery id is a claim, not a receipt.** `SET NX` for ten minutes before work, overwritten
  with a day-long "done" only when every matching project was recorded, deleted on any failure —
  GitHub never retries by itself and a manual redelivery reuses the id, so a push lost to a transient
  error must be redeliverable. A delivery with a failed project answers 500 so GitHub's log shows it.
- **Raw body, own parser, 25 MB.** GitHub's payload cap; the signature is checked over the bytes
  before anything is parsed, and parser rejections are answered as JSON.
- **An `ingesting` state.** The loop claims `queued → ingesting` before any work, every write on the
  way is guarded on that claim, and the row returns to `queued` for a build worker once staged.
  Newest-per-branch cancels only `queued` rows older than the kept one, drops them from both queues,
  and sweeps what they staged. A database error while the popped id is in hand re-queues it.
- **Rollback pauses automatic promotion** (`projects.auto_promote`), as Vercel does; promoting a
  newer deployment resumes it. Without this a teammate's push silently undid a rollback.
- **Reserved labels and disjoint namespaces.** `app`, `www`, `api`, the RFC 2142 names and a few
  more can never be slugs; a deployment id is refused when it equals a slug, and a slug when it
  equals an id.
- **The database is not on the serving path's critical path.** The handler's slug cache is a bounded
  LRU (10,000 entries) whose entries expire at a time fixed when written — a hit refreshes recency,
  never freshness — so a pointer flip is visible within 15 s however busy the site is; "not a slug"
  is cached for 60 s; labels are lower-cased and validated before any lookup; concurrent misses share
  one lookup, which is aborted after 3 s; on a database failure the last known answer is served, else
  the label is tried as a deployment id, either cached for 5 s, and a miss is a 503 rather than a
  confident 404. `/healthz` answers only under a non-site hostname. Every response names the
  deployment that answered it in `X-Deployment-Id`.
- **The receiver refuses before it buffers.** The headers GitHub always sends (signature shape,
  delivery id, event, content type) are checked before a byte of body is read; at most four bodies
  are held at once; Caddy caps the webhook path at 26 MB and the rest of the API at 1 MB. Routing
  is strict and case-sensitive, so the parser gate and the route agree on what the path is.
- **A row's objects never outlive it.** The build worker treats a failed `building → deployed`
  transition as "the row is gone" and sweeps what it just uploaded, so deleting a project or a
  deployment mid-build leaves no rowless site; a project delete answers as soon as the rows are gone
  and sweeps off the request path. The deployment a project serves as production cannot be deleted
  (409): promote or roll back first.
- **Pointer semantics come from the server.** The project payload carries when its production
  deployment was created and which deployment a rollback restores, computed over the whole history,
  so the dashboard's "promote" versus "roll back" wording and its rollback button do not depend on
  the page of rows the client happens to hold.
- **Backlog is bounded per tenant before it is bounded per platform:** ten queued-or-ingesting
  deployments per account (429 from the dashboard, a failed-and-released delivery from a push), then
  the global queue depth. A manual deploy supersedes the project's older queued rows like a push
  does. There is no per-project push rate budget: newest-per-branch already keeps one queued row per
  project, and dropping a push would leave the tip undeployed.
- **Mutating routes refuse cross-site browsers.** A request carrying an `Origin` other than the
  dashboard's is answered 403, so a tenant page on a sibling hostname cannot deploy, promote or delete
  with the visitor's session. Uninstalling the App detaches its projects, so the page says pushes are
  off instead of silently never deploying.
- **Production is the repository's default branch, as last seen.** A manual deploy clones the
  remote's HEAD; a push deploys only when it is to `repository.default_branch`; both update the
  project's recorded branch, so renaming `master` to `main` on GitHub keeps deploying instead of
  freezing the first name forever. Pushes to other branches are ignored (previews are deferred), and
  choosing a non-default branch by hand is a later feature.
- **The worker cannot be killed by one object.** The download awaits every fetch and write, so a
  missing or unreadable object fails that one build with a fixed sentence instead of crashing the
  shared worker as an unhandled rejection; every build's local tree is removed afterwards whatever
  the outcome, and leftovers are swept at boot; promotion and the screenshot run after the row is
  committed and cannot mark a deployed build failed.
- **The pointer is the database's invariant.** `projects.production_deployment_id` is uniquely
  indexed (so the FK's delete action never scans the table) and is a composite foreign key on
  `(project id, deployment id)`, so a project can only ever point at its own deployment. Deleting a
  deployment locks its project row first, so a promote committing at the same instant is waited for
  rather than overtaken. A storage sweep that only partly succeeded is reported as such, never as a
  clean count.

Still open, recorded here rather than fixed: the request handler holds the full database credential
for one `SELECT` (a read-only role, or the pointer published to Redis at promote time, is the fix);
the dashboard's session cookie is not `__Host-`-prefixed, so a tenant site on a sibling hostname can
set a cookie the dashboard receives (a separate apex for the dashboard is the real fix); the reaper
for rows stuck in `queued`/`ingesting` after a crash is Phase 8's; a webhook deployment clones the
branch tip at clone time and records the commit it actually built, rather than fetching the pushed
commit by SHA, so two pushes seconds apart can both build the later commit; "newest" is the row's
creation time, not the push's, so two deliveries for one branch processed concurrently could in
principle be ordered wrongly (GitHub delivers a hook's events serially in practice; the payload's
`before` field would let a lineage check replace the timestamp); `repository.id` is not stored, so a
renamed repository stops matching pushes until it is picked again; the list routes return the newest
50 projects / 50 deployments per project / 20 deployments per account with no cursor, so a long
history is truncated on the dashboard; the per-account backlog bound is a count-then-insert, so
concurrent requests can overshoot it by the number in flight (bounded by the deploy rate budget);
an expired pointer entry is served once more while it refreshes, so a flip is visible within 15 s
plus one request rather than exactly 15 s.

**What this platform does not run: servers.** A build must produce static files. A Next.js
application with API routes, server components that fetch at request time, or preview mode (the
Prismic helpers `api/preview`, `api/exit-preview`, `api/revalidate` are the usual case) is refused
with a sentence at build time, because nothing here would run `next start`. Two ways out: make the
site static (`output: "export"` in `next.config.js`, remove the API routes, give dynamic pages a
`generateStaticParams`, and redeploy on content changes), or build G9 — a runtime tier that runs a
process per project and proxies its hostname to it — which is a phase of its own.

---

## 5. Pre-mortem — six months out, this failed. Why?

1. **The webhook shipped before the queue was durable.** Builds went missing overnight, tenants lost
   trust in "push and it's live", and the platform became "push, then check, then paste the URL
   again", which is worse than the manual flow. Mitigation: Phase 8 is not skippable.
2. **The clone stayed on the request path.** The first repo with a large history made the webhook
   receiver miss GitHub's 10 s window, deliveries were recorded as failed, and GitHub does not retry.
   Mitigation: move the clone into the worker in Phase 9, not later.
3. **Logs filled Redis.** A build that printed a progress bar emitted 200,000 lines; with no
   `MAXLEN` the stream ate the box's memory and took the queue down with it. Mitigation: `MAXLEN ~`
   on every `XADD`, 4 MB cap, and the AOF file size watched by a metric.
4. **The immutable cache header was put on the production-pointer URL.** Rollback "worked" in the
   database and did nothing in browsers for a year. Mitigation: two cache policies, tested by a probe
   that promotes and expects the new body on the very next request.
5. **Public signup opened with container-per-build and no microVM.** One malicious repo's
   `postinstall` reached the compose network and the Redis instance. Mitigation: a strict egress
   allowlist on the build network, and no signup until the off-box builder exists.
6. **Custom domains issued certificates for hostnames nobody verified**, and the box hit Let's
   Encrypt's rate limit. Mitigation: the `ask` endpoint gates issuance on `verified_at IS NOT NULL`.

---

## 6. Confidence and open questions

| Claim | Confidence | Basis |
|---|---|---|
| The four named gaps are real and the code on disk has no partial implementation of any of them | **High** | Full read of all five services and the schema this session; `rg` for webhook/metrics/logging terms found only the research doc |
| The webhook receiver contract (HMAC-SHA256, 10 s, no automatic retry) | **High** | Three GitHub docs fetched this session |
| Caddy already provides the load-balancing and health-check primitives | **High** | Caddy directive doc fetched this session |
| Vercel's log retention and build-log behaviour | **High** for the two fetched pages; the operator-side platform metrics are `[unverified]` | vercel.com/docs, `last_updated` 2026-08-28 |
| Container-per-build on the current box is achievable without ambient credentials | **Medium** | Design follows the cluster research; npm egress through an allowlist is a known snag not measured here |
| Cloudflare proxying `*.domain` as the cache tier | **Medium** | Per-record proxying is standard `(general knowledge)`; interaction with the DNS-01 wildcard cert and Host forwarding not tested |
| Fox's Forge is comparable to this gap list | **Low** | Not publicly documented; only Fox platform-engineering job postings surfaced. The comparison is to the *class*, via Vercel and the three source-read OSS platforms |

**Open questions, each with the action that closes it.**

1. Which log collector: Loki on the box (memory cost on a 4 GB machine), Grafana Cloud free tier
   (external dependency), or CloudWatch (already on AWS)? Decide in Phase 10 with the box's free memory
   measured, not guessed.
2. Does GitHub App installation (private repos, PR previews) belong in Phase 9 or Phase 13? It is
   cheap to register the App early and mint tokens only when a private repo is connected.
3. Is the branch-preview hostname `{slug}-git-{branch}` safe under the 63-character DNS label limit
   with long branch names? Vercel truncates (generated-urls doc); we need the same rule.
4. The reaper's home: a cron inside the upload service (one fewer container, but a scheduler on a
   request-serving process) or a sixth compose service (cleaner, one more thing to run).
5. Whether Cloudflare's proxy in front of `*.domain` forwards `Host` unchanged for the wildcard, so
   the handler's first-label tenant lookup keeps working. One conformance probe answers it.

---

*Sources fetched 2026-09-10: docs.github.com (validating-webhook-deliveries,
handling-failed-webhook-deliveries, generating-an-installation-access-token-for-a-github-app);
vercel.com/docs/deployments/logs; vercel.com/docs/logs/runtime;
caddyserver.com/docs/caddyfile/directives/reverse_proxy;
raw.githubusercontent.com/coollabsio/coolify/v4.x/app/Http/Controllers/Webhook/Github.php. All other
Vercel citations are inherited from [00-architecture-research.md](00-architecture-research.md) and the
`arch-vercel-system-design` skill's dated ledgers.*
