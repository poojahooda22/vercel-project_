# Vercel-Clone Skill Library — Plan (00)

> **Provenance.** The original `00-skills-plan.md` produced by the 10-agent research run on
> 2026-08-03 was lost from disk; this document is a re-derivation from the surviving memory
> summary plus a fresh source pass over `hkirat/vercel@29ac934524116b2587cbd71f8cb22d406ed849a7`,
> 2026-08-03. The repo was cloned locally this run and every file cited below was read at that
> commit (the repo's only commit, "Init" — the pinned sha IS HEAD). Citation shorthand in this
> doc: `@29ac934:file:line` means `hkirat/vercel@29ac934524116b2587cbd71f8cb22d406ed849a7`.

## The three questions

**What are we building?** A working Vercel-class deploy platform in TypeScript, starting from
the 100xdevs "Code along - Vercel" reference (`github.com/hkirat/vercel`): an upload service
that clones a GitHub repo and stages it in object storage, a queue-driven build worker, and a
subdomain request handler that serves the built output — then extended past the course toward
hosting many sites correctly (SPA deep links, real content types), a custom load balancer in
front, and honest scaling mechanics (rate limiting, sharding, isolation).

**What problem does it solve?** It answers, by building it, *why users pay Vercel*: git-push-to-
URL deployment (zero-ops DX), builds run for you, immutable deployments served from a global
edge, and traffic handling you never think about. The clone makes each of those purchasable
properties a mechanism you can point at in code.

**How?** Three Express 4 services + a Vite/React frontend (verified at the sha, tree listed this
run): `vercel-upload-service` (port 3000 — `@29ac934:vercel-upload-service/src/index.ts:51`),
`vercel-deploy-service` (queue worker, no port), `vercel-request-handler` (port 3001 —
`@29ac934:vercel-request-handler/src/index.ts:30`). Coordination via a Redis list
(`lPush`/`brPop` on `build-queue`) and a `status` hash; artifacts in Cloudflare R2 via the
aws-sdk v2 S3 API (`aws-sdk ^2.1553.0`, `redis ^4.6.13`, `express ^4.18.2`,
`simple-git ^3.22.0` — `@29ac934:vercel-upload-service/package.json`). The skill library below
is the knowledge layer; code starts only after a design doc per the research-first rule.

## Source-pass findings (the repo as it actually is)

The memory summary's architecture was **accurate at the box-and-arrow level**. The source pass
adds line-level truth the summary omitted — these findings drive the skill decomposition:

1. **Live R2 credentials are hardcoded and committed** in all three services
   (`@29ac934:vercel-upload-service/src/aws.ts:4-8`, `vercel-deploy-service/src/aws.ts:5-9`,
   `vercel-request-handler/src/index.ts:4-8`): access key id, secret, and the account-specific
   R2 endpoint, in a public repo.
2. **Uploads are fire-and-forget.** `files.forEach(async file => await uploadFile(...))`
   (`@29ac934:vercel-upload-service/src/index.ts:27-29`) awaits nothing at the caller; the
   literal `await new Promise((resolve) => setTimeout(resolve, 5000))` at `:31` is the race
   "fix" before enqueueing. Same pattern in the worker's `copyFinalDist`
   (`@29ac934:vercel-deploy-service/src/aws.ts:47-49`), which `main()` doesn't await either
   (`vercel-deploy-service/src/index.ts:23`) before writing status `deployed` (`:24`).
3. **Build failures still become "deployed".** `buildProject` resolves on `close` ignoring the
   exit code (`@29ac934:vercel-deploy-service/src/utils.ts:15-17`); no timeout, no resource
   limits, output dir hardcoded to `dist` (`vercel-deploy-service/src/aws.ts:45`).
4. **The status lifecycle has exactly two states** — `uploaded`
   (`@29ac934:vercel-upload-service/src/index.ts:35`) and `deployed`
   (`vercel-deploy-service/src/index.ts:24`). No `building`, no failure state; the frontend
   polls every 3 s for `deployed` only (`@29ac934:frontend/src/components/landing.tsx:46-52`).
5. **No SPA fallback — even `/` is broken.** The handler builds `Key: dist/${id}${filePath}`
   (`@29ac934:vercel-request-handler/src/index.ts:21`); the root path yields key `dist/{id}/`
   which matches no object. The frontend works around it by linking directly to `/index.html`
   (`@29ac934:frontend/src/components/landing.tsx:68,71`).
6. **Content-Type is a 3-way ternary** — html / css / else `application/javascript`
   (`@29ac934:vercel-request-handler/src/index.ts:24`): SVG, PNG, JSON, fonts all served as JS.
7. **A missing object crashes the handler.** `s3.getObject(...).promise()` rejection inside an
   `async` Express 4 route has no catch (`@29ac934:vercel-request-handler/src/index.ts:12-28`);
   Express 4 does not forward async rejections (expressjs.com/en/guide/error-handling.html),
   and Node ≥15 terminates on unhandled rejection by default
   (nodejs.org/api/process.html#event-unhandledrejection).
8. **`.git` is uploaded to the bucket.** `getAllFiles` recurses everything with no filter
   (`@29ac934:vercel-upload-service/src/file.ts:4-16`), so each clone's full `.git` object
   store lands in R2 and is re-downloaded by the worker.
9. **`listObjectsV2` is unpaginated** (`@29ac934:vercel-deploy-service/src/aws.ts:13-16`) —
   repos over 1,000 objects are silently truncated (the API's page cap;
   docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjectsV2-property).
10. **`repoUrl` is completely unvalidated** (`@29ac934:vercel-upload-service/src/index.ts:21-23`)
    — any protocol, any host, straight into `simpleGit().clone`.
11. **Queue semantics:** `lPush` + blocking `brPop` with
    `commandOptions({ isolated: true })` and a `// @ts-ignore` on the reply
    (`@29ac934:vercel-upload-service/src/index.ts:32`,
    `vercel-deploy-service/src/index.ts:13-19`). Push-left/pop-right is FIFO; delivery is
    at-most-once — a popped id is lost if the worker dies.
12. **Misnamed Redis clients** — `publisher`/`subscriber` in both services are plain clients;
    no pub/sub exists anywhere (`@29ac934:vercel-upload-service/src/index.ts:10-14`).
13. **Committed accidents:** nine mode-160000 gitlinks under `vercel-upload-service/output/`
    (test clones whose `.git` made them submodule refs, all pointing at `7c505f8`; verified via
    `git ls-tree` this run), and the deploy service declares npm packages `fs@^0.0.1-security`
    and `path@^0.12.7` — userland shims of Node builtins
    (`@29ac934:vercel-deploy-service/package.json`).
14. **Ids:** 5 chars from a 35-char alphabet (`@29ac934:vercel-upload-service/src/utils.ts:1-10`)
    — a 52.5M keyspace (35^5; first-principles math), no collision check on generation.
15. **Frontend detail:** hardcodes `http://localhost:3000` and two *different* result domains
    (`dev.100xdevs.com:3001` and `10kdevs.com` —
    `@29ac934:frontend/src/components/landing.tsx:12,68,71`).

None of these are problems to fix in the reference — they are the curriculum. Each one anchors
a skill section below.

## The tier ladder

| Tier | What it is | What breaks moving up |
|---|---|---|
| **A** | The single-process course clone: one box, one local Redis, one R2 bucket, demo traffic, trusted operator | Everything in the findings list: RCE on the host, at-most-once queue, two-state status, no SPA fallback, unpaginated list, secrets in source |
| **B** | A real small product: auth, validated inputs, container-isolated builds with limits, reliable queue (BLMOVE/streams), SDK v3 + presigned URLs, full MIME map + SPA fallback, CDN, wildcard TLS, thousands of sites | Single-region ceiling; one Redis; build farm scheduling; per-tenant isolation economics |
| **C** | Actual Vercel scale: microVM build farm, global anycast edge, immutable-deployment CDN semantics, millions of deployments | Out of scope — documented in `arch-vercel-system-design`, never claimed |

Every skill states, per mechanism, which tier it describes and what breaks at the next. Building
Tier A is fine; describing Tier A as Tier C is the failure mode.

## The skill table (13 skills)

| Skill | Family | One-line | Primary sources |
|---|---|---|---|
| `svc-upload-service` | svc | The ingest service: repoUrl → clone → id → upload to R2 → enqueue → status; the await/fire-and-forget truth of every step | `@29ac934:vercel-upload-service/src/index.ts`, `src/file.ts`; expressjs.com/en/guide/error-handling.html |
| `svc-deploy-service` | svc | The build worker: brPop loop, download, build, upload output, status write — and its crash/loss model | `@29ac934:vercel-deploy-service/src/index.ts`, `src/utils.ts`; github.com/redis/node-redis/blob/master/docs/isolated-execution.md |
| `svc-request-handler` | svc | Subdomain → object key → content-type → serve; SPA deep-link fallback done right | `@29ac934:vercel-request-handler/src/index.ts`; expressjs.com/en/4x/api.html#req.hostname; developer.mozilla.org/en-US/docs/Web/HTTP/MIME_types |
| `infra-redis-queue` | infra | Redis lists as queues (lPush/brPop FIFO, at-most-once), the status hash; Tier B: BLMOVE reliable queue, streams + consumer groups | redis.io/docs/latest/commands/brpop/; redis.io/docs/latest/commands/blmove/; redis.io/docs/latest/develop/data-types/streams/ |
| `infra-object-storage-r2` | infra | aws-sdk v2 S3 API against R2: put/get/list, pagination, streaming vs buffering, key layout as schema; Tier B: SDK v3, presigned uploads | docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html; developers.cloudflare.com/r2/api/s3/api/; `@29ac934:*/src/aws.ts` |
| `infra-git-clone` | infra | simple-git clone mechanics: depth, cleanup, `.git` exclusion, private repos, the unvalidated-URL trust boundary | github.com/steveukx/git (README); git-scm.com/docs/git-clone; `@29ac934:vercel-upload-service/src/index.ts:23` |
| `infra-build-execution` | infra | `npm install && npm run build` on user repos = RCE by design; exit codes, timeouts, limits; Tier B: containers/microVMs | nodejs.org/api/child_process.html; github.com/firecracker-microvm/firecracker/blob/main/docs/design.md; vercel.com/docs/builds/build-image; `@29ac934:vercel-deploy-service/src/utils.ts` |
| `arch-vercel-system-design` | arch | How real Vercel works and why users pay: immutable deployments, build pipeline/output API, edge network, previews | vercel.com/docs/deployments; vercel.com/docs/edge-network; vercel.com/docs/build-output-api/v3 |
| `arch-subdomain-routing` | arch | Wildcard DNS → Host header → id; multi-tenant TLS for `*.domain`; local wildcard testing; proxy headers | expressjs.com/en/4x/api.html#req.hostname; letsencrypt.org/docs/challenge-types/; `@29ac934:vercel-request-handler/src/index.ts:14-16` |
| `arch-deployment-model` | arch | Deployment ids (collision math), the status state machine, idempotency, retries, immutability | `@29ac934:vercel-upload-service/src/utils.ts`; vercel.com/docs/deployments (immutability); first-principles math (labeled) |
| `arch-scale-and-loadbalancing` | arch | BRIDGE: where an LB sits in this clone, what makes each service LB-able, rate limiting the build path — pointers into the load-balancer library, zero duplication | `E:/Development/Portfolio-phase2/custom-load-balancer/.claude/skills/lb-algorithms/SKILL.md`; `.../layer-l7-routing/SKILL.md`; `.../lb-resilience-health/SKILL.md` |
| `arch-security-threat-model` | arch | The deploy-platform threat model: committed secrets, RCE build path, SSRF via repoUrl, shared-bucket tenancy — boundaries and Tier B fixes | `@29ac934:vercel-upload-service/src/aws.ts:4-8`; developers.cloudflare.com/r2/api/tokens/; owasp.org/www-community/attacks/Server_Side_Request_Forgery |
| `engine-hkirat-vercel` | engine | The reference-repo digest: file-by-file at the sha, all 15 source-pass findings, keep-vs-replace verdicts for the extension | all files at `hkirat/vercel@29ac934...` (cloned and read); `@29ac934:frontend/src/components/landing.tsx` |

Family counts: svc ×3, infra ×4, arch ×5, engine ×1. No name collides with the 32 existing
search-engine skills in this repo or the 27 load-balancer skills in the sibling library.

### Notes on decomposition decisions

- **Added `arch-security-threat-model`** (13th skill) beyond the starting decomposition: the
  source pass surfaced four distinct security findings (committed live creds ×3 services, RCE
  build, unvalidated repoUrl, `.git`/shared-bucket exposure) that cut across services —
  security-honesty house rule 4 earns a cross-cutting home, while `infra-build-execution` still
  owns the RCE mechanics in depth.
- **No frontend skill.** The Vite/React landing page is thin (one component, axios POST + 3 s
  poll); it is digested inside `engine-hkirat-vercel`, not promoted to a skill.
- **`engine-hkirat-vercel` honesty note:** the course *video* is not verifiable from here; the
  digest treats the code at the sha as the single source of truth and compares against the
  summarized course architecture, labeling any video claim `(unverified)`.

## Not building / not duplicating

- **Load-balancer content is NEVER duplicated.** Every LB algorithm, L4/L7 mechanism, health
  check, and sharding question is answered by pointer into
  `E:/Development/Portfolio-phase2/custom-load-balancer/.claude/skills/` (27 skills:
  `algo-*` ×6, `ds-*` ×5, `layer-*` ×4, `lb-*` ×2, `paper-*` ×6, `scale-data-structures`,
  `sharding-*` ×3). `arch-scale-and-loadbalancing` is a routing table, not a textbook.
- **No premature scaffolding** (house non-negotiable #5): no config systems, no plugin loaders,
  no service frameworks before a design doc demands them. The skills are knowledge; the design
  doc that follows them decides what gets built.
- **Not building Tier C.** MicroVM farms, anycast edge, and millions of deployments are
  documented in `arch-vercel-system-design` as the reference ceiling, never claimed as ours.
- **Not replacing the search-engine library.** The 32 existing skills in this repo's
  `.claude/skills/` are a separate domain; the CLAUDE.md router gains a new section for these
  13 without touching the existing routes.
- **Not shipping the reference repo's secrets anywhere.** The committed R2 credentials at the
  sha are treated as a case study; no skill or doc reproduces them as usable values beyond the
  citation.

## What happens next (research-first order)

1. Author the 13 skills (format per `research-methodology`: frontmatter name+description with
   trigger terms, Domain identity, cited body, Non-Negotiables, Anti-Patterns, Output Contract;
   every mechanism tiered A/B/C).
2. Extend `CLAUDE.md` routing with the new families.
3. Write the build design doc (scope: which findings get fixed at which tier) — only then code.
