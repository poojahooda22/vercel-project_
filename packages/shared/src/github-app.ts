import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * The GitHub App is how a private repository becomes readable: the user installs
 * the App on the repos they choose, and each clone borrows a one-hour token for
 * exactly one of them. Nothing long-lived is stored, and the token never goes in a
 * URL — git prints URLs in some errors and this platform stores those errors.
 *
 * Every endpoint and claim here was read from docs.github.com on 2026-09-10/11:
 *   - JWT: RS256, `iat` 60 s in the past, `exp` at most 10 min ahead, `iss` = App ID
 *   - GET  /app/installations/{id}                          (JWT)
 *   - GET  /users/{username}/installation                   (JWT; 404 = not installed
 *          — the docs list only the 200 case, the 404 is observed behaviour)
 *   - GET  /user                                            (the user's own OAuth token,
 *          5,000/h per token) and GET /user/{account_id}    (public, 60/h per IP —
 *          fallback only)
 *   - POST /app/installations/{id}/access_tokens             (JWT → 1 h token,
 *          optionally limited to named repositories and permissions)
 *   - GET  /installation/repositories                        (installation token)
 * The clone header shape is the one actions/checkout uses in production
 * (src/git-auth-helper.ts: `http.<origin>/.extraheader` = `AUTHORIZATION: basic
 * base64("x-access-token:" + token)`); the clone module delivers it through
 * GIT_CONFIG_* variables so it never touches disk or the process arguments.
 */

export interface GithubAppConfig {
  appId: string;
  slug: string;
  privateKey: KeyObject;
}

export interface GithubInstallation {
  id: number;
  account: { id: number; login: string; type: string };
  repository_selection: "all" | "selected";
  /** Set while the installation is suspended; tokens cannot be minted for it. */
  suspended_at: string | null;
}

export interface GithubRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

export class GithubApiError extends Error {
  /** Seconds GitHub asked us to wait, when it said (Retry-After); null otherwise. */
  public readonly retryAfterSec: number | null;
  /** X-RateLimit-Remaining, when present. 0 means the primary limit is exhausted. */
  public readonly remaining: number | null;
  /** X-RateLimit-Reset (epoch seconds), when present: when the primary limit refills. */
  public readonly resetEpoch: number | null;

  constructor(
    public readonly status: number,
    public readonly path: string,
    detail: string,
    headers?: Headers
  ) {
    super(`GitHub API ${status} on ${path}: ${detail}`);
    this.name = "GithubApiError";
    const retry = headers?.get("retry-after");
    this.retryAfterSec = retry && /^\d+$/.test(retry) ? Number(retry) : null;
    const remaining = headers?.get("x-ratelimit-remaining");
    this.remaining = remaining && /^\d+$/.test(remaining) ? Number(remaining) : null;
    const reset = headers?.get("x-ratelimit-reset");
    this.resetEpoch = reset && /^\d+$/.test(reset) ? Number(reset) : null;
  }

  /**
   * Seconds a caller should wait: Retry-After when GitHub sent one, else the time
   * to the primary limit's reset when that limit is exhausted, else a minute.
   */
  backoffSec(): number {
    if (this.retryAfterSec !== null) return Math.max(1, this.retryAfterSec);
    if (this.remaining === 0 && this.resetEpoch !== null) {
      return Math.max(1, this.resetEpoch - Math.floor(Date.now() / 1000));
    }
    return 60;
  }

  /**
   * GitHub's abuse-protection answer: a platform-wide backoff, not a per-request
   * fault. The headers are the documented signal; the body text is the fallback.
   */
  get rateLimited(): boolean {
    if (this.status === 429) return true;
    if (this.status !== 403) return false;
    return this.retryAfterSec !== null || this.remaining === 0 || /rate limit/i.test(this.message);
  }
}

let cached: GithubAppConfig | null | undefined;

/**
 * Reads the App's identity from the environment, once.
 *
 * Returns null when none of the three variables are set, so a deployment that has
 * not registered an App still boots and falls back to public URLs. Throws when only
 * some are set: a half-configured App is a mistake, and failing at boot beats a 500
 * on the day someone clicks Connect.
 *
 * The private key GitHub issues is PKCS#1 ("BEGIN RSA PRIVATE KEY"), and it is
 * stored base64-encoded because env files hold one line per value.
 */
export function githubAppConfig(): GithubAppConfig | null {
  if (cached !== undefined) return cached;
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG;
  const keyBase64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  const present = [appId, slug, keyBase64].filter(Boolean).length;
  if (present === 0) {
    cached = null;
    return cached;
  }
  if (present !== 3) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_PRIVATE_KEY_BASE64 must be set together"
    );
  }
  const pem = Buffer.from(keyBase64!, "base64").toString("utf8");
  cached = { appId: appId!, slug: slug!, privateKey: createPrivateKey(pem) };
  return cached;
}

/** Where a user goes to install the App on their account and pick repositories. */
export function installUrl(cfg: GithubAppConfig): string {
  return `https://github.com/apps/${cfg.slug}/installations/new`;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A JWT that identifies the App itself, valid for nine minutes. RS256 is
 * RSASSA-PKCS1-v1_5 with SHA-256, which is what node's `sign` produces for an RSA
 * key with default padding — no JWT library needed, and nothing to keep patched.
 */
export function appJwt(cfg: GithubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: cfg.appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), cfg.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const API = "https://api.github.com";
// A GitHub brown-out must not hold a request open for undici's five-minute default.
const API_TIMEOUT_MS = 10_000;

async function github<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects requests without one.
    "User-Agent": "vercel-clone",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // GitHub's error bodies name the problem ("Not Found", "Resource not accessible
    // by integration", "API rate limit exceeded"). Short, and never containing a token.
    throw new GithubApiError(res.status, path, body.slice(0, 300), res.headers);
  }
  return (await res.json()) as T;
}

/** One installation by id. 404 means it is not an installation of THIS App. */
export function getAppInstallation(
  cfg: GithubAppConfig,
  installationId: number
): Promise<GithubInstallation> {
  return github<GithubInstallation>(`/app/installations/${installationId}`, appJwt(cfg));
}

/**
 * The App's installation on one user account, or null when there is none. A
 * constant-cost lookup; never enumerate every installation to find one.
 */
export async function getUserInstallation(
  cfg: GithubAppConfig,
  login: string
): Promise<GithubInstallation | null> {
  try {
    return await github<GithubInstallation>(
      `/users/${encodeURIComponent(login)}/installation`,
      appJwt(cfg)
    );
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * The login behind a user's own OAuth token — the token the sign-in flow stored.
 * Spends that user's 5,000/h allowance, not a shared one.
 */
export function getAuthenticatedUser(
  userToken: string
): Promise<{ id: number; login: string; type: string }> {
  return github<{ id: number; login: string; type: string }>("/user", userToken);
}

/**
 * Public profile for a GitHub account id. Unauthenticated, so it draws on a 60/h
 * allowance shared by everything behind this server's IP: the fallback for a user
 * whose stored token no longer works, never the first choice.
 */
export function getUserById(accountId: string): Promise<{ id: number; login: string; type: string }> {
  return github<{ id: number; login: string; type: string }>(
    `/user/${encodeURIComponent(accountId)}`,
    null
  );
}

/**
 * A one-hour token for an installation. `repositories` takes repository NAMES (not
 * owner/name) and narrows the token to those; `permissions` narrows it further.
 * A clone asks for exactly one repository and contents:read, so a leaked token is
 * worth one read of one repo for one hour; a listing asks for metadata only.
 */
export async function createInstallationToken(
  cfg: GithubAppConfig,
  installationId: number,
  scope: { repositories?: string[]; permissions?: Record<string, string> } = {}
): Promise<{ token: string; expires_at: string }> {
  return github<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    appJwt(cfg),
    { method: "POST", body: JSON.stringify(scope), headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Repositories an installation may read. Capped at 500 so one account with
 * thousands of repos cannot hold a request open; the cap is logged, not silent.
 */
export async function listInstallationRepos(installationToken: string): Promise<GithubRepo[]> {
  const all: GithubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github<{ total_count: number; repositories: GithubRepo[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      installationToken
    );
    all.push(...batch.repositories);
    if (all.length >= batch.total_count || batch.repositories.length < 100) return all;
  }
  console.warn(`listInstallationRepos: returned the first ${all.length} repositories; more exist`);
  return all;
}

/**
 * The runtime git config entry that makes `git clone https://github.com/…`
 * authenticate: the actions/checkout header form. The clone module places it in
 * the child's GIT_CONFIG_* variables, so it is never in the URL, argv, or a file.
 */
export function gitAuthConfig(installationToken: string): { key: string; value: string } {
  const basic = Buffer.from(`x-access-token:${installationToken}`, "utf8").toString("base64");
  return { key: "http.https://github.com/.extraheader", value: `AUTHORIZATION: basic ${basic}` };
}
