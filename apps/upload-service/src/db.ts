import { neon } from "@neondatabase/serverless";
import { required, type Deployment, type DeploymentState } from "@vercel-clone/shared";

export const sql = neon(required("NEON_DB"));

// Re-exported so existing importers of "./db" keep working; the shape itself now
// lives in the shared package, where the dashboard reads the same definition.
export type { Deployment, DeploymentState };

/**
 * Every function below takes the caller's userId and puts it in the WHERE clause.
 *
 * The ownership test is the query, never an `if` around the query. A separate
 * "fetch, compare owner, then act" would leave a window between the check and the
 * act, and one forgotten branch silently exposes every other tenant's rows.
 * Zero rows affected IS "not yours" and "does not exist" — indistinguishable to the
 * caller on purpose, so the API cannot be used to probe which ids exist.
 */

// Postgres returns BIGINT as a string, because it can exceed what a JS number
// holds exactly. GitHub installation ids are far below that, so they are numbers
// everywhere in this codebase and converted at the one place rows come in.
function toDeployment(row: Record<string, unknown>): Deployment {
  return {
    ...(row as unknown as Deployment),
    installation_id: row.installation_id == null ? null : Number(row.installation_id),
  };
}

/** Where a deployment's source came from when it was chosen through the GitHub App. */
export interface DeploymentSource {
  installationId: number;
  repoFullName: string;
}

// Reserving the id IS the collision check: a duplicate id makes the insert
// return no rows rather than silently overwriting another deployment.
export async function createDeployment(
  id: string,
  repoUrl: string,
  userId: string,
  buildEnv: Record<string, string> | null,
  source: DeploymentSource | null = null
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO deployments (id, repo_url, state, user_id, build_env, installation_id, repo_full_name)
    VALUES (
      ${id}, ${repoUrl}, 'queued', ${userId},
      ${buildEnv ? JSON.stringify(buildEnv) : null}::jsonb,
      ${source?.installationId ?? null}, ${source?.repoFullName ?? null}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
  
}

/** The commit a clone checked out, recorded as soon as it is known. */
export async function recordCommit(id: string, sha: string): Promise<void> {
  await sql`UPDATE deployments SET git_sha = ${sha} WHERE id = ${id}`;
}

export async function getDeployment(id: string, userId: string): Promise<Deployment | null> {
  const rows = await sql`
    SELECT * FROM deployments WHERE id = ${id} AND user_id = ${userId}
  `;
  return rows[0] ? toDeployment(rows[0]) : null;
}

// Ordered + limited to match the (user_id, created_at DESC) index exactly, so this
// stays an index scan rather than a sort over every row the user owns.
export async function listDeployments(userId: string, limit = 20): Promise<Deployment[]> {
  const rows = await sql`
    SELECT * FROM deployments
     WHERE user_id = ${userId}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map(toDeployment);
}

// Returns false when the row was already gone OR belongs to someone else, so a
// double-click deletes once and a guessed id deletes nothing.
export async function deleteDeployment(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM deployments WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `;
  return rows.length === 1;
}

// Only a queued deployment can fail here — guarded so a worker that has already
// claimed the build is never overwritten by the ingest path.
export async function failQueued(id: string, message: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'failed', error_message = ${message}, finished_at = now()
     WHERE id = ${id} AND state = 'queued'
     RETURNING id
  `;
  return rows.length === 1;
}

// ---- GitHub App installations ------------------------------------------------

export interface GithubInstallationRow {
  installation_id: number;
  user_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  created_at: string;
}

function toInstallation(row: Record<string, unknown>): GithubInstallationRow {
  return {
    ...(row as unknown as GithubInstallationRow),
    installation_id: Number(row.installation_id),
  };
}

export interface GithubAccount {
  /** The GitHub user id, as Better Auth stores it (a numeric string). */
  accountId: string;
  /** The OAuth token from sign-in; null if the provider returned none. */
  accessToken: string | null;
}

/**
 * The GitHub identities this platform account signed in with, from Better Auth's
 * account table (one row per provider link), oldest first. Empty when the user has
 * only ever used Google: there is then no GitHub identity to tie an installation to.
 */
export async function getGithubAccounts(userId: string): Promise<GithubAccount[]> {
  const rows = await sql`
    SELECT "accountId", "accessToken" FROM account
     WHERE "userId" = ${userId} AND "providerId" = 'github'
     ORDER BY "createdAt"
  `;
  return rows.map((r) => ({
    accountId: String(r.accountId),
    accessToken: (r.accessToken as string | null) ?? null,
  }));
}

/**
 * Records that an installation belongs to a user. Callers prove that first: the
 * installation's GitHub account id must equal the id the user signed in with.
 * On conflict the row is overwritten, since the same proof was just repeated.
 */
export async function upsertInstallation(row: {
  installationId: number;
  userId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
}): Promise<void> {
  await sql`
    INSERT INTO github_installations
      (installation_id, user_id, account_login, account_type, repository_selection)
    VALUES
      (${row.installationId}, ${row.userId}, ${row.accountLogin}, ${row.accountType}, ${row.repositorySelection})
    ON CONFLICT (installation_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      account_login = EXCLUDED.account_login,
      account_type = EXCLUDED.account_type,
      repository_selection = EXCLUDED.repository_selection
  `;
}

export async function listInstallations(userId: string): Promise<GithubInstallationRow[]> {
  const rows = await sql`
    SELECT * FROM github_installations WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
  return rows.map(toInstallation);
}

// GitHub answered 404/403 for this installation: removed or suspended on their
// side. Dropping the row is what lets the dashboard offer "Connect" again.
export async function deleteInstallation(installationId: number, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM github_installations
     WHERE installation_id = ${installationId} AND user_id = ${userId}
     RETURNING installation_id
  `;
  return rows.length === 1;
}

// Ownership in the WHERE clause, as everywhere else: another user's installation
// id reads as "no such installation".
export async function getInstallation(
  installationId: number,
  userId: string
): Promise<GithubInstallationRow | null> {
  const rows = await sql`
    SELECT * FROM github_installations
     WHERE installation_id = ${installationId} AND user_id = ${userId}
  `;
  return rows[0] ? toInstallation(rows[0]) : null;
}
