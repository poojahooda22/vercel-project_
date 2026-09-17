import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { generate } from "./utils";
import { deletePrefix, getObjectBytes } from "./aws";
import { getUserId, requireUser } from "./session";
import {
  BUILD_QUEUE,
  GithubApiError,
  INGEST_QUEUE,
  createInstallationToken,
  createRedisClient,
  getAppInstallation,
  getAuthenticatedUser,
  getUserById,
  getUserInstallation,
  githubAppConfig,
  installUrl,
  listInstallationRepos,
  type DeploymentTrigger,
  type GithubAppConfig,
  type GithubInstallation,
  type Project,
} from "@vercel-clone/shared";
import { TEMP_ROOT, canonicalGithubUrl, ensureTempRoot, parseRepoFullName } from "./clone";
import {
  CLONE_WALL_CLOCK_MS,
  INSTALLATION_REMOVED,
  INSTALLATION_SUSPENDED,
  UPLOAD_WALL_CLOCK_MS,
  liveDirs,
  startIngestLoop,
} from "./ingest";
import {
  DELIVERY_RE,
  SIGNATURE_RE,
  isInstallationEvent,
  isPushEvent,
  pushedBranch,
  verifySignature,
} from "./webhook";
import {
  cancelQueuedBefore,
  countPending,
  createDeployment,
  deleteDeployment,
  deleteInstallation,
  deleteInstallationAnyOwner,
  deleteProject,
  detachInstallationFromProjects,
  failQueued,
  findOrCreateProject,
  findProjectsForPush,
  getDeployment,
  getGithubAccounts,
  getInstallation,
  getProject,
  isProductionDeployment,
  latestBuildEnv,
  listDeployments,
  listInstallations,
  listProjectDeployments,
  listProjects,
  promoteDeployment,
  setProductionBranch,
  upsertInstallation,
  type GithubAccount,
  type GithubInstallationRow,
} from "./db";

const publisher = createRedisClient("upload/publisher");

const app = express();
// Exact paths only: with the defaults, "/webhooks/github/" and "/Webhooks/GitHub"
// would reach the webhook route but not the parser gate keyed on its exact path.
app.set("strict routing", true);
app.set("case sensitive routing", true);

// The dashboard sends its session cookie, so the origin cannot be "*": the CORS
// spec forbids credentials with a wildcard origin, and browsers drop the response.
// In production the dashboard and this API share an origin behind Caddy and none of
// this applies — it exists for local dev, where they are :3002 and :3000.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3002";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// JSON bodies for every route but the webhook, at the parser's 100 KB default —
// the largest legitimate body here is a build-env map under 8 KB. The webhook
// receiver takes the raw bytes with its own parser (see the route): its signature
// is over those bytes, and GitHub's payloads run to 25 MB.
const WEBHOOK_PATH = "/webhooks/github";
const json = express.json();
app.use((req, res, next) => (req.path === WEBHOOK_PATH ? next() : json(req, res, next)));

// Tenant sites live on sibling hostnames of the dashboard, which browsers treat
// as the same site: a page on one of them can POST to this API and the session
// cookie rides along. A browser always names the page's origin on such a request,
// so a mutating request from any origin but the dashboard's is refused. Requests
// without an Origin (scripts, curl) carry no ambient cookie and pass. The webhook
// authenticates itself.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.use((req, res, next) => {
  if (req.path === WEBHOOK_PATH || !MUTATING.has(req.method)) {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== FRONTEND_ORIGIN) {
    res.status(403).json({ error: "cross-site request refused" });
    return;
  }
  next();
});

// Build-env limits. The values end up in a child process environment and a JSONB
// column, so both the shape and the size are bounded here at the trust boundary,
// not deep in the worker where a rejection can no longer become a clean 400.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_MAX_VARS = 32;
const ENV_MAX_BYTES = 8 * 1024;
// The worker grants the build a minimal allowlisted environment; letting a user
// override PATH or HOME would redirect which binaries the build executes.
const ENV_RESERVED = new Set([
  "PATH", "HOME", "LANG", "SystemRoot", "ComSpec", "TEMP", "TMP", "APPDATA", "USERPROFILE",
]);

/** Returns the validated map, null for "none given", or a string describing the rejection. */
function parseBuildEnv(raw: unknown): Record<string, string> | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "env must be an object of KEY: value";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length > ENV_MAX_VARS) return `at most ${ENV_MAX_VARS} environment variables`;
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key) || key.length > 64) return `invalid variable name: ${key}`;
    if (ENV_RESERVED.has(key)) return `${key} is reserved and cannot be set`;
    if (typeof value !== "string") return `value of ${key} must be a string`;
    env[key] = value;
  }
  if (JSON.stringify(env).length > ENV_MAX_BYTES) return "environment variables exceed 8KB";
  return env;
}

// A deploy request only records a row and enqueues it; the ingest loop does the
// work. The queue is bounded so overload becomes a fast "try later" rather than
// hours of silent lag (a queued row is a promise the loop must eventually keep).
// The bound is per tenant first — one account's backlog must not turn into a
// refusal for everyone else's pushes — and platform-wide last.
const MAX_QUEUE_DEPTH = 100;
const MAX_PENDING_PER_USER = 10;

/**
 * A GitHub API failure is the platform's problem, not the caller's. A rate limit
 * is a platform-wide backoff and says so (503 + Retry-After from GitHub's own
 * header when it sent one); anything else is 502.
 */
function githubFailure(res: express.Response, e: unknown, doing: string): void {
  if (e instanceof GithubApiError && e.rateLimited) {
    console.error(`GitHub rate limit while ${doing}:`, e.message);
    res.set("Retry-After", String(e.backoffSec()));
    res.status(503).json({ error: "GitHub is rate limiting this server; try again in a minute" });
    return;
  }
  console.error(`GitHub API failed while ${doing}:`, e instanceof Error ? e.message : e);
  res.status(502).json({ error: `GitHub did not answer while ${doing}` });
}

// ---- Per-user request budgets ------------------------------------------------------
//
// Every route that spends the App's platform-wide GitHub allowance or starts a
// deployment is budgeted per user, so one signed-in account cannot burn either
// for everyone. In-process counters: correct for the one instance this service
// runs as (Tier B); N instances would need a shared store.
const buckets = new Map<string, number[]>();

function overBudget(key: string, max: number, windowMs: number): number | null {
  const now = Date.now();
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (stamps.length >= max) {
    buckets.set(key, stamps);
    return Math.ceil((stamps[0] + windowMs - now) / 1000);
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return null;
}

/** Answers 429 + Retry-After and returns true when the caller is over budget. */
function limited(res: express.Response, key: string, max: number, windowMs: number): boolean {
  const retry = overBudget(key, max, windowMs);
  if (retry === null) return false;
  res.set("Retry-After", String(retry));
  res.status(429).json({ error: `too many requests — try again in ${retry}s` });
  return true;
}

// ---- GitHub App: installations ---------------------------------------------------

function installationRow(i: GithubInstallation, userId: string) {
  return {
    installationId: i.id,
    userId,
    accountLogin: i.account.login,
    accountType: i.account.type,
    repositorySelection: i.repository_selection,
  };
}

/** The proof that binds an installation to a user: it sits on a GitHub account they signed in with. */
function ownsInstallation(accounts: GithubAccount[], i: GithubInstallation): boolean {
  return i.account.type === "User" && accounts.some((a) => a.accountId === String(i.account.id));
}

// GitHub account id -> login, kept for an hour. The sign-in flow stored only the
// id; logins can be renamed, so a lookup that fails by login forgets the entry.
const loginByAccountId = new Map<string, { login: string; at: number }>();
const LOGIN_TTL_MS = 60 * 60_000;

/**
 * The login of one signed-in GitHub identity. Asks GitHub with the user's OWN
 * OAuth token (their allowance, 5,000/h), and only falls back to the public,
 * server-shared 60/h lookup when that token no longer works.
 */
async function githubLogin(account: GithubAccount): Promise<string> {
  const hit = loginByAccountId.get(account.accountId);
  if (hit && Date.now() - hit.at < LOGIN_TTL_MS) return hit.login;
  let login: string | null = null;
  if (account.accessToken) {
    try {
      const me = await getAuthenticatedUser(account.accessToken);
      if (String(me.id) === account.accountId) login = me.login;
    } catch (e) {
      if (!(e instanceof GithubApiError && e.status === 401)) throw e;
    }
  }
  if (!login) login = (await getUserById(account.accountId)).login;
  loginByAccountId.set(account.accountId, { login, at: Date.now() });
  return login;
}

// A user with no installation costs one lookup per minute, not per request. The
// stamp is written only after a lookup completed, so a GitHub blip does not turn
// into a minute of "not connected".
const discoveryChecked = new Map<string, number>();
const DISCOVERY_TTL_MS = 60_000;

/**
 * The installations this user may deploy from.
 *
 * Normally these arrive through the callback GitHub redirects to after an install.
 * While the user has no row at all, one constant-cost lookup discovers an existing
 * installation on their GitHub account instead — the install made before the
 * callback existed, or one whose redirect was lost. It is the same proof the
 * callback applies, so it grants nothing more. A suspended installation is never
 * stored; it is reported so the dialog can say why. Called from /github/status
 * only; the repos and deploy routes read rows.
 */
async function ownedInstallations(
  userId: string,
  cfg: GithubAppConfig,
  accounts: GithubAccount[]
): Promise<{ rows: GithubInstallationRow[]; suspended: boolean }> {
  const known = await listInstallations(userId);
  if (known.length > 0) return { rows: known, suspended: false };

  const checked = discoveryChecked.get(userId);
  if (checked && Date.now() - checked < DISCOVERY_TTL_MS) return { rows: [], suspended: false };

  let suspended = false;
  for (const account of accounts) {
    const login = await githubLogin(account);
    const found = await getUserInstallation(cfg, login);
    if (!found) {
      // The stored login may be stale after a rename; forget it so the next check re-asks.
      loginByAccountId.delete(account.accountId);
      continue;
    }
    if (!ownsInstallation(accounts, found)) continue;
    if (found.suspended_at) {
      suspended = true;
      continue;
    }
    await upsertInstallation(installationRow(found, userId));
  }
  const rows = await listInstallations(userId);
  if (rows.length === 0) discoveryChecked.set(userId, Date.now());
  return { rows, suspended };
}

// A metadata-only token per installation, reused until five minutes before it
// expires: listing the picker must not cost a token mint per open, because every
// mint draws on the App's single platform-wide allowance.
const listingTokens = new Map<number, { token: string; expiresAt: number }>();

type Gone = "removed" | "suspended";

/**
 * Why a token could not be minted for a known row, if GitHub no longer honours it.
 * A 404 is definitive. A 403 is ambiguous — suspension, or GitHub's rate limiting —
 * so it is resolved with one read of the installation. Anything else is rethrown.
 */
async function installationGone(cfg: GithubAppConfig, e: unknown, installationId: number): Promise<Gone | null> {
  if (!(e instanceof GithubApiError) || e.rateLimited) return null;
  if (e.status === 404) return "removed";
  if (e.status !== 403) return null;
  try {
    const live = await getAppInstallation(cfg, installationId);
    return live.suspended_at ? "suspended" : null;
  } catch (inner) {
    if (inner instanceof GithubApiError && inner.status === 404) return "removed";
    return null;
  }
}

async function forgetInstallation(installationId: number, userId: string): Promise<void> {
  listingTokens.delete(installationId);
  await deleteInstallation(installationId, userId);
}

/** A listing token, or the reason the installation is unusable (its row is dropped then). */
async function listingToken(
  cfg: GithubAppConfig,
  inst: GithubInstallationRow
): Promise<{ token: string } | { gone: Gone }> {
  const hit = listingTokens.get(inst.installation_id);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return { token: hit.token };
  try {
    const t = await createInstallationToken(cfg, inst.installation_id, {
      permissions: { metadata: "read" },
    });
    listingTokens.set(inst.installation_id, { token: t.token, expiresAt: Date.parse(t.expires_at) });
    return { token: t.token };
  } catch (e) {
    const gone = await installationGone(cfg, e, inst.installation_id);
    if (!gone) throw e;
    await forgetInstallation(inst.installation_id, inst.user_id);
    return { gone };
  }
}

app.get("/github/status", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (limited(res, `status:${userId}`, 30, 60_000)) return;

  const cfg = githubAppConfig();
  if (!cfg) {
    res.json({ configured: false, githubLinked: false, installations: [] });
    return;
  }

  try {
    const accounts = await getGithubAccounts(userId);
    const { rows, suspended } = accounts.length
      ? await ownedInstallations(userId, cfg, accounts)
      : { rows: [], suspended: false };
    res.json({
      configured: true,
      installUrl: installUrl(cfg),
      githubLinked: accounts.length > 0,
      installations: rows.map((i) => ({
        installation_id: i.installation_id,
        account_login: i.account_login,
      })),
      suspended,
    });
  } catch (e) {
    githubFailure(res, e, "checking your installations");
  }
});

/**
 * Where GitHub sends the browser after the App is installed (the App's Setup URL,
 * with "Redirect on update" on). The installation id in the query string is
 * untrusted: anyone signed in could type one. It is attached to this user only
 * after GitHub confirms the installation belongs to a GitHub account this user
 * signed in with — otherwise one user could deploy another's private repos.
 *
 * Every outcome that is not the user's own installation answers "unknown", so the
 * route cannot be used to learn which installation ids exist or whose they are.
 */
app.get("/github/callback", async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    res.redirect(`${FRONTEND_ORIGIN}/login`);
    return;
  }
  const back = (outcome: string) => res.redirect(`${FRONTEND_ORIGIN}/?github=${outcome}`);

  // A top-level navigation from GitHub carries Sec-Fetch-Dest: document. An <img>
  // or <script> on a third-party page does not, and must not be able to spend
  // this user's budget or trigger GitHub calls on their behalf.
  const dest = req.get("sec-fetch-dest");
  if (dest && dest !== "document") {
    res.status(403).end();
    return;
  }

  // Cheap validation first, so a malformed or unconfigured request costs no budget.
  const cfg = githubAppConfig();
  if (!cfg) {
    back("unconfigured");
    return;
  }
  const installationId = Number(req.query.installation_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    back("unknown");
    return;
  }
  if (overBudget(`callback:${userId}`, 10, 60_000) !== null) {
    back("busy");
    return;
  }

  let accounts: GithubAccount[];
  try {
    accounts = await getGithubAccounts(userId);
  } catch (e) {
    console.error("callback: could not read accounts:", e instanceof Error ? e.message : e);
    back("server-error");
    return;
  }
  if (accounts.length === 0) {
    back("link-required");
    return;
  }

  let installation: GithubInstallation;
  try {
    installation = await getAppInstallation(cfg, installationId);
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 404) {
      back("unknown");
      return;
    }
    console.error("GitHub API failed while reading an installation:", e instanceof Error ? e.message : e);
    back("github-error");
    return;
  }

  if (!ownsInstallation(accounts, installation)) {
    back("unknown");
    return;
  }
  if (installation.suspended_at) {
    back("suspended");
    return;
  }

  try {
    await upsertInstallation(installationRow(installation, userId));
  } catch (e) {
    console.error("callback: could not record the installation:", e instanceof Error ? e.message : e);
    back("server-error");
    return;
  }
  discoveryChecked.delete(userId);
  back("connected");
});

app.get("/github/repos", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (limited(res, `repos:${userId}`, 30, 60_000)) return;

  const cfg = githubAppConfig();
  if (!cfg) {
    res.status(404).json({ error: "GitHub App not configured", repos: [], installations: [] });
    return;
  }

  try {
    const rows = await listInstallations(userId);
    const repos: {
      installation_id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
    }[] = [];
    const alive: number[] = [];
    let removed = false;
    let suspended = false;
    for (const inst of rows) {
      const got = await listingToken(cfg, inst);
      if ("gone" in got) {
        removed = true;
        if (got.gone === "suspended") suspended = true;
        continue;
      }
      alive.push(inst.installation_id);
      for (const r of await listInstallationRepos(got.token)) {
        repos.push({
          installation_id: inst.installation_id,
          full_name: r.full_name,
          private: r.private,
          default_branch: r.default_branch,
        });
      }
    }
    repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
    res.json({ repos, installations: alive, removed, suspended });
  } catch (e) {
    githubFailure(res, e, "listing your repositories");
  }
});

// ---- Deployments: record and enqueue -----------------------------------------------

/**
 * Answers 429 (this account's backlog) or 503 (the platform's) and returns true
 * when a dashboard deploy must wait.
 */
async function queueFull(res: express.Response, userId: string): Promise<boolean> {
  if (await userBacklogFull(userId)) {
    res.set("Retry-After", "60");
    res.status(429).json({
      error: `You have ${MAX_PENDING_PER_USER} deployments waiting already; let some finish first.`,
    });
    return true;
  }
  if (!(await queueDepthExceeded())) return false;
  res.set("Retry-After", "60");
  res.status(503).json({ error: "The deploy queue is full; try again in a minute." });
  return true;
}

async function userBacklogFull(userId: string): Promise<boolean> {
  return (await countPending(userId)) >= MAX_PENDING_PER_USER;
}

async function queueDepthExceeded(): Promise<boolean> {
  return (await publisher.lLen(INGEST_QUEUE)) >= MAX_QUEUE_DEPTH;
}

/**
 * Records a queued deployment for a project and hands it to the ingest loop.
 * Reserving the row is also the id collision check; a row that cannot be
 * enqueued is failed with the reason rather than left queued forever.
 */
async function enqueueDeployment(
  project: Project,
  opts: { buildEnv: Record<string, string> | null; gitRef: string | null; gitSha: string | null; trigger: DeploymentTrigger }
): Promise<string> {
  let id = generate();
  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await createDeployment({
      id,
      projectId: project.id,
      repoUrl: project.repo_url,
      userId: project.user_id,
      buildEnv: opts.buildEnv,
      installationId: project.installation_id,
      repoFullName: project.repo_full_name,
      gitRef: opts.gitRef,
      gitSha: opts.gitSha,
      trigger: opts.trigger,
    });
    if (created) break;
    id = generate();
    if (attempt === 2) throw new Error("could not reserve a deployment id");
  }
  try {
    await publisher.lPush(INGEST_QUEUE, id);
  } catch (e) {
    // A fixed sentence on the row; the reason (which names internal hosts) goes to the log.
    console.error(`deploy ${id}: could not enqueue:`, e instanceof Error ? e.message : e);
    await failQueued(id, "The deployment could not be queued; try again.");
    throw e;
  }
  return id;
}

/**
 * What a superseded deployment leaves behind: its id in a queue (the loop or the
 * worker would pop it only to skip it) and, if its ingest had finished, a staged
 * tree in the bucket that nothing will ever build. Best effort, logged.
 */
async function sweepCanceled(ids: string[]): Promise<void> {
  for (const id of ids) {
    for (const queue of [INGEST_QUEUE, BUILD_QUEUE]) {
      await publisher.lRem(queue, 0, id).catch((e) =>
        console.error(`cancel ${id}: could not drop from ${queue}:`, e instanceof Error ? e.message : e)
      );
    }
    try {
      const n = await deletePrefix(`output/${id}/`);
      if (n > 0) console.log(`cancel ${id}: swept ${n} staged object(s)`);
    } catch (e) {
      console.error(`cancel ${id}: could not sweep staged objects:`, e instanceof Error ? e.message : e);
    }
  }
}

app.post("/deploy", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (limited(res, `deploy:${userId}`, 10, 60_000)) return;

  const buildEnv = parseBuildEnv(req.body?.env);
  if (typeof buildEnv === "string") {
    res.status(400).json({ error: buildEnv });
    return;
  }

  // Two ways in. A repository chosen in the picker is read through the GitHub App
  // with a one-hour token limited to that one repository, minted by the ingest
  // loop when the clone actually runs; a pasted URL is cloned anonymously, so it
  // must be public. Both become a project and a queued deployment.
  let repoUrl: string;
  let repoFullName: string | null = null;
  let installationId: number | null = null;

  if (req.body?.repo !== undefined || req.body?.installationId !== undefined) {
    const cfg = githubAppConfig();
    if (!cfg) {
      res.status(400).json({ error: "GitHub App not configured on this server" });
      return;
    }
    const repo = parseRepoFullName(req.body?.repo);
    installationId = Number(req.body?.installationId);
    if (!repo || !Number.isSafeInteger(installationId) || installationId <= 0) {
      res.status(400).json({ error: "repo (owner/name) and installationId are required" });
      return;
    }
    // Ownership is the query: an installation that is not this user's does not exist.
    let installation: GithubInstallationRow | null;
    try {
      installation = await getInstallation(installationId, userId);
    } catch (e) {
      console.error("deploy: could not read the installation:", e instanceof Error ? e.message : e);
      res.status(503).json({ error: "The database did not answer; try again in a moment." });
      return;
    }
    if (!installation) {
      res.status(404).json({ error: "no such installation" });
      return;
    }
    // The token is scoped by repository NAME within the installation, so the owner
    // half must be the installation's account or the project would record a source
    // that was never granted. Logins can be renamed: on a mismatch the row is
    // refreshed from GitHub once before the request is refused.
    if (repo.owner.toLowerCase() !== installation.account_login.toLowerCase()) {
      try {
        const live = await getAppInstallation(cfg, installationId);
        if (live.suspended_at) {
          await forgetInstallation(installationId, userId);
          res.status(400).json({ error: INSTALLATION_SUSPENDED });
          return;
        }
        if (ownsInstallation(await getGithubAccounts(userId), live)) {
          await upsertInstallation(installationRow(live, userId));
          installation = { ...installation, account_login: live.account.login };
        }
      } catch (e) {
        if (e instanceof GithubApiError && e.status === 404) {
          await forgetInstallation(installationId, userId);
          res.status(400).json({ error: INSTALLATION_REMOVED });
          return;
        }
        githubFailure(res, e, "checking your installation");
        return;
      }
      if (repo.owner.toLowerCase() !== installation.account_login.toLowerCase()) {
        res.status(400).json({ error: "That repository is not in your GitHub installation." });
        return;
      }
    }
    // Lower-case, like canonicalGithubUrl: GitHub names are case-insensitive, and
    // the same repository picked and pasted must land on one project.
    repoFullName = `${installation.account_login}/${repo.name}`.toLowerCase();
    repoUrl = `https://github.com/${repoFullName}`;
  } else {
    const canonical = canonicalGithubUrl(req.body?.repoUrl);
    if (!canonical) {
      res.status(400).json({ error: "repoUrl must look like https://github.com/owner/repo" });
      return;
    }
    repoUrl = canonical;
    repoFullName = canonical.slice("https://github.com/".length);
  }

  try {
    if (await queueFull(res, userId)) return;
    const project = await findOrCreateProject({
      userId,
      name: repoUrl.split("/").pop() ?? "site",
      repoUrl,
      repoFullName,
      installationId,
    });
    // gitRef null: the clone follows the repository's default branch as it is now.
    const id = await enqueueDeployment(project, {
      buildEnv,
      gitRef: null,
      gitSha: null,
      trigger: "manual",
    });
    // Newest wins for a manual deploy too: an older row of this project still
    // waiting would only build something this one replaces.
    const superseded = await cancelQueuedBefore(project.id, id);
    if (superseded.length > 0) void sweepCanceled(superseded);
    res.status(202).json({ id, projectId: project.id, slug: project.slug });
  } catch (e) {
    console.error("deploy: could not record the deployment:", e instanceof Error ? e.message : e);
    res.status(503).json({ error: "The deployment could not be recorded; try again in a moment." });
  }
});

// ---- Projects ----------------------------------------------------------------------

app.get("/projects", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  res.json({ projects: await listProjects(userId) });
});

app.get("/projects/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const project = await getProject(req.params.id, userId);
  if (!project) {
    res.status(404).json({ error: "no such project" });
    return;
  }
  res.json({ project, deployments: await listProjectDeployments(project.id, userId) });
});

/** Deploy the production branch again, with the last build-time variables used. */
app.post("/projects/:id/deploy", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (limited(res, `deploy:${userId}`, 10, 60_000)) return;
  const project = await getProject(req.params.id, userId);
  if (!project) {
    res.status(404).json({ error: "no such project" });
    return;
  }
  try {
    if (await queueFull(res, userId)) return;
    const id = await enqueueDeployment(project, {
      buildEnv: await latestBuildEnv(project.id),
      gitRef: null,
      gitSha: null,
      trigger: "manual",
    });
    const superseded = await cancelQueuedBefore(project.id, id);
    if (superseded.length > 0) void sweepCanceled(superseded);
    res.status(202).json({ id, superseded: superseded.length });
  } catch (e) {
    console.error("redeploy: could not record the deployment:", e instanceof Error ? e.message : e);
    res.status(503).json({ error: "The deployment could not be recorded; try again in a moment." });
  }
});

/**
 * Points the project's production URL at one of its deployed builds. Rollback is
 * the same call with an older deployment. The files never move; the request
 * handler re-reads the pointer within seconds.
 */
app.post("/projects/:id/promote", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const deploymentId = req.body?.deploymentId;
  if (typeof deploymentId !== "string" || !/^[a-z0-9]+$/i.test(deploymentId)) {
    res.status(400).json({ error: "deploymentId is required" });
    return;
  }
  const project = await promoteDeployment(req.params.id, userId, deploymentId);
  if (!project) {
    // Not this user's project, or not a deployed build of it: the same answer, so
    // the route cannot be used to probe which ids exist.
    res.status(400).json({ error: "That deployment is not a deployed build of this project." });
    return;
  }
  res.json({ project: await getProject(project.id, userId) });
});

app.delete("/projects/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  // ROW FIRST: the delete is the ownership check; only then are objects swept.
  const ids = await deleteProject(req.params.id, userId);
  if (ids === null) {
    res.status(404).json({ error: "no such project" });
    return;
  }
  // The rows are gone, which is what the caller asked for; the objects follow off
  // the request path (six storage calls per deployment would otherwise hold the
  // response for a project with a long history). A build still running for one
  // of these ids finds its row gone when it finishes and sweeps its own output.
  res.json({ id: req.params.id, deploymentsDeleted: ids.length });
  void sweepDeployments(ids);
});

/** Removes every object a set of deleted deployments left in the bucket. Best effort, logged. */
async function sweepDeployments(ids: string[]): Promise<void> {
  for (const id of ids) {
    for (const prefix of [`output/${id}/`, `dist/${id}/`, `screenshots/${id}.`]) {
      try {
        await deletePrefix(prefix);
      } catch (e) {
        console.error(`delete ${id}: could not sweep ${prefix}:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

// ---- GitHub webhook: push to deploy -------------------------------------------------

/**
 * GitHub calls this within seconds of a push to any repository the App is
 * installed on. The contract is fast-ack: verify the signature over the raw
 * bytes, drop redeliveries, record a deployment per matching project, enqueue,
 * and answer — never clone here. GitHub records a delivery as failed after ten
 * seconds and does not retry on its own; the operator's "Redeliver" button reuses
 * the delivery id, so the id is released whenever this delivery did not fully
 * succeed, and a redelivery then completes it (a second row for the same push is
 * harmless: the newer one supersedes the older).
 *
 * Order of checks: the headers GitHub always sends are checked BEFORE the body is
 * read (a request without a well-formed signature never costs a buffer), at most
 * MAX_WEBHOOK_BODIES bodies are held at once, the raw bytes (own parser, GitHub's
 * 25 MB cap) are verified before anything is parsed. The secret is the only
 * authentication on this route; without one configured the route does not exist.
 */
const MAX_WEBHOOK_BODIES = 4;
let webhookBodies = 0;

function webhookGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    res.status(404).json({ error: "webhook receiver not configured" });
    return;
  }
  const signature = req.get("x-hub-signature-256");
  if (!signature || !SIGNATURE_RE.test(signature)) {
    res.status(401).json({ error: "bad signature" });
    return;
  }
  const delivery = req.get("x-github-delivery");
  if (!delivery || !DELIVERY_RE.test(delivery)) {
    res.status(400).json({ error: "X-GitHub-Delivery header is required" });
    return;
  }
  if (!req.get("x-github-event")) {
    res.status(400).json({ error: "X-GitHub-Event header is required" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "set the webhook's content type to application/json" });
    return;
  }
  if (webhookBodies >= MAX_WEBHOOK_BODIES) {
    res.set("Retry-After", "5");
    res.status(503).json({ error: "too many deliveries at once; redeliver shortly" });
    return;
  }
  webhookBodies++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    webhookBodies--;
  };
  res.on("finish", release);
  res.on("close", release);
  next();
}

app.post(WEBHOOK_PATH, webhookGate, express.raw({ type: "application/json", limit: "25mb" }), async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(404).json({ error: "webhook receiver not configured" });
    return;
  }
  const raw: unknown = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    res.status(400).json({ error: "missing body" });
    return;
  }
  if (!verifySignature(secret, raw, req.get("x-hub-signature-256"))) {
    res.status(401).json({ error: "bad signature" });
    return;
  }
  const delivery = req.get("x-github-delivery") ?? "";
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "body is not JSON; set the webhook's content type to application/json" });
    return;
  }
  const event = req.get("x-github-event") ?? "";

  // Claim the delivery id for as long as processing can take; mark it done for a
  // day once the delivery is fully recorded; release it on any failure.
  const key = `github:delivery:${delivery}`;
  if ((await publisher.set(key, "claimed", { NX: true, EX: 600 })) === null) {
    res.json({ ok: true, duplicate: true });
    return;
  }
  const done = () =>
    publisher.set(key, "done", { EX: 86_400 }).catch((e) =>
      console.error(`webhook ${delivery}: could not mark done:`, e instanceof Error ? e.message : e)
    );
  const release = () =>
    publisher.del(key).catch((e) =>
      console.error(`webhook ${delivery}: could not release the delivery id:`, e instanceof Error ? e.message : e)
    );

  try {
    if (event === "ping") {
      await done();
      res.json({ ok: true });
      return;
    }

    if (event === "installation") {
      if (isInstallationEvent(body) && (body.action === "deleted" || body.action === "suspend")) {
        const n = await deleteInstallationAnyOwner(body.installation.id);
        const detached = await detachInstallationFromProjects(body.installation.id);
        listingTokens.delete(body.installation.id);
        console.log(
          `webhook: installation ${body.installation.id} ${body.action}; dropped ${n} row(s), detached ${detached} project(s)`
        );
      }
      await done();
      res.json({ ok: true });
      return;
    }

    if (event !== "push") {
      await done();
      res.status(204).end();
      return;
    }
    if (!isPushEvent(body)) {
      // Not processed, so not "done": a fixed payload can be redelivered.
      await release();
      res.status(400).json({ error: "unexpected push payload" });
      return;
    }
    const branch = pushedBranch(body);
    if (!branch || !body.installation) {
      await done();
      res.json({ ok: true, ignored: branch ? "no installation on this delivery" : "not a branch push" });
      return;
    }
    // Production is the repository's default branch; pushes to other branches
    // are previews, which are a later feature.
    if (branch !== body.repository.default_branch) {
      await done();
      res.json({ ok: true, ignored: "not the default branch" });
      return;
    }

    const projects = await findProjectsForPush(body.installation.id, body.repository.full_name);
    // Same admission as the dashboard: a full queue is a 503 GitHub's log shows
    // as failed, and the delivery id is free again for a redelivery.
    if (projects.length > 0 && (await queueDepthExceeded())) {
      await release();
      res.set("Retry-After", "60");
      res.status(503).json({ error: "The deploy queue is full; redeliver in a minute." });
      return;
    }

    const deployments: { projectId: string; id: string; superseded: number }[] = [];
    const failed: string[] = [];
    for (const project of projects) {
      // No per-project rate budget: newest-per-branch already keeps one queued row
      // per project, and dropping a push would leave the tip undeployed. The
      // owner's backlog bound is the tenant's limit; past it the delivery fails
      // (and is released), so GitHub's log shows it and Redeliver works.
      try {
        if (await userBacklogFull(project.user_id)) {
          console.error(`webhook: project ${project.id}: owner's backlog is full; delivery left for redelivery`);
          failed.push(project.id);
          continue;
        }
        // The default branch was renamed since the project last built: follow it.
        if (project.production_branch !== branch) await setProductionBranch(project.id, branch);
        const id = await enqueueDeployment(project, {
          buildEnv: await latestBuildEnv(project.id),
          gitRef: branch,
          gitSha: body.after,
          trigger: "webhook",
        });
        // Newest per branch wins: anything older of this project still waiting is obsolete.
        const superseded = await cancelQueuedBefore(project.id, id);
        if (superseded.length > 0) void sweepCanceled(superseded);
        deployments.push({ projectId: project.id, id, superseded: superseded.length });
      } catch (e) {
        console.error(`webhook: could not record a deployment for project ${project.id}:`, e instanceof Error ? e.message : e);
        failed.push(project.id);
      }
    }
    console.log(
      `webhook: push ${body.repository.full_name}@${branch} ${body.after.slice(0, 7)} -> ` +
        `${deployments.length} deployment(s)` +
        (failed.length ? `, ${failed.length} FAILED` : "")
    );
    if (failed.length > 0) {
      await release();
      res.status(500).json({ ok: false, deployments, failed });
      return;
    }
    await done();
    res.status(202).json({ ok: true, deployments });
  } catch (e) {
    await release();
    console.error(`webhook ${delivery}: failed:`, e instanceof Error ? e.stack ?? e.message : e);
    res.status(500).json({ error: "The delivery could not be processed; redeliver it." });
  }
});

// ---- Housekeeping ------------------------------------------------------------------
//
// The ingest loop removes each scratch directory in its own `finally`. A process
// killed mid-deploy (OOM, SIGKILL) is the gap: its directory stays in the writable
// layer across restarts. Directories under the service-owned TEMP_ROOT that no
// running job owns and that are older than a whole deploy could take are
// reclaimed at boot and every ten minutes, along with the in-memory caches'
// expired entries.
const TEMP_NAME = /^deploy-[A-Za-z0-9]{6}$/;
const ORPHAN_AGE_MS = CLONE_WALL_CLOCK_MS + UPLOAD_WALL_CLOCK_MS + 60_000;

async function housekeeping(): Promise<void> {
  const now = Date.now();
  for (const [k, v] of listingTokens) if (v.expiresAt <= now) listingTokens.delete(k);
  for (const [k, v] of discoveryChecked) if (now - v > DISCOVERY_TTL_MS) discoveryChecked.delete(k);
  for (const [k, v] of loginByAccountId) if (now - v.at > LOGIN_TTL_MS) loginByAccountId.delete(k);
  for (const [k, v] of buckets) if (v.every((t) => now - t > 60_000)) buckets.delete(k);

  let names: string[];
  try {
    names = await fs.promises.readdir(TEMP_ROOT);
  } catch {
    return;
  }
  const cutoff = now - ORPHAN_AGE_MS;
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    const full = path.join(TEMP_ROOT, name);
    if (liveDirs.has(full)) continue;
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
      await fs.promises.rm(full, { recursive: true, force: true, maxRetries: 3 });
      console.log(`swept orphaned clone ${name}`);
    } catch (e) {
      console.error(`sweep ${name}:`, e instanceof Error ? e.message : e);
    }
  }
}

app.get("/status", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id query parameter is required" });
    return;
  }

  // Someone else's id is a 404, not a 403: telling the caller "exists but not yours"
  // turns this endpoint into an oracle for enumerating other tenants' deployments.
  const deployment = await getDeployment(id, userId);
  if (!deployment) {
    res.status(404).json({ error: "no such deployment" });
    return;
  }

  res.json({
    id: deployment.id,
    status: deployment.state,
    repoUrl: deployment.repo_url,
    error: deployment.error_message,
    createdAt: deployment.created_at,
    finishedAt: deployment.finished_at,
    projectId: deployment.project_id,
  });
});

app.get("/deployments", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  res.json({ deployments: await listDeployments(userId) });
});

// Deliberately PUBLIC, unlike every other route here. The deployment it pictures is
// already served to anyone at {id}.<domain>, so requiring a session to see the
// screenshot would protect nothing while breaking <img> tags, which cannot carry
// credentials as simply as fetch can.
app.get("/screenshot/:id", async (req, res) => {
  const { id } = req.params;

  // The id becomes an object key, so anything path-like has to be rejected before
  // it reaches R2 rather than sanitised afterwards.
  if (!/^[a-z0-9]+$/i.test(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  try {
    const image = await getObjectBytes(`screenshots/${id}.jpg`);
    if (!image) {
      res.status(404).json({ error: "no screenshot" });
      return;
    }

    res.set("Content-Type", "image/jpeg");
    res.set("X-Content-Type-Options", "nosniff");
    // A deployment id maps to one immutable build, so its screenshot can never
    // change: the browser should never ask for it twice.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(image);
  } catch (e) {
    console.error(`502 serving screenshots/${id}.jpg:`, e instanceof Error ? e.message : e);
    res.status(502).send("Upstream storage error");
  }
});

app.delete("/deployments/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const { id } = req.params;

  // ROW FIRST — this is a reversal of the original order, and the reason matters.
  //
  // It used to sweep R2 first, so that a failed object delete could not orphan
  // files nobody references. That was the right trade while one person owned every
  // deployment: the worst case was paying for a few stray objects.
  //
  // With owners, sweeping first means any signed-in user could pass someone else's
  // id and destroy their site's files BEFORE the ownership check ever ran — the
  // guarded DELETE would then correctly refuse, long after the damage. Deleting the
  // row first makes this single statement both the authorization check and the
  // claim: no row, no sweep. The orphan risk returns, but leaked storage costs
  // pennies and is recoverable; another tenant's deleted site is neither.
  // A project's current production deployment is refused rather than deleted:
  // the FK would clear the pointer and the stable URL would go dark with nothing
  // to fall back to. Promote or roll back first, then delete.
  const removed = await deleteDeployment(id, userId);
  if (!removed) {
    if (await isProductionDeployment(id, userId)) {
      res.status(409).json({
        error: "This deployment is what the project's URL serves. Promote or roll back to another one first.",
      });
      return;
    }
    res.status(404).json({ error: "no such deployment", objectsDeleted: 0 });
    return;
  }

  // The row is gone, which is what was asked for. The sweep that follows is
  // reported honestly: a storage refusal is logged and answered as swept: false,
  // never as a count that claims a clean sweep.
  let objects = 0;
  try {
    objects += await deletePrefix(`output/${id}/`);
    objects += await deletePrefix(`dist/${id}/`);
    // The screenshot is a single object, not a folder, so it needs its own sweep —
    // "screenshots/{id}." keeps the prefix anchored to this id and cannot match
    // "screenshots/{id}2.jpg" the way a bare id would.
    objects += await deletePrefix(`screenshots/${id}.`);
  } catch (e) {
    console.error(`delete ${id}: sweep failed:`, e instanceof Error ? e.message : e);
    res.json({ id, objectsDeleted: objects, swept: false });
    return;
  }
  res.json({ id, objectsDeleted: objects, swept: true });
});

// No route matched: JSON, like everything else this API says.
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "not found" });
});

// Whatever a parser rejects (a body too large, malformed JSON) or a handler throws
// ends here, answered as JSON like every other error — never Express's HTML page.
// A parser's error carries its status and a message safe to expose; anything
// else is a 500 with the detail in the log only.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { status?: number; expose?: boolean; message?: string; name?: string };
  // The database not answering is not a bug in the route: it is a retry, said so.
  if (e.name === "NeonDbError") {
    console.error("database error in a route:", e.message);
    res.set("Retry-After", "5");
    res.status(503).json({ error: "The database did not answer; try again in a moment." });
    return;
  }
  const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500) console.error("unhandled route error:", err instanceof Error ? err.stack ?? err.message : err);
  res.status(status).json({ error: status >= 500 ? "internal error" : (e.expose && e.message) || "bad request" });
});

async function main() {
  // Fail at boot, not on the first click: a partly configured App (two variables
  // of three) throws here with the variable names, instead of a 500 per request.
  const github = githubAppConfig();
  console.log(
    github
      ? `GitHub App ${github.slug} (id ${github.appId}) configured`
      : "GitHub App not configured: public repository URLs only"
  );
  console.log(
    process.env.GITHUB_WEBHOOK_SECRET
      ? "push receiver enabled at /webhooks/github"
      : "push receiver disabled: GITHUB_WEBHOOK_SECRET not set"
  );
  await ensureTempRoot();
  await housekeeping();
  setInterval(housekeeping, 10 * 60_000).unref();
  await publisher.connect();
  // A dead ingest loop would leave every deploy queued forever with the service
  // still answering; exiting lets the supervisor restart the whole process.
  void startIngestLoop().catch((e) => {
    console.error("ingest loop died:", e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
  app.listen(3000);
}

main();
