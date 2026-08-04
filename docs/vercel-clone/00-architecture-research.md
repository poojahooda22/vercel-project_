# Research Findings — How Vercel Actually Works (upload → build queue → serving)

> **Provenance.** Produced by a 10-agent deep-research workflow (5 research tracks, each
> adversarially verified by an independent agent) run 2026-08-03. 969,864 tokens, 193 tool
> calls, 0 agent errors, **`rate_limit_hit=false` on all 5 verifiers** — the
> `research-methodology` rate-limit false-refute trap does not apply; every verdict is real.
> **Every adversarially-checked claim returned CONFIRMED; zero REFUTED.** Claims not in the
> verified subset carry their fetch provenance; anything weaker is flagged inline.
>
> **Research-first stage:** this is the *research* artifact (understand). The design doc for
> the clone derives from it and does not exist yet.
>
> Product names, limits, and prices are **as fetched from live pages, June–August 2026**
> (`last_updated` stamps noted where the verifier recorded them). These change; re-fetch
> before quoting.

---

## 1. Executive answer

The three-service model you described is real and is the canonical teaching decomposition —
but each service maps to something more specific in production Vercel:

| Your framing | Real Vercel | The clone (100xdevs) |
|---|---|---|
| **Upload service** — user gives a repo | Git integration (GitHub App webhook, shallow clone `--depth=10`) *or* content-addressed CLI upload (`POST /v2/files` by SHA1) | Express service: `simple-git` clone → random ID → files to S3 → `LPUSH build-queue` |
| **Deploy service** — build what's inside | Async build scheduling (SQS per the 2023 blog) → **two documented queues** (concurrency + git-branch) → build in a Firecracker microVM on **Hive** → output in **Build Output API** format → artifacts to CDN + function store | `while(1)` + blocking `BRPOP` → `npm install && npm run build` **unsandboxed** → dist back to S3 |
| **Request/hosting service** — serve it | Anycast → 126 PoPs → 20 AWS-backed regions → proxy **de-aliases** Host header to a deployment → static from CDN cache (no compute) / functions invoked on AWS Lambda (Fluid) | One Express proxy: `host.split(".")[0]` → stream `dist/${id}${path}` from S3 |

**The answer to "how are my 20–30 sites running with millions of users on the platform":
they aren't running.** A Vercel deployment is *data, not a process* — static assets pushed
to the CDN cache, function bundles in a function store, and routing metadata in a globally
replicated database. Nothing executes while a site is idle. Compute exists only for the
milliseconds a request is in flight ("there is no single server assigned to your
application... a computing instance... is spun up to handle the request, and then spun down
after the request is complete" — [what-is-compute](https://vercel.com/docs/fundamentals/what-is-compute)).
That is the entire economic trick: a million idle sites cost storage, not servers.

**The queue is real and documented.** Two queues govern builds
([build-queues](https://vercel.com/docs/builds/build-queues)): a **concurrency queue**
(per-plan build slots: Hobby 1, Pro 3 default) and a **git branch queue** (same-branch builds
serialize; obsolete intermediate commits are *skipped*, only the newest is built). The 2023
engineering blog names **Amazon SQS** as the scheduling mechanism between "deployment
created" and "build starts" ([behind-the-scenes](https://vercel.com/blog/behind-the-scenes-of-vercels-infrastructure)).

---

## 2. The mental model — a deployment is data, not a process

Verified chain, all primary sources:

1. Build output is split at deploy time: "static assets (sent to the cache) and compute
   artifacts (sent to the function store). It then compiles your configuration into the
   metadata that powers the proxy" — [infrastructure](https://vercel.com/docs/fundamentals/infrastructure).
2. Every deploy is an **immutable deployment** with a unique URL; "every Git push and Vercel
   CLI invocation will result in a new unique URL and a new immutable Deployment" —
   [changelog](https://vercel.com/changelog/every-push-now-receives-a-unique-url).
3. Every domain is an **alias** — a pointer in the routing layer to one deployment.
   "Switching that alias... happens instantly. There's no DNS propagation" —
   [life-of-a-request](https://vercel.com/blog/life-of-a-request-application-aware-routing).
   Promotion and **instant rollback** are pointer updates, not rebuilds
   ([instant-rollback](https://vercel.com/docs/instant-rollback)).
   - Nuance the marketing copy hides: promoting a **staged production** deployment is
     rebuild-free, but promoting a **preview** deployment to production triggers "a complete
     rebuild" because preview env vars can't be reused
     ([promoting-a-deployment](https://vercel.com/docs/deployments/promoting-a-deployment)).

This immutable-artifact + alias-pointer pattern is the category invariant, not a Vercel
invention: Netlify's deploys are content-addressed Merkle trees where going live "only
swap[s] the tree to serve" ([Netlify engineering](https://medium.com/netlify/how-netlifys-deploying-and-routing-infrastructure-works-c90adbde3b8d)),
and Heroku's releases are "an append-only ledger" of slug + config
([how-heroku-works](https://devcenter.heroku.com/articles/how-heroku-works)).

---

## 3. Service 1 — upload / ingestion

Two paths into the platform:

- **Git path (the default).** A GitHub App with Contents R/W + Webhooks R/W permissions;
  "Vercel for GitHub will deploy every push by default"
  ([vercel-for-github](https://vercel.com/docs/git/vercel-for-github)). The build
  environment fetches source with a **shallow clone**: `git clone --depth=10`
  ([builds](https://vercel.com/docs/builds)).
- **Upload path (CLI/API).** Content-addressed: each file `POST /v2/files` with
  `x-vercel-digest` = SHA1; a 200 means "File already uploaded" — the store dedupes by
  digest ([upload-deployment-files](https://vercel.com/docs/rest-api/deployments/upload-deployment-files)).
  Then `POST /v13/deployments` references files by SHA; the deployment walks
  `QUEUED → INITIALIZING → BUILDING → READY/ERROR`
  ([create-a-new-deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)).
- The `vercel deploy --prebuilt` escape hatch (upload only `.vercel/output`, "without
  exposing your source code to Vercel") confirms the artifact contract is the Build Output
  API, whatever the ingestion path.

**Clone lesson:** content-addressing the upload store (hash → file) is cheap to imitate and
is exactly what Netlify does per-file ("If you only change one file, we will only upload one
file"). The 100xdevs clone skips it and re-uploads everything.

---

## 4. Service 2 — the build system and THE QUEUE

### 4.1 The two documented queues

From [build-queues](https://vercel.com/docs/builds/build-queues) (fetched 2026-06-24 stamp):

- **Concurrency queue** — gated by per-plan concurrent build slots. "Hobby accounts allow
  one build at a time. Pro accounts include 3 concurrent build slots by default... If all
  concurrent build slots are in use, new builds are queued until a slot becomes available."
- **Git branch queue** — same-branch builds are sequential, and it **skips obsolete
  builds**: "The current build is completed first. Queued builds for earlier commits are
  skipped. The most recent commit is built and deployed." Intermediate commits never build.
  (Internal name leaks into the public API: `buildQueue.configuration` takes
  `SKIP_NAMESPACE_QUEUE` / `WAIT_FOR_NAMESPACE_QUEUE` — the branch queue is a "namespace
  queue" — [managing-builds](https://vercel.com/docs/builds/managing-builds).)

Ordering is **FIFO** with three escape hatches: *Prioritize Production Builds* (production
jumps queued previews), per-deployment *Start Building Now*, and Enterprise *Urgent
On-Demand Concurrency* ([managing-builds](https://vercel.com/docs/builds/managing-builds)).

**Since Sept 9, 2025**, paid teams default to **On-Demand Concurrent Builds**: the
concurrency queue disappears (builds "skip the queue and run immediately", billed per
concurrent build), leaving only branch serialization — backstopped by a fair-use cap of
**500 concurrent builds/team**, beyond which requests queue again
([fair-use](https://vercel.com/docs/limits/fair-use-guidelines)). Even "unlimited" has a
queue behind it.

### 4.2 Why a queue exists at all

Vercel's own engineering blog describes deployment creation as **two async steps**: files
POSTed "to a scalable, secure, and highly durable data storage service", then "the
deployment gets scheduled for building" — footnoted as **Amazon SQS**
([behind-the-scenes](https://vercel.com/blog/behind-the-scenes-of-vercels-infrastructure),
Jan 2023). Upload and build are decoupled so ingestion never blocks on build capacity, spikes
absorb into the queue instead of dropping, and workers pull at their own rate.

> **Contradiction, on record:** the SQS footnote is Jan 2023; the Hive platform post
> (builds "since November 2023") describes control-plane job placement but never names the
> upstream queue technology. The two-stage async architecture is confirmed; *whether SQS is
> still the queue in 2026 is not* — treat "SQS" as the 2023 snapshot.

Every comparable platform has the same shape: Netlify has **three** queues (system / team /
context — the context queue mirrors Vercel's skip-obsolete branch queue verbatim:
"the newest enqueued build of identical context begins"
— [Netlify docs](https://docs.netlify.com/build/configure-builds/troubleshooting-tips/));
Cloudflare Pages caps concurrency 1/5/20 by plan
([limits](https://developers.cloudflare.com/pages/platform/limits/)); Heroku gates 10/300
concurrent builds on account trust ([limits](https://devcenter.heroku.com/articles/limits)).
**Bounded build concurrency + an async overflow queue is the universal platform pattern.**

### 4.3 What executes the build: Hive

From [the Hive deep-dive](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure)
(all verified verbatim):

- Bare-metal "**boxes**" run KVM; "**cells**" are **Firecracker microVMs**, 1:1 with a
  Firecracker process, each with dedicated CPU/memory and rate-limited disk/network.
- A control plane "orchestrates the cluster, managing job placement, and handling
  autoscaling"; the build runs *in a container inside a cell*; the cell is destroyed after.
- **Warm pools**: a pre-warmed cell starts the build immediately; cold provisioning ~5s
  (down from ~90s pre-Hive).
- Isolation is the point: builds run **untrusted user code** (`npm install` executes
  arbitrary scripts). Firecracker's spec commits to ≤125ms boot, ≤5MiB VMM overhead
  ([SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md));
  it has powered AWS Lambda/Fargate in production since 2018
  ([AWS](https://aws.amazon.com/blogs/aws/firecracker-lightweight-virtualization-for-serverless-computing/)).
  - Not a monoculture: Cloudflare Pages chose **gVisor**-sandboxed containers on warm VMs
    (2+ min per-build VMs → 2–3s starts) because bare containers "share a kernel with the
    host" ([Cloudflare blog](https://blog.cloudflare.com/cloudflare-pages-build-improvements/));
    Fly.io chose Firecracker because "Docker's isolation isn't strong enough" for
    high-density multitenancy ([fly.io](https://fly.io/blog/docker-without-docker/)).
    A design doc must pick one and say why — "the industry standard" names two standards.

### 4.4 Build limits (fetched June–July 2026; re-check before quoting)

- Max build time **45 min** all plans; build cache **1 GB**, one month
  ([limits](https://vercel.com/docs/limits), [builds](https://vercel.com/docs/builds)).
- Machine tiers: Standard 4vCPU/8GB, Enhanced 8/16, Turbo 30/60, Elastic auto-scales 4–30
  vCPU billed from $0.0035/CPU-min ([managing-builds](https://vercel.com/docs/builds/managing-builds)).
  (The `/docs/builds` resource table showed 8192MB/32GB/2-or-4 CPUs — the docs' two tables
  disagree slightly; both cited, quote whichever page you mean.)
- 100 deployments/day Hobby, 6,000/day Pro.
- Build-avoidance reduces queue pressure: monorepo "skipping unaffected projects" does NOT
  occupy a build slot; the scripted Ignored Build Step DOES count toward limits
  ([monorepos](https://vercel.com/docs/monorepos)).

### 4.5 The artifact contract: Build Output API

Every build terminates in a filesystem contract at `.vercel/output`
([build-output-api](https://vercel.com/docs/build-output-api)):

- `config.json` — `"version": 3`, routes array (handler phases
  `rewrite/filesystem/resource/miss/hit/error`), images, crons.
- `static/` — "served with the Vercel Edge CDN".
- `functions/<name>.func/` — each with `.vc-config.json` (runtime, handler, memory,
  regions); ISR via `<name>.prerender-config.json`.

This is what "framework-defined infrastructure" means: the framework emits this directory;
the platform infers the infrastructure from it. **This is the single highest-value idea to
steal for the clone** — it makes the deploy service framework-agnostic.

---

## 5. Service 3 — the request-serving path

Life of a request, each hop primary-sourced:

1. **DNS** resolves to an **anycast IP** owned by Vercel
   ([infrastructure](https://vercel.com/docs/fundamentals/infrastructure)).
2. A global load balancer picks the optimal **PoP** — **126 PoPs, 51 countries** — by hops,
   RTT, bandwidth; traffic then leaves the public internet onto a private backbone
   ([regions](https://vercel.com/docs/regions)).
3. PoPs terminate **TCP**, do first-line DDoS, and route to one of **20 compute regions**
   whose codes map 1:1 to AWS regions (`iad1`=us-east-1, `fra1`=eu-central-1; functions
   default `iad1`) — the compute plane sits on AWS.
   - **Contradiction, on record:** [regions](https://vercel.com/docs/regions) says the
     *region* does TLS ("PoPs terminate TCP... The Vercel region... handles TLS encryption
     and decryption"), while [infrastructure](https://vercel.com/docs/fundamentals/infrastructure)
     narrates a TLS terminator at the edge holding "millions of concurrent connections".
     Adopt "PoP = TCP, region = TLS", flag that Vercel's own docs blur it.
4. **De-aliasing**: the application-aware proxy maps Host header → deployment ("the reverse
   process of mapping the domain to a specific deployment") using "a globally replicated
   metadata service that contains the configuration for every deployment"
   ([life-of-a-request](https://vercel.com/blog/life-of-a-request-application-aware-routing)).
   This is the clone's `host.split(".")[0]`, grown up: a replicated routing DB instead of a
   string split.
5. **Static / cache hit**: served from the CDN "without invoking your origin" — zero
   compute ([cdn](https://vercel.com/docs/cdn)). **ISR** is platform-managed
   stale-while-revalidate: 31-day durable cache by the function region, background
   regeneration, global purge ≤300ms, concurrent misses collapsed to one invocation,
   failed revalidation keeps stale + 30s retry TTL
   ([ISR docs](https://vercel.com/docs/incremental-static-regeneration)).
6. **Dynamic**: the Function Router invokes the function on **AWS Lambda**. "Vercel
   Functions run on AWS Lambda" — Fluid compute keeps Lambda underneath but adds a
   Rust-based core in the instance + a custom TCP tunnel to the router, giving streaming and
   many-requests-per-instance concurrency; >99% of requests hit a router pod that may
   already hold a warm connection
   ([fluid blog](https://vercel.com/blog/fluid-how-we-built-serverless-servers)). Fluid is
   default since Apr 23, 2025; durations 300s default / 800s max
   ([fluid-compute](https://vercel.com/docs/fluid-compute)).
   - **"Scale to zero" caveat:** paid production keeps "a minimum of one active function
     instance running" pre-warmed; Hobby/preview genuinely scale to zero and cold-start
     ([what-is-compute](https://vercel.com/docs/fundamentals/what-is-compute)).
7. **Custom domains at millions-of-domains scale**: apex A-record to shared anycast
   `76.76.21.21` (newer pool addresses exist — the dashboard card is authoritative), or
   per-project CNAME; certs auto-issued per domain via **Let's Encrypt** (HTTP-01;
   DNS-01 for wildcards, which is why wildcards need Vercel nameservers); at TLS handshake
   the edge selects the cert **per hostname via SNI** from an encrypted-at-rest DB, cached
   in memory; one wildcard cert covers all `*.vercel.app`
   ([ssl](https://vercel.com/docs/domains/working-with-ssl),
   [encryption](https://vercel.com/docs/cdn-security/encryption),
   [a-record KB](https://vercel.com/kb/guide/a-record-and-caa-with-vercel)).

---

## 6. The 100xdevs clone, read at source level

Reference: `github.com/hkirat/vercel@29ac934` (single "Init" commit, Feb 8 2024, same-day as
the video "I built Vercel in 4 Hours"). Every claim below verified by direct fetch of the
raw source files.

### 6.1 What the code actually does

| Service | File | Verified behavior |
|---|---|---|
| **upload** | `vercel-upload-service/src/index.ts` | `simple-git` clone → random short ID → upload files to S3 → `lPush("build-queue", id)` + `hSet("status", id, "uploaded")`; `/status` reads the hash |
| **deploy** | `vercel-deploy-service/src/index.ts` | `while(1)` + blocking `brPop("build-queue", 0)` → download source from S3 → `buildProject(id)` → upload dist → `hSet("status", id, "deployed")` |
| **build step** | `vercel-deploy-service/src/utils.ts` | `child_process.exec("cd ... && npm install && npm run build")` — **no sandbox, no timeout, no resource limits, no error path**; promise resolves regardless of exit code |
| **request-handler** | `vercel-request-handler/src/index.ts` | Express `app.get("/*")` on :3001 → `host.split(".")[0]` → S3 `dist/${id}${filePath}` → Content-Type ternary: html/css/**everything-else-is-application/javascript** |
| **frontend** | `frontend/src/components/landing.tsx` | POST `/deploy` → `setInterval` polls `/status` every 3s until "deployed" |

Queue = raw Redis list (not BullMQ). Status = one Redis hash (no DB, no logs, no deployment
records). The same 3-service shape appears independently in Piyush Garg's clone
(api-server / Docker build-server on ECS / s3-reverse-proxy,
[repo](https://github.com/piyushgarg-dev/vercel-clone)) and Jash Agrawal's Medium series —
it is the canonical teaching design, not one instructor's quirk. Notably, **Garg's version
sandboxes builds in Docker; Harkirat's does not** — writeups conflate the two.

### 6.2 The gap table (each gap grounded in a primary source)

| Gap | Clone | Real Vercel |
|---|---|---|
| **Build isolation** | `npm install` unsandboxed on the worker, with the worker's AWS creds in env | Container in a Firecracker microVM on Hive ([build-image](https://vercel.com/docs/builds/build-image): Amazon Linux 2023 container) |
| **Immutability / rollback** | Mutable Redis hash; failed build = frontend polls forever (no error path) | Immutable deployment per push, unique URL, alias pointer, instant rollback |
| **Queue durability** | `BRPOP` removes the ID *before* the build — worker crash mid-build silently loses the deployment; no ack/retry/DLQ | Managed queue (SQS, 2023) + deployment state machine (`QUEUED → ... → ERROR`) |
| **Queue semantics** | One global FIFO list | Concurrency queue + branch queue with skip-obsolete + priority classes |
| **CDN** | One Express process re-fetching S3 per request, no cache | 126 PoPs, cache tiers, ISR |
| **Dynamic compute** | Static files only (MIME ternary can't even represent images) | Functions on Lambda/Fluid, middleware, streaming |
| **Triggers** | Manual URL paste + 3s polling | Webhook-driven git integration + deploy hooks |
| **Artifact contract** | Implicit `dist/` convention | Build Output API (`config.json` v3, `static/`, `functions/*.func`) |

These gaps are the syllabus: each one is a deliberate Tier-A simplification you can
individually upgrade.

---

## 7. Comparable systems — the pattern across the industry

- **Heroku (the ancestor):** git pre-receive hook → buildpack → **slug** (≤1000MB
  compressed, 25-min cap) → release ledger → dynos "downloaded and expanded" the slug.
  Artifact-in-storage, pull-to-runtime
  ([how-heroku-works](https://devcenter.heroku.com/articles/how-heroku-works),
  [slug-compiler](https://devcenter.heroku.com/articles/slug-compiler)). Where slugs
  physically live (S3?) is **not** stated in the fetched pages — unverified.
- **Netlify:** content-addressed files, deploys as Merkle trees, atomic pointer-swap
  serving, per-hostname tree pointers
  ([engineering post](https://medium.com/netlify/how-netlifys-deploying-and-routing-infrastructure-works-c90adbde3b8d)).
- **Coolify (open-source, source-read):** each deployment is a Laravel queued job —
  `class ApplicationDeploymentJob implements ShouldQueue`
  ([source](https://github.com/coollabsio/coolify/blob/v4.x/app/Jobs/ApplicationDeploymentJob.php)),
  Horizon over Redis (`config/horizon.php`: `'connection' => 'redis'`), per-server
  concurrency limit via `ApplicationDeploymentQueue` — a production-grade version of the
  clone's Redis list, readable end to end.
- **CapRover:** wildcard DNS `*.something.mydomain.com` → nginx routes by Host header —
  the clone's serving pattern productized ([docs](https://caprover.com/docs/get-started.html)).
- **Dokploy:** Next.js + Postgres + Traefik ([architecture](https://docs.dokploy.com/docs/core/architecture)).
  **Contradiction, on record:** DeepWiki claims BullMQ/Redis; the fetched canary
  `package.json`s list no bullmq/ioredis/redis. Sided with the source files; Dokploy's
  current queue mechanism is an open question.
- **Firecracker folklore check:** the oft-quoted "150 microVMs/sec/host" appears in
  neither the spec nor the AWS announcement fetched this run — **unverified folklore**
  unless sourced to the NSDI'20 paper.

---

## 8. Tier honesty (house rule #2)

- **Tier A — the clone as taught:** one process per service, one Redis, one S3 bucket,
  static-only, unsandboxed builds. Fine to build first. *Breaks immediately at:* any
  malicious repo (arbitrary code with worker creds), any worker crash (lost job), any
  non-html/css asset (wrong MIME), any real traffic (every request hits S3).
- **Tier B — the credible portfolio version:** builds in containers (Docker; gVisor/
  Firecracker documented as the next step, not built), a durable queue with ack + retry +
  dead-letter (BullMQ or SQS semantics: visibility timeout instead of destructive BRPOP),
  a Postgres deployment table as the state machine (`QUEUED → BUILDING → READY/ERROR`),
  immutable deployment IDs + alias table for rollback, a proper MIME map, an LRU/CDN cache
  in front of S3, webhook-triggered deploys. *Breaks at C:* single-region, no anycast, no
  per-hostname cert automation at scale, no function runtime.
- **Tier C — real Vercel:** Hive (bare-metal KVM + Firecracker warm pools), SQS-class
  managed queues, globally replicated routing metadata, 126-PoP anycast edge, Lambda-based
  Fluid compute, per-hostname SNI certs from an encrypted store. Documented here; not a
  build target.

---

## 9. Contradictions surfaced (kept per non-negotiable #8)

1. **Promotion rebuild semantics** — "instant, no rebuild" vs "complete rebuild": both true,
   split by staged-production vs preview→production.
2. **SQS in 2026** — confirmed for 2023; the post-Hive queue technology is unnamed publicly.
3. **TLS termination location** — regions doc (region terminates TLS) vs infrastructure doc
   (edge TLS terminator). Adopted PoP=TCP/region=TLS; flagged.
4. **Pro concurrency "up to 12 slots"** — legacy per-slot purchase model in the 2023
   blog/KB; superseded by 3-default + on-demand-500 (docs 2026).
5. **Dokploy BullMQ** — DeepWiki vs current package.json; sided with source.
6. **Isolation "standard"** — Firecracker (AWS, Fly) *and* gVisor (Cloudflare) are both
   production answers; pick one with reasons.
7. **Hive hardware substrate** — "bare metal" per Vercel's post; whether those boxes are
   EC2 metal or Vercel-owned is not stated anywhere primary. Unverified either way.

## 10. Open questions

1. Where build artifacts persist at rest (the object store behind "uploads... to the CDN")
   — not publicly documented; likewise function-bundle staging into Lambda.
2. The control plane consuming the GitHub webhook and "select[ing] the appropriate hive
   cluster" is unnamed publicly.
3. Scope of `/v2/files` SHA1 dedup (per-team or global) — security-relevant if the clone
   copies content-addressing.
4. Edge-runtime substrate today (historically Cloudflare Workers; Fluid lists "Edge" as a
   runtime — consolidation onto Lambda is suggested but unverified).
5. Current per-concurrent-build price for on-demand builds (changelog notes a >50% cut;
   rate not on any fetched page).
6. Whether the 100xdevs cohort taught an extended version beyond the public repo (cohort
   note repos exist, unfetched).

---

*Full agent output (all 76 claims + 40 verification verdicts):
`tasks/woncsttg4.output` in the session scratchpad; per-track digests in
`scratchpad/digest-*.md`. Workflow run `wf_b76460e8-822`, resumable.*
