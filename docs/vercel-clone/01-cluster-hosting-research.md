# Research Findings — Hosting the 5-Service Clone on a Cluster (Kubernetes, DigitalOcean, and the Build-Isolation Wall)

> **Provenance.** 12-agent deep-research workflow (6 research tracks, each attacked by an independent
> adversarial fact-checker) run **2026-08-10**. 1,844,801 tokens, 813 tool calls, 0 agent errors.
> 207 findings, 198 distinct searches, 6–10 source categories per track.
> **Verifier outcome: 120 CONFIRMED, 30 OVERSTATED, 2 REFUTED, 3 UNVERIFIABLE.** The refuted and
> downgraded claims are recorded in §12 rather than deleted — the corrections are findings too.
>
> **Scope.** This is the *cluster/hosting* layer. It deliberately does not re-derive Vercel's
> upload→build→serve pipeline, which is already covered in
> [`00-architecture-research.md`](00-architecture-research.md) (Hive, Build Output API, edge serving).
> Where this doc touches those, it cites that doc.
>
> Prices and product states are **as fetched 2026-08-10**. They drift. Re-fetch before quoting.

---

## 0. Plain-language summary (read this first)

**What we're doing.** Moving five programs off one laptop onto a rented farm of computers that
restarts them when they die and adds more when they're busy. That farm is a **Kubernetes cluster**.

**Why it isn't just "put it on a server".** Two of the five services are websites that need a stable
public address. Two are background workers with no address at all. And one — the build service —
runs *strangers' code on purpose*. Those three things want three different kinds of machine, and
mixing them is how platforms get breached.

**The one idea worth taking away.** A **node pool** is a group of identical machines you manage as a
unit. You want at least two: one for the normal services, and a separate one for the build worker,
because the build worker executes untrusted code and everything else holds live cloud credentials.

**The honest bad news.** A separate node pool *reduces* the damage but is **not a security wall** —
Google says so in the documentation for that exact pattern. Real walls need a sandboxed runtime
(gVisor) or a microVM (Firecracker). **DigitalOcean's managed Kubernetes cannot install either.**
That is the central finding of this research, and it means the plan has to be honest about what it
is: a good home for four services, and a *deliberately accepted risk* (or an off-cluster build) for
the fifth.

**The second surprise.** The nginx ingress controller that every tutorial — and the slide that
prompted this — tells you to install was **retired in March 2026**. Today is August 2026. It gets no
more security patches. The replacement is **Gateway API**, which DigitalOcean already enables by
default.

---

## 1. What / Problem / How

**What are we building?** A production home for the five services in this repo — `vercel-frontend`,
`vercel-upload-service`, `vercel-deploy-service`, `vercel-request-handler`, `vercel-screenshot-service`
— such that every deployment is reachable at `{id}.ourdomain.com` over HTTPS, builds scale with queue
depth, and one hostile user repo cannot take the platform's credentials.

**What problem does it solve?** Today all five run on one machine against `localhost` Redis. There is
no restart-on-crash, no horizontal scale, no TLS, no wildcard DNS, and no boundary at all between the
process that runs `npm install` on a stranger's repo and the process holding the R2 keys.

**How?** DOKS (DigitalOcean Kubernetes) with two node pools, Gateway API via Cilium for wildcard
host routing, cert-manager DNS-01 for the `*.domain` certificate, KEDA **ScaledJob** for builds, and
managed Valkey for the queue — with the build-isolation gap named explicitly and one of three
mitigations chosen consciously (§8).

---

## 2. The jargon on the slide, in dependency order

The slide's numbering was scrambled (Pods appear as both #3 and #5). The real dependency order:

| Term | Plain meaning | Why it exists |
|---|---|---|
| **Cluster / Node** | The farm, and one machine in it (on DO, a Droplet) | You describe desired state; the control plane places work on nodes |
| **Image / Container** | A frozen filesystem (OS + Node + your JS); a running copy of it | Build once, run identically anywhere |
| **Pod** | Smallest schedulable unit — normally one container | K8s never schedules a bare container; pods share a network namespace |
| **Manifest** | YAML describing desired state, `kubectl apply`-ed | Declarative — a control loop drags reality toward it, continuously |
| **ReplicaSet** | "Keep exactly N pods alive" | Replaces a pod when a node dies |
| **Deployment** | ReplicaSet + rolling updates + rollback history | **This is what you write.** You almost never hand-write a ReplicaSet |
| **Service** | Stable virtual IP + DNS name in front of changing pods | Pods die and change IP constantly; you can never address one directly |
| **Ingress** | A routing rule (`host X → service Z`). Inert data | Declares external routing |
| **Ingress controller** | The proxy process that reads those rules and reprograms itself | **Ingress without a controller has no effect** — stated verbatim in the docs |

Two precise details worth memorising, both load-bearing here:

- **Service DNS format** is `<service>.<namespace>.svc.cluster.local`. Because kubelet writes a search
  path into each pod's `/etc/resolv.conf`, a pod in the same namespace can just say `redis`.
  ([kubernetes.io — DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/))
- **Ingress wildcard hosts match exactly one DNS label.** `*.foo.com` matches `bar.foo.com`, does
  **not** match `baz.bar.foo.com`, and does **not** match the bare apex `foo.com`.
  ([kubernetes.io — Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/))

### 2.1 Node pools — the term you asked about

**A node pool is not a core Kubernetes concept.** There is no `NodePool` kind, and no pool-shaped entry
in the official well-known-labels registry. It is a *managed-Kubernetes* abstraction (DOKS, GKE, EKS):
a group of nodes with identical configuration, scaled and upgraded as a unit.
([DO — About node pools](https://docs.digitalocean.com/products/kubernetes/how-to/add-node-pools/):
"A node pool is a group of nodes in a DOKS cluster with the same configuration… This lets you have
different services on different node pools.")

**The exact label you write in a manifest on DigitalOcean is `doks.digitalocean.com/node-pool`, whose
value is the pool name.** DO applies four labels (`node-pool`, `node-id`, `node-pool-id`, `version`)
and its reconciler enforces them, so you cannot remove or repurpose them. (GKE's equivalent is
`cloud.google.com/gke-nodepool`; EKS uses `eks.amazonaws.com`-prefixed labels.)

**Three escalating mechanisms pin work to a pool, and they answer different questions:**

| Mechanism | Direction | Use when |
|---|---|---|
| `nodeSelector` | Pod → node (attract), exact label match | Simple pinning |
| `nodeAffinity` | Pod → node, `required…` (hard) or `preferred…` (soft) | Expressive pinning |
| **Taint + toleration** | Node → pod (**repel**) | **You want to keep everything else OUT** |

For the build pool you need **both**: a taint so nothing else lands there, and a toleration plus
nodeSelector on the build workload so it lands only there. DOKS supports both at provisioning time —
`doctl kubernetes cluster node-pool create` accepts repeatable `--taint key=value:effect` and
`--label`, plus `--auto-scale --min-nodes --max-nodes`.

---

## 3. How Vercel actually does it — including the Kubernetes question

The question "does Vercel run on Kubernetes?" has a precise, sourced answer, and it is **not** the one
either camp assumes.

1. **Vercel runs primarily on AWS. Officially stated, not inferred.**
   [vercel.com/docs/security/compliance](https://vercel.com/docs/security/compliance): "The Vercel CDN
   and deployment platform primarily uses Amazon Web Services (AWS), and currently has 20 different
   regions and an Anycast network with global IP addresses."
2. **Those 20 regions are AWS regions 1:1** — the docs print the AWS name in the table
   (`iad1` = `us-east-1`, `fra1` = `eu-central-1`, `bom1` = `ap-south-1`).
   ([vercel.com/docs/regions](https://vercel.com/docs/regions))
3. **Yes — but only the control plane.** The single current first-party confirmation is Vercel's own
   incident write-up: "The unavailability of the feature flag provider caused an exhaustion of
   resources in our primary Kubernetes cluster." That cluster is "used by Vercel's dashboard, CLI, API,
   and services such as log forwarding" and is "an entirely independent system of Vercel's serving
   stack."
   ([Oct 20 2025 service disruption](https://vercel.com/blog/update-regarding-vercel-service-disruption-on-october-20-2025))
4. **A 2023 post did put the serving path in Kubernetes — and Vercel has since stamped it historical.**
   [behind-the-scenes-of-vercels-infrastructure](https://vercel.com/blog/behind-the-scenes-of-vercels-infrastructure)
   says "This is where the request enters Vercel's Kubernetes cluster," but now carries: "This post is
   historical. Product names and infrastructure details may have changed." **Do not cite it as current.**
5. **Builds do not run on Kubernetes at all.** They run in Firecracker microVMs on Vercel's own
   bare-metal platform, "Hive" — one Firecracker process per cell, destroyed after the build. Vercel
   states it processes **over 2.7 million deployments per day**.
   ([Vercel Sandbox GA](https://vercel.com/blog/vercel-sandbox-is-now-generally-available); mechanism
   detail already in [`00-architecture-research.md` §4.3](00-architecture-research.md))
6. **Vercel publishes the reasoning we need.** Their sandbox concepts page states container escapes are
   possible and containers are suitable only for trusted code; microVM isolation is strong enough that
   they permit *privileged* operations inside the sandbox (Docker, sudo, FUSE) because the microVM —
   not the container — is the boundary being defended.
   ([vercel.com/docs/sandbox/concepts](https://vercel.com/docs/sandbox/concepts))

**So the honest summary for you:** Kubernetes runs Vercel's *dashboard*. Firecracker microVMs run
customers' *builds*. Anycast + CDN serve the *sites*. Cloning the first is easy; the second is the part
this project cannot cheaply reproduce.

---

## 4. How Lovable and the AI builders do it

The user-facing question was "Lovable gives a sandbox too — how?" The honest answer is that **Lovable
has published nothing about its sandbox architecture in its own words** — no engineering post, no
incident report, no talk. Everything public is a vendor case study or a job ad. That absence is the
finding; it is recorded in §13 as an open question rather than filled with a guess.

What *is* well-sourced is the shape of the whole category:

| Product | Isolation primitive | Source |
|---|---|---|
| **Vercel Sandbox / Hive** | Firecracker microVM, dedicated kernel per sandbox | [vercel.com/docs/sandbox/concepts](https://vercel.com/docs/sandbox/concepts) |
| **E2B** | Firecracker; `https://<port>-<sandboxID>.<domain>` proxy routing | [e2b-dev/infra ARCHITECTURE.md](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md) |
| **Fly.io** | Firecracker; 2026 "Sprites" are persistent microVMs for AI code | [fly.io/blog/sandboxing-and-workload-isolation](https://fly.io/blog/sandboxing-and-workload-isolation/) |
| **Cloudflare Pages** | gVisor-sandboxed containers | [blog.cloudflare.com/cloudflare-pages-build-improvements](https://blog.cloudflare.com/cloudflare-pages-build-improvements/) |
| **Modal** | gVisor; plus network-level default-deny | [modal.com/docs/guide/sandbox-networking](https://modal.com/docs/guide/sandbox-networking) |
| **StackBlitz** | WebContainers — runs in the *browser's* WASM sandbox, no server-side untrusted code at all | [blog.stackblitz.com/posts/introducing-webcontainers](https://blog.stackblitz.com/posts/introducing-webcontainers/) |

**E2B's routing is worth noting**: their client-proxy terminates `<port>-<sandboxID>.<domain>` and
routes to the right node — the production-grade version of the `hostname.split(".")[0]` in
[vercel-request-handler/src/index.ts:64](../../vercel-request-handler/src/index.ts). The pattern you
independently arrived at is the right one.

**Nobody in this category is using plain Docker/runc for untrusted code.** That is the convergence.

---

## 5. Two findings that overturn the default plan

### 5.1 ingress-nginx is retired — do not install it

> "In March 2026, Ingress NGINX maintenance will be halted, and the project will be retired… After that
> time, there will be no further releases, no bugfixes, and no updates to resolve any security
> vulnerabilities that may be discovered."
> — [kubernetes.dev — Ingress NGINX Retirement](https://www.kubernetes.dev/blog/2025/11/12/ingress-nginx-retirement/)

Today is 2026-08-10. Installing it means putting **unpatched, EOL, internet-facing** infrastructure in
front of every tenant site. The Ingress API itself is also frozen:

> "The Kubernetes project recommends using Gateway instead of Ingress. The Ingress API has been frozen."
> — [kubernetes.io — Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)

**On DOKS the replacement path is already paved:** DOKS ships **Cilium** as its CNI, and Gateway API is
**enabled by default** on VPC-native clusters running Kubernetes 1.33+, with `gatewayClassName: cilium`.
No third-party controller to install.

⚠️ **Named risk:** Cilium's Gateway API implementation has open bugs in *exactly* the wildcard-hostname
behaviour this system depends on ([cilium#44118](https://github.com/cilium/cilium/issues/44118) — a
wildcard listener plus a concrete HTTPRoute hostname is Accepted but never translated into Envoy config,
yielding 404). **This must be smoke-tested on a real cluster before committing.** Conformant
alternatives exist if it bites: Traefik, NGINX Gateway Fabric, kgateway, Istio, HAProxy
([Gateway API implementations](https://gateway-api.sigs.k8s.io/implementations/)).

### 5.2 The wildcard semantics change between Ingress and Gateway API

This is subtle and it directly affects `hostname.split(".")[0]`:

| API | `*.example.com` matches | Apex? |
|---|---|---|
| **Ingress** | exactly one label — `test.example.com` only | No |
| **Gateway API** | **suffix match, one or more labels** — `test.example.com` *and* `foo.test.example.com` | No |

> "Hostnames that are prefixed with a wildcard label (`*.`) are interpreted as a suffix match… `*.example.com`
> would match both `test.example.com`, and `foo.test.example.com`, but not `example.com`."
> — [gateway-api httproute_types.go](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go)

**The gap this opens:** a wildcard TLS certificate for `*.example.com` covers **one label only** under
RFC 6125 §6.4.3 ("`*.example.com` would match `foo.example.com` but not `bar.foo.example.com`").
So under Gateway API, `a.b.example.com` is **routed** by the gateway but **fails certificate validation**
in the browser — the routing layer is wider than the crypto layer. Additionally `split(".")[0]` would
yield `a`, not the deployment id.

**Mitigation:** keep deployment ids to a single flat label (which is what
[`generate()`](../../vercel-upload-service/src/utils.ts) already produces), and validate the extracted
id server-side rather than trusting the label — see §7.

---

## 6. Your five services → Kubernetes objects

| Service | Workload kind | Service? | Route? | Node pool |
|---|---|---|---|---|
| `vercel-frontend` | Deployment | ClusterIP | `app.domain` | general |
| `vercel-upload-service` :3000 | Deployment | ClusterIP | `api.domain` | general |
| `vercel-request-handler` :3001 | Deployment | ClusterIP | **`*.domain`** | general |
| `vercel-deploy-service` | **ScaledJob** (§9) | **none** | **none** | **build (tainted)** |
| `vercel-screenshot-service` | Deployment | **none** | **none** | general (memory-sized) |
| Redis | — | **managed Valkey, not in-cluster** | — | — |
| Postgres | — | already Neon (external) | — | — |

The two workers get **no Service and no route** — they have no listening port. Nothing can connect *to*
them; they pull from Redis. This is why they are invisible to a load balancer, and why scaling them is a
queue problem, not an LB problem.

**One Service of type `LoadBalancer` provisions one DigitalOcean Load Balancer**, billed at
$12.00/month/node (regional HTTP) or $15.00/month/node (network). Putting three HTTP services behind a
*single* gateway rather than giving each its own LB saves $24/month. (The research originally claimed
$48 by counting all five services; the verifier correctly noted the two workers can never have a
LoadBalancer Service at all. Corrected here.)

---

## 7. The wildcard routing chain, and the Host-header trust contract

**The chain:** DO DNS wildcard `A` record (`*` → LB IP) → DO Load Balancer → Gateway/ingress in-cluster
→ Service → request-handler pod, which reads `req.hostname`.

**Good news on the LB layer.** On DOKS **1.33.1-do.0 and later the default service load balancer is
`REGIONAL_NETWORK`** — a layer-4 network LB. An L4 LB forwards bytes without rewriting HTTP, so the
client `Host` header arrives untouched and TLS terminates in-cluster. That is exactly the right default
for this system. ([DO — configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/))

**Wildcard TLS requires DNS-01.** Let's Encrypt: HTTP-01 "cannot be used to issue wildcard certificates";
DNS-01 is "the only challenge type that lets you issue wildcard certificates."
([letsencrypt.org — Challenge Types](https://letsencrypt.org/docs/challenge-types/)). cert-manager's
DigitalOcean solver needs only a write-scoped DO Personal Access Token in a Secret, referenced via
`spec.acme.solvers[].dns01.digitalocean.tokenSecretRef`. Three independent PaaS vendors (Railway, Render,
App Platform) all require the same ACME/TXT delegation — strong cross-vendor corroboration.

### 7.1 The security contract — the part that matters most

**ingress-nginx preserves the original `Host` by default** (`proxy_set_header Host $best_http_host` in
its [nginx.tmpl](https://github.com/kubernetes/ingress-nginx/blob/main/rootfs/etc/nginx/template/nginx.tmpl))
**and also injects `X-Forwarded-Host`.** Gateway API makes preservation a normative MUST. Either way,
a second, *client-spoofable* copy of the hostname now travels alongside the real one.

**The exact attack chain against this codebase:**

> "req.hostname … Contains the hostname derived from the Host HTTP header. When the trust proxy setting
> does not evaluate to false, this property will instead get the value from the X-Forwarded-Host header
> field. **This header can be set by the client or by the proxy.**"
> — [expressjs.com 5.x API — req.hostname](https://expressjs.com/en/5x/api/request/)

[vercel-request-handler/src/index.ts](../../vercel-request-handler/src/index.ts) does **not** set
`trust proxy`, so Express's default (`false`) applies and it is **safe today**. But the completely
routine change "we need real client IPs behind the load balancer" — which is what `trust proxy` is
*for* — silently hands tenant selection to an attacker-supplied header. `curl -H 'X-Forwarded-Host:
victimid.domain.com'` would then serve another tenant's site.

**Vercel's own multi-tenant documentation prescribes the fix**, and it is two things this codebase does
not yet do:

> "Tenant headers must come from the proxy, never from the client. Any caller can attach an `x-tenant-id`
> header to a request, and if the proxy forwards that value untouched, your app trusts it and serves data
> for whichever tenant the caller picked."
> — [Vercel — multi-tenant middleware and routing](https://vercel.com/docs/platforms/multi-tenant-platforms/middleware-and-routing)

1. **Validate** the extracted id against the datastore before serving (you already have a `deployments`
   table — a lookup turns a guessed label into a 404).
2. **Strip** inbound `X-Forwarded-Host` at the gateway so a client copy can never reach the app.

OWASP's Host-header-injection guidance converges on the same allowlist-plus-refuse pattern.

### 7.2 One wildcard route, never one route per deployment

Materialising routing per deployment makes deploy latency a function of total deployment count — with
ingress-nginx, config reloads have been reported exceeding 8 seconds with stale-endpoint 5xx windows
([ingress-nginx#3901](https://github.com/kubernetes/ingress-nginx/issues/3901)). **One wildcard rule for
all tenants**; the id is resolved in the application, not in the proxy config. Your current design
already does this correctly.

---

## 8. The build worker — the actual wall

This is the section that changes the plan.

### 8.1 The threat is real and current

[vercel-deploy-service/src/utils.ts:8](../../vercel-deploy-service/src/utils.ts) runs
`npm install && npm run build` on an arbitrary cloned repo. `npm install` executes lifecycle scripts
from the repo *and every transitive dependency* — GitHub calls install-time lifecycle scripts the
"single largest code-execution surface in the npm ecosystem," and npm v12 (July 2026) disables them by
default. The **Shai-Hulud** worm campaigns weaponised exactly this to harvest cloud credentials from
build servers with no human interaction
([Unit 42](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/)). **The RCE exists at install
time, before `npm run build` is ever reached.**

### 8.2 Containers are not a boundary — four vendors on the record

- **Google:** containers were explicitly not designed as a strong security boundary
  ([GCP blog](https://cloud.google.com/blog/products/gcp/exploring-container-security-isolation-at-different-layers-of-the-kubernetes-stack/)).
- **Kubernetes itself:** containers are a weaker isolation boundary than VMs; sandboxing is recommended
  for untrusted code ([multi-tenancy docs](https://kubernetes.io/docs/concepts/security/multi-tenancy/)).
- **AWS:** its post-mortem of the runc escape CVE-2019-5736 concludes the durable mitigation is to treat
  the Linux kernel as single-tenant and put a hypervisor between tenants
  ([AWS blog](https://aws.amazon.com/blogs/compute/anatomy-of-cve-2019-5736-a-runc-container-escape/)).
- **Vercel & Cloudflare** ship Firecracker and gVisor respectively for precisely this workload.

Escapes are not historical: **CVE-2024-21626** ("Leaky Vessels", CVSS 8.6, runc ≤1.1.11, patched
1.1.12 on 31 Jan 2024) breaks out via a leaked host file descriptor at build *or* run time
([runc advisory GHSA-xr7r-f8xq-vfvv](https://github.com/opencontainers/runc/security/advisories/GHSA-xr7r-f8xq-vfvv)).
Kernel bugs alone suffice too — CVE-2022-0492 (cgroups v1 `release_agent`) and CVE-2022-0847 (Dirty Pipe).

### 8.3 Node pools bound blast radius — they are NOT the boundary

This is the correction to the intuitive answer. Google documents node-pool isolation as
defence-in-depth that **must never be the primary security boundary**
([GKE — isolate workloads on dedicated nodes](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/isolate-workloads-dedicated-nodes)).
Notably, GKE Sandbox *mandates* pool separation — you cannot enable it on the default pool — which
confirms the pattern's shape while showing the pool is the *packaging*, not the wall.

### 8.4 The DOKS blocker

> DOKS explicitly manages the container daemon configuration on worker nodes and overwrites node-level
> changes via its reconciler.
> — [DO — DOKS managed components](https://docs.digitalocean.com/products/kubernetes/details/managed/)

Installing gVisor (`runsc`) or Kata and registering a `RuntimeClass` handler in containerd is therefore
**not a supported operation on DOKS managed node pools.** DO's public feature-request board carries an
**open, unshipped** request for gVisor support (filed 2025-10-24). The submitter reports they *did*
install gVisor manually via a privileged DaemonSet — so the accurate statement is **"not officially
supported and breaks on node replacement or upgrade,"** not "impossible." *(Verifier note: this rests on
a single 3-vote user post plus the managed-components doc; the negative-capability claim is medium
confidence, the reconciler behaviour is high.)*

### 8.5 The three honest options

| Option | What it is | Trade-off |
|---|---|---|
| **A — Accept, and say so** | Tainted build pool + PSS Restricted + no credentials + NetworkPolicy + Job-per-build | Cheapest, fastest. **Single-tenant-trust only.** Must be written down, not assumed |
| **B — Build off-cluster** | Cluster runs the 4 trusted services; builds go to Vercel Sandbox / E2B / Fly Machines | Real microVM isolation, no infra to run. Per-build cost, external dependency |
| **C — Own the nodes** | Self-managed k3s on plain Droplets where you control containerd → gVisor/Kata RuntimeClass | Full control. You now operate a cluster; DOKS's whole value is gone |

**Recommendation: A now, with B as the designed escape hatch** — but only if the platform is
single-tenant (you deploy your own repos) or invite-only. **The moment a stranger can POST a
`repoUrl`, A is not defensible** and B becomes mandatory. Option B is also the least work of the three
to adopt later *if* the build step is kept behind a narrow interface today.

### 8.6 Hardening that applies under every option

- **Job per build, not a long-lived worker.** `spec.activeDeadlineSeconds` gives a hard wall-clock kill
  and takes precedence over `backoffLimit`; `ttlSecondsAfterFinished` garbage-collects finished Jobs
  ([kubernetes.io — Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/)). This is the
  documented Kubernetes-native CI shape (Tekton = Pod per Task; GitHub ARC = fresh runner pod per job).
- **PSS Restricted:** `allowPrivilegeEscalation: false` (maps to the kernel `no_new_privs` flag),
  `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`,
  `seccompProfile.type: RuntimeDefault`, `hostNetwork/hostPID/hostIPC: false`.
- **`automountServiceAccountToken: false`** — otherwise the mounted token is a lateral-movement primitive
  into the cluster and, via IAM bindings, the cloud account.
- **Block the metadata endpoint.** DigitalOcean's Droplet metadata service is at the unauthenticated
  link-local `169.254.169.254` and exposes user-data, SSH keys, tags and region
  ([DO docs](https://docs.digitalocean.com/products/droplets/how-to/access-metadata/)). Use a
  NetworkPolicy `ipBlock.cidr` with an `except` list. ⚠️ **Verify empirically** — 
  [kubernetes#68078](https://github.com/kubernetes/kubernetes/issues/68078) reports `except` failing to
  block the metadata IP in practice and is still unresolved. `curl 169.254.169.254` from inside a build
  pod is the only acceptable proof.
- **Zero ambient credentials in the build pod.** Today the process that runs `npm install` has the R2
  keys in its environment. The build should write to a local path and the *orchestrator* uploads — or the
  build receives a short-TTL presigned URL scoped to `dist/{id}/` only. *(The research flagged that no
  public source discusses this artifact-egress boundary — it is an unaddressed gap in the literature,
  §13.)*

---

## 9. Queue scaling — and a bug in the current worker

### 9.1 BRPOP across N replicas is correct by construction

> "If multiple clients are blocked for the same key, the first client to be served is the one that has
> been waiting the longest."
> — [redis.io — BLPOP](https://redis.io/docs/latest/commands/blpop/)

Each element goes to exactly one client. Competing consumers needs no locking. **Scaling builds = more
replicas, zero code change.**

### 9.2 But BRPOP loses jobs, by documented design

> "When BLPOP returns an element to the client, it also removes the element from the list… if the client
> crashes while processing the returned element, **it is lost forever**."

The documented fix is the processing-list pattern: pop-and-push atomically, `LREM` on success, and a
monitor that returns timed-out items. **`RPOPLPUSH`/`BRPOPLPUSH` are deprecated as of Redis 6.2.0** —
use `LMOVE`/`BLMOVE`; `BLMOVE RIGHT LEFT` is the exact equivalent.

### 9.3 The concrete bug this creates today

[vercel-deploy-service/src/index.ts](../../vercel-deploy-service/src/index.ts) registers **no SIGTERM
handler** and runs an unbounded `while (1)`. Kubernetes' documented termination sequence: preStop hook →
**SIGTERM to PID 1** → endpoint removal *in parallel* → SIGKILL when the grace period expires
(**default `terminationGracePeriodSeconds: 30`**).

So on any node drain, rolling update, or scale-in: SIGTERM is ignored, SIGKILL lands 30 s later, and any
build longer than 30 seconds dies. Because `brPop` already removed the id and `claimDeployment` already
moved the row to `building`, **the deployment is orphaned in a non-terminal state with no id in any queue
to retry from.** DOKS surge upgrades make this routine — eviction timeout is 15 minutes, drain timeout
30 minutes, and DO warns workloads "may experience downtime."

By contrast [vercel-screenshot-service/src/index.ts:51-58](../../vercel-screenshot-service/src/index.ts)
*does* handle SIGINT/SIGTERM. The deploy service needs the same, plus a reaper for rows stuck in
`building`.

### 9.4 Use KEDA **ScaledJob**, not ScaledObject — the decisive finding

> "Imagine a deployment triggers on a RabbitMQ queue message. Each message takes 3 hours to process… Now
> the HPA makes a decision to scale down… **there is no way to control which replica is terminated.**"
> — [KEDA — scaling deployments](https://keda.sh/docs/latest/concepts/scaling-deployments/)

A `ScaledObject` on the build worker would **destroy in-flight builds on every scale-in**. KEDA's own
documented answer is **`ScaledJob`**: one Kubernetes Job per queue event, never terminated by scale-down.
This composes exactly with §8.6's Job-per-build hardening — the same mechanism solves isolation *and*
scale-in safety.

The Redis Lists trigger shape:

```yaml
triggers:
- type: redis
  metadata:
    address: <host>:<port>
    passwordFromEnv: REDIS_PASSWORD
    listName: build-queue
    listLength: "5"          # AVERAGE TARGET PER REPLICA
    activationListLength: "0"
```

⚠️ **`listLength` is a per-replica average, not a threshold.** KEDA's default `metricType` is
`AverageValue`, so the HPA divides `LLEN` by `listLength`. `listLength: "5"` with 100 queued builds asks
for **20 pods**, not 1. Budget node-pool capacity against that arithmetic.

Defaults: `pollingInterval` 30 s, `cooldownPeriod` 300 s, `minReplicaCount` 0, `maxReplicaCount` 100.
KEDA owns 0↔1 and generates an HPA named `keda-hpa-{name}` that owns 1→N.

### 9.5 Two autoscalers, not one

**KEDA scales pods. It does not create nodes.** Cluster Autoscaler is the second, independent loop —
it adds nodes when pods are `Pending` and removes consistently-unneeded ones, operating on node pools.
You need **both**, and the build pool's `--max-nodes` is the real ceiling on build concurrency.

### 9.6 Redis is the single point of failure

Redis's own docs are explicit that neither HA option gives durability guarantees: Sentinel needs ≥3
instances in independently-failing locations and "does not guarantee acknowledged writes survive
failover"; Cluster does not guarantee strong consistency. **Cluster buys this system nothing for the
queue** — `build-queue` is one key in one hash slot, so sharding cannot spread it.

⚠️ **DigitalOcean trap:** Managed Valkey defaults to `noeviction` (correct for a job queue), but
**DO's own guide labels `allkeys-lru` as "Recommended."** Taking that recommendation makes `build-queue`
an eviction candidate — queued deployments would **silently vanish** under memory pressure. The safe
setting is the non-recommended default. BRPOP/BLPOP are not on DO's blocked-command list, so the
existing loop works unchanged.

---

## 10. Cost, at verified 2026-08-10 list prices

Every unit price below was independently re-fetched by the verifier.

| Item | Price |
|---|---|
| DOKS standard control plane | **$0** |
| HA control plane (99.95% SLA) | $40.00/mo |
| `s-1vcpu-2gb` worker | $12.00/mo |
| `s-2vcpu-4gb` worker | $24.00/mo |
| DO Load Balancer — regional HTTP | $12.00/mo/node |
| DO Load Balancer — network (L4) | $15.00/mo/node |
| DOCR Starter / Basic / Professional | free (500 MiB) / $5.00 (5 GiB) / $20.00 (100 GiB); overage $0.02/GiB |
| Managed Caching for Valkey, 1 GiB | $15.00/mo |
| DO Managed Postgres, smallest | $15.15/mo |
| AWS EKS control plane (comparison) | $73.00/mo — **before any worker runs** |

### 10.1 The correction that matters

The research's original "$68/mo floor" (3 × `s-1vcpu-2gb` + LB + DOCR + Valkey) **does not survive
review**. DO's limits table shows a 2 GiB node yields **~1 GiB allocatable**, and DO's own guidance is:

> "We recommend using nodes with less than 2 GB of **allocatable** memory only for development purposes
> and not production."

Since a 2 GiB node has ~1 GiB *allocatable*, that warning captures those exact nodes. So $68/mo is a
**dev-tier floor**, and ~3 GiB total allocatable would have to host five services plus ingress/gateway,
cert-manager and metrics-server. **A realistic production floor starts at `s-2vcpu-4gb` nodes.**

Also omitted from the original model and flagged here: egress/bandwidth, block storage for any PVC,
DOCR overage, and R2. And the EKS comparison overstated the unavoidable floor by including a NAT Gateway
($32.85/mo), which is a VPC design choice, not an EKS requirement — the genuinely unavoidable EKS figure
is **$73.00**.

### 10.2 App Platform is the wrong tool here — and for a specific documented reason

Not because it can't do wildcards or workers (it can — that common assumption is wrong), but:

> "You can't use wildcard domains in the subdomain routing block."
> — [DO — manage domains](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/)

Plus: no volumes, and **builds time out after 1 hour**. The wildcard restriction alone disqualifies it
for `{id}.domain.com` per-deployment routing.

---

## 11. Code changes required before any of this works

Ordered by whether the cluster functions at all without them.

| # | Change | Why | Where |
|---|---|---|---|
| 1 | **`REDIS_URL` env var** replacing bare `createClient()` | Defaults to `localhost:6379`; in a pod that is the pod itself. **Nothing works without this.** | [upload:17](../../vercel-upload-service/src/index.ts), [deploy:9,14](../../vercel-deploy-service/src/index.ts), [screenshot:8](../../vercel-screenshot-service/src/index.ts) |
| 2 | **`/healthz` on both HTTP services**, mounted *before* the wildcard route | See §11.1 — without it the request handler can never become Ready | request-handler, upload-service |
| 3 | **SIGTERM handler + `BLMOVE` processing list** in the deploy worker | §9.3 — every rolling update currently orphans a build | deploy-service |
| 4 | **Dockerfiles** for all five services | None exist | all |
| 5 | **Validate the extracted id** against the DB before serving | §7.1 — turns a guessed label into a 404 | request-handler |
| 6 | **Build timeout + no ambient R2 creds** in the build path | §8.1, §8.6 | deploy-service |

### 11.1 The readiness-probe trap (worth its own note)

The request handler's only route is `GET /{*splat}`, which derives the tenant from `req.hostname`. A
kubelet HTTP probe arrives with `Host: <pod-IP>`, so `hostname.split(".")[0]` yields `10`, the fetch of
`dist/10/index.html` 404s, **readiness fails permanently, the Service gets zero endpoints, and every
tenant site goes down while all pods are running perfectly.** A `/healthz` mounted before the wildcard
route is mandatory, not hygiene.

### 11.2 One thing already right

The screenshot service connects to `REQUEST_HANDLER_ORIGIN` by IP and sets `Host` manually via
`node:http` ([capture.ts:42-49](../../vercel-screenshot-service/src/capture.ts)) — with a comment
explaining that `fetch` silently drops the forbidden `Host` header. This **accidentally solves a real
Kubernetes problem**: a pod calling its own cluster's external LB IP gets short-circuited by kube-proxy
and bypasses the load balancer. Because this code talks to an origin + explicit Host rather than to the
public URL, it ports to the cluster by changing `REQUEST_HANDLER_ORIGIN` to
`http://vercel-request-handler.default.svc.cluster.local:3001` and `PREVIEW_HOST` to the real domain.
Keep this design.

---

## 12. Corrections the verifiers forced (recorded, not deleted)

| Original claim | Verdict | Correction |
|---|---|---|
| Vercel job postings name Golang + Terraform as the build-infra stack, "a fleet of clusters, running 100's of instances" | **REFUTED** | The quoted string appears in **none** of the three cited URLs; one posting is dead; CloudFormation appears nowhere. Evidence discarded entirely. The conclusion (K8s is not Vercel's build runtime) is true via §3.5, but **not** by this route |
| All real platforms use flat single-label deployment subdomains | **REFUTED** | Cloudflare Pages uses `<hash>.<project>.pages.dev` — two labels — and uses per-project wildcards. The **recommendation** stands (argued from Vercel + Netlify), but not as an industry universal |
| Hive's bare-metal boxes are EC2 `.metal` | **UNVERIFIABLE** | Correctly self-labelled as inference. Vercel has never stated where the boxes are; re-fetching the Hive post confirms it names no cloud provider |
| Without `/dev/kvm`, Kata falls back to QEMU TCG | **UNVERIFIABLE** | The cited page contains none of this content. Zero citation support. See §13 |
| $68/mo DOKS floor | **OVERSTATED** | Built on nodes DO itself calls dev-only. See §10.1 |
| 5 LoadBalancers = $48/mo avoidable | **OVERSTATED** | Only 3 services expose HTTP; real delta is $24/mo |
| EKS costs $122.28/mo before workers | **OVERSTATED** | NAT Gateway is a design choice; unavoidable figure is $73.00 |
| Playwright docs specify 64 MB `/dev/shm` fix | **OVERSTATED** | Playwright documents only `--ipc=host` ("Without it, Chromium can run out of memory and crash"). 64 MB is Docker's default; the `emptyDir medium:Memory` remedy is standard practice but uncited |
| Railway ≈ $50/mo, pricier than DOKS | **OVERSTATED** | Railway meters actual usage; two of five services are idle `brPop` workers. $50 is an upper bound, and the comparison verdict is not established |
| Hetzner repriced twice in 2026 | **OVERSTATED** | One documented adjustment (15 Jun 2026). CPX21 USA +167% is real and regional |
| DOKS does not support gVisor/Kata | **OVERSTATED** | Accurate form: *not officially supported; manual install breaks on node replacement.* Rests on a 3-vote user post plus the reconciler doc |

**Additional contradiction surfaced:** GitLab's runner docs say "Docker can be considered safe when
running in non-privileged mode," which sits in tension with Google/Cloudflare/Vercel. **Resolution:**
GitLab is contrasting non-privileged vs privileged Docker *within* a runner, not claiming a shared-kernel
container is a boundary against a hostile tenant. Weight the four vendors who actually run hostile
multi-tenant build traffic.

---

## 13. Confidence and open questions

**High confidence:** ingress-nginx retirement and the Ingress freeze; Ingress vs Gateway API wildcard
semantics; RFC 6125 single-label wildcard certs; DNS-01 required for wildcard issuance; BRPOP
exactly-once-delivery and at-most-once loss; `BLMOVE` replacing `BRPOPLPUSH`; the pod termination
sequence; KEDA ScaledObject scale-in destroying in-flight work; the container-escape CVE record; the
four-vendor consensus against shared-kernel containers for untrusted builds; the DOKS node-pool label
key; DO unit prices as of 2026-08-10.

**Medium confidence:** DOKS's inability to run gVisor/Kata (see §12); Cilium Gateway API wildcard
maturity; the `/dev/shm` sizing specifics for Chromium; cost projections beyond the verified unit prices.

**Open questions — these must be settled empirically before committing:**

1. **Does the Cilium Gateway API wildcard listener actually work on current DOKS?**
   ([cilium#44118](https://github.com/cilium/cilium/issues/44118)) — smoke-test before building on it.
2. **Does the `except: 169.254.169.254/32` NetworkPolicy actually block metadata on DOKS/Cilium?**
   `curl` from inside a build pod is the only proof ([kubernetes#68078](https://github.com/kubernetes/kubernetes/issues/68078)).
3. **Do DOKS worker nodes expose `/dev/kvm`?** This single fact decides whether Kata is even theoretically
   possible. No DigitalOcean primary source found either way. `ls /dev/kvm` on a node settles it.
4. **What is Lovable's actual sandbox architecture?** Nothing published in their own words. Everything
   public is a vendor case study or a job ad.
5. **What is gVisor's measured overhead for `npm install && npm run build` specifically?** That workload
   is filesystem- and syscall-heavy — gVisor's documented weak case — and no benchmark of a Node build
   under `runsc` was found.
6. **How does the built artifact leave the sandbox without carrying its credentials?** Every source
   discusses isolating the executing process; **none** discusses the artifact-egress boundary. This is a
   gap in the public literature, and it is precisely where this codebase is currently most exposed.

## 14. Pre-mortem — six months out, this failed. Why?

1. **We installed ingress-nginx from a tutorial** and ran unpatched internet-facing infrastructure.
2. **We adopted Gateway API and hit the Cilium wildcard bug in production** instead of smoke-testing it.
3. **We set `trust proxy` to get real client IPs** and handed tenant selection to `X-Forwarded-Host`.
4. **We opened signups.** Option A (§8.5) was never defensible for untrusted repos, and a `postinstall`
   script took the R2 keys.
5. **We used KEDA ScaledObject**, and every autoscale event killed in-flight builds.
6. **We took DigitalOcean's "recommended" `allkeys-lru`** and the build queue silently evaporated under
   load.
7. **We sized on the $68 floor** and the cluster OOM-killed under three concurrent builds.

Each of these is prevented by a specific section above. That mapping is the point of the document.
