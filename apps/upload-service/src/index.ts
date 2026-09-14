import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { generate } from "./utils";
import { deletePrefix, getObjectBytes, uploadFile } from "./aws";
import { getUserId, requireUser } from "./session";
import {
  BUILD_QUEUE,
  GithubApiError,
  createInstallationToken,
  createRedisClient,
  getAppInstallation,
  getAuthenticatedUser,
  getUserById,
  getUserInstallation,
  gitAuthConfig,
  githubAppConfig,
  installUrl,
  listInstallationRepos,
  type GithubAppConfig,
  type GithubInstallation,
} from "@vercel-clone/shared";
import {
  CloneError,
  CloneTimeoutError,
  EmptyRepoError,
  GitUnavailableError,
  RepoUnreadableError,
  TEMP_ROOT,
  canonicalGithubUrl,
  cloneRepo,
  ensureTempRoot,
  mapPool,
  objectKey,
  parseRepoFullName,
  walkTree,
  type GitConfigPair,
} from "./clone";
import {
  createDeployment,
  deleteDeployment,
  deleteInstallation,
  failQueued,
  getDeployment,
  getGithubAccounts,
  getInstallation,
  listDeployments,
  listInstallations,
  recordCommit,
  upsertInstallation,
  type DeploymentSource,
  type GithubAccount,
  type GithubInstallationRow,
} from "./db";

const publisher = createRedisClient("upload/publisher");

const app = express();

// The dashboard sends its session cookie, so the origin cannot be "*": the CORS
// spec forbids credentials with a wildcard origin, and browsers drop the response.
// In production the dashboard and this API share an origin behind Caddy and none of
// this applies — it exists for local dev, where they are :3002 and :3000.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3002";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

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

// Deploy bounds, Tier B on one box, with the arithmetic behind each number:
//   - at most MAX_IN_FLIGHT deploys hold a slot at once, and at most
//     MAX_IN_FLIGHT_PER_USER of them belong to one account, both reserved
//     synchronously before any await so a burst cannot slip past the check and
//     one signed-in account cannot hold every slot
//   - a clone is stopped past CLONE_WALL_CLOCK_MS, after CLONE_INACTIVITY_MS of
//     silence, or as soon as a two-second watchdog sees the checkout pass
//     MAX_REPO_FILES entries or 2 × MAX_REPO_BYTES counting the pack, or the
//     temp volume drop below MIN_FREE_DISK — so scratch usage stays near
//     MAX_IN_FLIGHT × 2 × MAX_REPO_BYTES plus one two-second write window per
//     clone
//   - uploads stream UPLOAD_POOL files at a time under one UPLOAD_WALL_CLOCK_MS
//     deadline, and the first failure cancels the rest, so memory per deploy is a
//     few chunks per stream and no work outlives its request
//   - a deploy is refused before it starts when the temp volume has less than
//     MIN_FREE_DISK left, so a full disk is a 503 to one caller, not an outage
// What breaks at the next tier: the bounds are per process. N instances need a
// shared admission counter, and a quota-limited scratch filesystem is the real
// answer to a repository that writes faster than any watchdog reads.
const CLONE_WALL_CLOCK_MS = 5 * 60_000;
const CLONE_INACTIVITY_MS = 60_000;
const UPLOAD_WALL_CLOCK_MS = 10 * 60_000;
const MAX_REPO_BYTES = 512 * 1024 * 1024;
const MAX_REPO_FILES = 20_000;
const MAX_IN_FLIGHT = 4;
const MAX_IN_FLIGHT_PER_USER = 2;
const MIN_FREE_DISK = 2 * 1024 * 1024 * 1024;
const UPLOAD_POOL = 8;

// What the client is told when an anonymous clone cannot read a repository. Never
// git's own text: it names container paths, and to an anonymous clone "private" and
// "does not exist" are the same answer, so the message must not claim to know which.
const REPO_UNREADABLE =
  "We can't read this repository: it is private, or the URL is wrong. " +
  "Private repositories deploy through Connect GitHub.";
const INSTALLATION_REMOVED =
  "Your GitHub installation was removed on GitHub. Connect GitHub again to pick repositories.";
const INSTALLATION_SUSPENDED =
  "Your GitHub installation is suspended on GitHub, so its repositories cannot be read.";

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
// clone is budgeted per user, so one signed-in account cannot burn either for
// everyone. In-process counters: correct for the one instance this service runs
// as (Tier B); N instances would need a shared store.
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

// ---- Deploy ----------------------------------------------------------------------

let inFlight = 0;
const inFlightByUser = new Map<string, number>();
// Scratch directories of deploys in progress: the sweeper must never touch these.
const liveDirs = new Set<string>();

async function freeDiskBytes(): Promise<number> {
  await ensureTempRoot();
  const s = await fs.promises.statfs(TEMP_ROOT);
  return Number(s.bavail) * Number(s.bsize);
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
  // with a one-hour token limited to that one repository; a pasted URL is cloned
  // anonymously, so it must be public. Both end in the same clone.
  let repoUrl: string;
  let gitConfig: GitConfigPair[] = [];
  let source: DeploymentSource | null = null;

  if (req.body?.repo !== undefined || req.body?.installationId !== undefined) {
    const cfg = githubAppConfig();
    if (!cfg) {
      res.status(400).json({ error: "GitHub App not configured on this server" });
      return;
    }
    const repo = parseRepoFullName(req.body?.repo);
    const installationId = Number(req.body?.installationId);
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
    // half must be the installation's account or the row would record a source that
    // was never granted. Logins can be renamed: on a mismatch the row is refreshed
    // from GitHub once before the request is refused.
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
    try {
      const { token } = await createInstallationToken(cfg, installationId, {
        repositories: [repo.name],
        permissions: { contents: "read" },
      });
      gitConfig = [gitAuthConfig(token)];
    } catch (e) {
      const gone = await installationGone(cfg, e, installationId);
      if (gone) {
        await forgetInstallation(installationId, userId);
        res.status(400).json({ error: gone === "suspended" ? INSTALLATION_SUSPENDED : INSTALLATION_REMOVED });
        return;
      }
      // 422: the repository is not part of this installation — never granted, or
      // removed on GitHub since the picker was loaded.
      if (e instanceof GithubApiError && e.status === 422) {
        res.status(400).json({
          error: "That repository is not part of your GitHub installation. Add it on GitHub and try again.",
        });
        return;
      }
      githubFailure(res, e, "requesting access to the repository");
      return;
    }
    repoUrl = `https://github.com/${installation.account_login}/${repo.name}`;
    source = { installationId, repoFullName: `${installation.account_login}/${repo.name}` };
  } else {
    const canonical = canonicalGithubUrl(req.body?.repoUrl);
    if (!canonical) {
      res.status(400).json({ error: "repoUrl must look like https://github.com/owner/repo" });
      return;
    }
    repoUrl = canonical;
  }

  // Admission. The slot is taken synchronously — no await between the check and
  // the increment — so a burst arriving inside one database round trip cannot all
  // pass; everything after this line releases it in `finally`.
  if (inFlight >= MAX_IN_FLIGHT) {
    res.set("Retry-After", "30");
    res.status(503).json({ error: "The server is busy with other deploys; try again in a moment." });
    return;
  }
  const mine = inFlightByUser.get(userId) ?? 0;
  if (mine >= MAX_IN_FLIGHT_PER_USER) {
    res.set("Retry-After", "30");
    res.status(429).json({ error: "You already have deploys in progress; wait for one to finish." });
    return;
  }
  inFlight++;
  inFlightByUser.set(userId, mine + 1);
  let id: string | null = null;
  let dir: string | null = null;
  try {
    // Too little disk to hold another clone is a 503 to this caller, not an
    // outage for everyone.
    let free: number;
    try {
      free = await freeDiskBytes();
    } catch (e) {
      console.error("deploy refused: could not read free disk:", e instanceof Error ? e.message : e);
      res.status(503).json({ error: "The server could not check its disk; try again later." });
      return;
    }
    if (free < MIN_FREE_DISK) {
      console.error("deploy refused: temp volume below the free-disk floor");
      res.set("Retry-After", "300");
      res.status(503).json({ error: "The server is low on disk; try again later." });
      return;
    }

    const deployId = generate();
    // Reserving the row is also the collision check — an id already in use returns
    // false here instead of overwriting someone else's deployment.
    if (!(await createDeployment(deployId, repoUrl, userId, buildEnv, source))) {
      res.status(409).json({ error: "id collision, retry" });
      return;
    }
    id = deployId;

    // From here on the row exists and must end terminal, the client must get exactly
    // one JSON answer, and the scratch directory must go — whatever throws.
    dir = await fs.promises.mkdtemp(path.join(TEMP_ROOT, "deploy-"));
    liveDirs.add(dir);
    const home = path.join(dir, "home");
    const repoDir = path.join(dir, "repo");
    await fs.promises.mkdir(home);

    let sha: string;
    try {
      ({ sha } = await cloneRepo(`${repoUrl}.git`, repoDir, {
        config: gitConfig,
        home,
        wallClockMs: CLONE_WALL_CLOCK_MS,
        inactivityMs: CLONE_INACTIVITY_MS,
        caps: {
          maxFiles: MAX_REPO_FILES,
          maxBytes: MAX_REPO_BYTES,
          lowDisk: async () => (await freeDiskBytes()) < MIN_FREE_DISK,
        },
      }));
    } catch (e) {
      // Each failure has a fixed sentence for the row and the caller; git's own text
      // goes to the log only.
      let message: string;
      let status = 400;
      if (e instanceof RepoUnreadableError) {
        message = source
          ? `GitHub refused access to ${source.repoFullName} through your installation. ` +
            "Check on GitHub that the app still has access to this repository."
          : REPO_UNREADABLE;
        console.error(`deploy ${id}: repository unreadable — ${lastFatalLine(e.stderr)}`);
      } else if (e instanceof CloneTimeoutError) {
        if (e.kind === "size") {
          message = `This repository is larger than ${MAX_REPO_BYTES / 1048576} MB, which is more than this platform builds.`;
        } else if (e.kind === "files") {
          message = `This repository has more than ${MAX_REPO_FILES} files, which is more than this platform builds.`;
        } else if (e.kind === "disk") {
          message = "The server ran low on disk during the clone; try again later.";
          status = 503;
        } else {
          message = "Cloning took too long and was stopped.";
          status = 504;
        }
        console.error(`deploy ${id}: clone stopped (${e.kind})`);
      } else if (e instanceof EmptyRepoError) {
        message = "This repository has no commits yet.";
      } else if (e instanceof GitUnavailableError) {
        message = "internal error";
        status = 500;
        console.error(`deploy ${id}: ${e.message}`);
      } else {
        message = "git clone failed";
        const stderr = e instanceof CloneError ? e.stderr : e instanceof Error ? e.message : String(e);
        console.error(`deploy ${id}: git clone failed\n${stderr}`);
      }
      await failQueued(id, message);
      res.status(status).json({ id, error: message });
      return;
    }
    await recordCommit(id, sha);

    const tree = await walkTree(repoDir, { maxFiles: MAX_REPO_FILES, maxBytes: MAX_REPO_BYTES });
    // The walker excludes the repository's own store; a path with a .git segment in
    // the artifact set would mean that filter broke, and it must not reach the bucket.
    if (tree.files.some((f) => path.relative(repoDir, f).split(path.sep).includes(".git"))) {
      throw new Error("a .git path survived the artifact walk");
    }
    if (tree.over) {
      const message =
        tree.over === "files"
          ? `This repository has more than ${MAX_REPO_FILES} files; the limit is ${MAX_REPO_FILES}.`
          : `This repository is larger than ${MAX_REPO_BYTES / 1048576} MB after checkout; ` +
            `the limit is ${MAX_REPO_BYTES / 1048576} MB.`;
      await failQueued(id, message);
      res.status(400).json({ id, error: message });
      return;
    }

    // One deadline for the whole upload phase; the pool cancels every in-flight
    // PUT on the first failure, and a failed deploy leaves no objects behind.
    const deadline = AbortSignal.timeout(UPLOAD_WALL_CLOCK_MS);
    try {
      await mapPool(
        tree.files,
        UPLOAD_POOL,
        (file, signal) => uploadFile(objectKey(deployId, repoDir, file), file, signal),
        deadline
      );
    } catch (e) {
      const timedOut = deadline.aborted;
      const message = timedOut ? "Uploading took too long and was stopped." : "upload to storage failed";
      console.error(`deploy ${id}: ${message}:`, e instanceof Error ? e.message : e);
      await failQueued(id, message);
      await deletePrefix(`output/${id}/`).catch((err) =>
        console.error(`deploy ${id}: could not remove partial upload:`, err instanceof Error ? err.message : err)
      );
      // Storage is the platform's problem, not the caller's: 5xx, not 400.
      res.status(timedOut ? 504 : 502).json({ id, error: message });
      return;
    }
  } catch (e) {
    // Anything not handled above: the row still ends terminal and the client still
    // gets JSON, not Express's HTML page.
    console.error(`deploy ${id ?? "(no row)"}: internal error:`, e instanceof Error ? e.stack ?? e.message : e);
    if (id) await failQueued(id, "internal error").catch(() => {});
    if (!res.headersSent) res.status(500).json({ id, error: "internal error" });
    return;
  } finally {
    inFlight--;
    const left = (inFlightByUser.get(userId) ?? 1) - 1;
    if (left <= 0) inFlightByUser.delete(userId);
    else inFlightByUser.set(userId, left);
    // Cleanup must never change the response or the row: a locked file on Windows
    // is logged and left for the sweeper.
    if (dir) {
      liveDirs.delete(dir);
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e);
        console.error(`deploy ${id}: temp dir not removed (${code}); the sweeper will reclaim it`);
      }
    }
  }

  // Enqueue only after every file is durably in the bucket: the queue message is
  // a pointer, and publishing it early makes the worker build a partial tree.
  //
  // This needs its own catch. Unguarded, a Redis outage escapes to Express's
  // default error handler, which answers an HTML page — the caller asked for JSON
  // and gets "Unexpected token '<'", which says nothing about Redis. Worse, the
  // row stays 'queued' with no worker coming for it and no reason recorded.
  try {
    await publisher.lPush(BUILD_QUEUE, id);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await failQueued(id, `could not enqueue build: ${reason}`);
    res.status(503).json({
      id,
      error: "queue unavailable — files uploaded but the build was not scheduled",
      detail: reason,
    });
    return;
  }

  res.json({ id: id });
});

/** git's last "fatal:" line, or the whole text when there is none. For logs only. */
function lastFatalLine(stderr: string): string {
  const fatal = stderr.split("\n").filter((l) => l.startsWith("fatal:"));
  return (fatal[fatal.length - 1] ?? stderr).trim();
}

// ---- Housekeeping ------------------------------------------------------------------
//
// `finally` removes the scratch directory on every in-process path. A process
// killed mid-deploy (OOM, SIGKILL) is the gap: its directory stays in the writable
// layer across restarts. Directories under the service-owned TEMP_ROOT that no
// running deploy owns and that are older than a whole deploy could take are
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
  const removed = await deleteDeployment(id, userId);
  if (!removed) {
    res.status(404).json({ error: "no such deployment", objectsDeleted: 0 });
    return;
  }

  const staged = await deletePrefix(`output/${id}/`);
  const built = await deletePrefix(`dist/${id}/`);
  // The screenshot is a single object, not a folder, so it needs its own sweep —
  // "screenshots/{id}." keeps the prefix anchored to this id and cannot match
  // "screenshots/{id}2.jpg" the way a bare id would.
  const shots = await deletePrefix(`screenshots/${id}.`);

  res.json({ id, objectsDeleted: staged + built + shots });
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
  await ensureTempRoot();
  await housekeeping();
  setInterval(housekeeping, 10 * 60_000).unref();
  await publisher.connect();
  app.listen(3000);
}

main();
