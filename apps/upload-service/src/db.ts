import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import {
  required,
  type Deployment,
  type DeploymentState,
  type DeploymentTrigger,
  type Project,
} from "@vercel-clone/shared";

export const sql = neon(required("NEON_DB"));

// Re-exported so existing importers of "./db" keep working; the shapes themselves
// live in the shared package, where the dashboard reads the same definitions.
export type { Deployment, DeploymentState, Project };

/**
 * Every function below that acts for a user puts the userId in the WHERE clause.
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

function toProject(row: Record<string, unknown>): Project {
  return {
    ...(row as unknown as Project),
    installation_id: row.installation_id == null ? null : Number(row.installation_id),
  };
}

// ---- Deployments ---------------------------------------------------------------------

export interface NewDeployment {
  id: string;
  projectId: string;
  repoUrl: string;
  userId: string;
  buildEnv: Record<string, string> | null;
  installationId: number | null;
  repoFullName: string | null;
  /** Branch to build; null means the remote's default, resolved by the clone. */
  gitRef: string | null;
  /** Commit expected at the tip (from a push event); null when unknown. */
  gitSha: string | null;
  trigger: DeploymentTrigger;
}

// Reserving the id IS the collision check: a duplicate id makes the insert
// return no rows rather than silently overwriting another deployment. The id
// must not equal a project slug either: the request handler resolves a hostname
// label as a slug first, so such a deployment's URL would serve another site.
export async function createDeployment(d: NewDeployment): Promise<boolean> {
  const rows = await sql`
    INSERT INTO deployments
      (id, project_id, repo_url, state, user_id, build_env, installation_id, repo_full_name, git_ref, git_sha, trigger)
    SELECT
      ${d.id}, ${d.projectId}, ${d.repoUrl}, 'queued', ${d.userId},
      ${d.buildEnv ? JSON.stringify(d.buildEnv) : null}::jsonb,
      ${d.installationId}::bigint, ${d.repoFullName}, ${d.gitRef}, ${d.gitSha}, ${d.trigger}
     WHERE NOT EXISTS (SELECT 1 FROM projects WHERE slug = ${d.id})
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

/**
 * What the clone actually checked out, recorded as soon as it is known. Guarded
 * on the ingest claim: false means the row is no longer ours (deleted meanwhile),
 * and the caller must stop rather than stage files for a deployment that is gone.
 */
export async function recordClone(id: string, sha: string, ref: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments SET git_sha = ${sha}, git_ref = ${ref}
     WHERE id = ${id} AND state = 'ingesting'
     RETURNING id
  `;
  return rows.length === 1;
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
// double-click deletes once and a guessed id deletes nothing. A project's current
// production deployment is never deleted here: the FK would clear the pointer and
// the site would go dark; the caller asks isProductionDeployment to tell the two
// refusals apart. The project row is locked first, so a promote committing at the
// same instant is waited for and its pointer is what the guard reads — a plain
// subquery would check a snapshot the promote then overtakes.
export async function deleteDeployment(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    WITH p AS (
      SELECT id, production_deployment_id FROM projects
       WHERE id = (SELECT project_id FROM deployments WHERE id = ${id} AND user_id = ${userId})
       FOR UPDATE
    )
    DELETE FROM deployments d USING p
     WHERE d.id = ${id} AND d.user_id = ${userId} AND d.project_id = p.id
       AND p.production_deployment_id IS DISTINCT FROM d.id
     RETURNING d.id
  `;
  return rows.length === 1;
}

/** Whether this user's deployment is what one of their projects serves as production. */
export async function isProductionDeployment(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 AS hit FROM projects p
      JOIN deployments d ON d.id = p.production_deployment_id
     WHERE d.id = ${id} AND d.user_id = ${userId}
  `;
  return rows.length === 1;
}

/** Deployments of this user that are waiting for, or inside, the ingest loop. */
export async function countPending(userId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*) AS n FROM deployments
     WHERE user_id = ${userId} AND state IN ('queued', 'ingesting')
  `;
  return Number(rows[0]?.n ?? 0);
}

// Only a deployment that has not reached a build worker can fail here — guarded
// so a worker that has already claimed the build is never overwritten by the
// ingest path.
export async function failQueued(id: string, message: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'failed', error_message = ${message}, finished_at = now()
     WHERE id = ${id} AND state IN ('queued', 'ingesting')
     RETURNING id
  `;
  return rows.length === 1;
}

/** Who owns a queued row, for the loop's per-user fairness; null unless still queued. */
export async function peekQueued(id: string): Promise<{ userId: string } | null> {
  const rows = await sql`SELECT user_id FROM deployments WHERE id = ${id} AND state = 'queued'`;
  return rows[0] ? { userId: String(rows[0].user_id) } : null;
}

/**
 * queued -> ingesting: the ingest loop's claim, with the row and its project in
 * one round trip. No row means it is not queued any more (canceled, deleted, or
 * claimed by another loop) and there is nothing to do.
 */
export async function claimForIngest(
  id: string
): Promise<{ deployment: Deployment; project: Project | null } | null> {
  const rows = await sql`
    WITH claimed AS (
      UPDATE deployments
         SET state = 'ingesting', ingesting_at = now()
       WHERE id = ${id} AND state = 'queued'
       RETURNING *
    )
    SELECT c.*, row_to_json(p) AS project
      FROM claimed c
      LEFT JOIN projects p ON p.id = c.project_id
  `;
  if (!rows[0]) return null;
  const { project, ...deployment } = rows[0] as Record<string, unknown> & { project: Record<string, unknown> | null };
  return { deployment: toDeployment(deployment), project: project ? toProject(project) : null };
}

/**
 * ingesting -> queued, once every file is in the bucket: the row now waits for a
 * build worker, and is cancelable again until one claims it. False means the row
 * was deleted during the upload; the caller sweeps what it staged.
 */
export async function stageForBuild(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments SET state = 'queued'
     WHERE id = ${id} AND state = 'ingesting'
     RETURNING id
  `;
  return rows.length === 1;
}

/**
 * A newer push supersedes every OLDER deployment of the project that nothing is
 * working on: the intermediate commits would be obsolete the moment they
 * finished. Only 'queued' rows qualify — an ingest or a build in progress is
 * never preempted — and only rows created before the kept one, so two deliveries
 * processed at the same time cannot cancel each other. Returns the canceled ids
 * so the caller can drop them from the queues and sweep anything they staged.
 */
export async function cancelQueuedBefore(projectId: string, keepId: string): Promise<string[]> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'canceled', error_message = 'superseded by a newer push', finished_at = now()
     WHERE project_id = ${projectId} AND state = 'queued' AND id <> ${keepId}
       AND created_at < (SELECT created_at FROM deployments WHERE id = ${keepId})
     RETURNING id
  `;
  return rows.map((r) => String(r.id));
}

/**
 * Build-time variables of the project's most recent deployment. A push or a
 * redeploy has no dialog to enter them in, so it inherits the last ones used;
 * project-level variables are the next step and would replace this.
 */
export async function latestBuildEnv(projectId: string): Promise<Record<string, string> | null> {
  const rows = await sql`
    SELECT build_env FROM deployments
     WHERE project_id = ${projectId}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return (rows[0]?.build_env as Record<string, string> | null) ?? null;
}

// ---- Projects ------------------------------------------------------------------------

/**
 * A project as the dashboard reads it: its newest deployment (the card's state
 * line), when its production deployment was created (so a row can be labelled
 * "promote" or "roll back" against the pointer itself, not against whatever page
 * of rows the client happens to hold), and the deployment an instant rollback
 * would restore — the newest deployed one older than production, or null.
 */
export interface ProjectSummary extends Project {
  production_created_at: string | null;
  rollback_to: string | null;
  latest: {
    id: string;
    state: DeploymentState;
    git_sha: string | null;
    trigger: DeploymentTrigger | null;
    created_at: string;
    finished_at: string | null;
    error_message: string | null;
  } | null;
}

function toSummary(row: Record<string, unknown>): ProjectSummary {
  const { latest, production_created_at, rollback_to, ...project } = row as Record<string, unknown> & {
    latest: ProjectSummary["latest"];
    production_created_at: string | null;
    rollback_to: string | null;
  };
  return {
    ...toProject(project),
    production_created_at: production_created_at ?? null,
    rollback_to: rollback_to ?? null,
    latest: latest ?? null,
  };
}

const SUMMARY = sql`
  LEFT JOIN LATERAL (
    SELECT id, state, git_sha, trigger, created_at, finished_at, error_message
      FROM deployments d
     WHERE d.project_id = p.id
     ORDER BY d.created_at DESC
     LIMIT 1
  ) l ON true
  LEFT JOIN deployments cur ON cur.id = p.production_deployment_id
  LEFT JOIN LATERAL (
    SELECT r.id
      FROM deployments r
     WHERE r.project_id = p.id AND r.state = 'deployed' AND r.created_at < cur.created_at
     ORDER BY r.created_at DESC
     LIMIT 1
  ) rb ON true
`;

export async function listProjects(userId: string, limit = 50): Promise<ProjectSummary[]> {
  const rows = await sql`
    SELECT p.*, row_to_json(l) AS latest, cur.created_at AS production_created_at, rb.id AS rollback_to
      FROM projects p
      ${SUMMARY}
     WHERE p.user_id = ${userId}
     ORDER BY p.created_at DESC
     LIMIT ${limit}
  `;
  return rows.map(toSummary);
}

export async function getProject(id: string, userId: string): Promise<ProjectSummary | null> {
  const rows = await sql`
    SELECT p.*, row_to_json(l) AS latest, cur.created_at AS production_created_at, rb.id AS rollback_to
      FROM projects p
      ${SUMMARY}
     WHERE p.id = ${id} AND p.user_id = ${userId}
  `;
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function listProjectDeployments(
  projectId: string,
  userId: string,
  limit = 50
): Promise<Deployment[]> {
  const rows = await sql`
    SELECT d.* FROM deployments d
      JOIN projects p ON p.id = d.project_id
     WHERE p.id = ${projectId} AND p.user_id = ${userId}
     ORDER BY d.created_at DESC
     LIMIT ${limit}
  `;
  return rows.map(toDeployment);
}

// Project ids: 8 characters from a 36-symbol alphabet, 41 bits — not the 5-char
// deployment id space, so the two cannot be confused by length alone.
function generateProjectId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * The hostname label of a project's production URL, from its repository name:
 * lower-case, [a-z0-9-] only, no leading or trailing dash, at most 40 characters.
 */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "site";
}

/**
 * Labels no project may own: the platform's own hostnames (the dashboard is
 * app.$DOMAIN; localhost is every local URL), the names RFC 2142 reserves for a
 * domain's mailboxes and services, and labels a probe or a future host would use.
 */
const RESERVED_LABELS = new Set([
  "app", "www", "api", "admin", "status", "healthz", "health", "localhost", "dashboard",
  "mail", "smtp", "imap", "pop", "pop3", "ftp", "ns", "ns1", "ns2", "ns3", "ns4", "dns", "mx",
  "hostmaster", "postmaster", "webmaster", "abuse", "noc", "security", "info", "support",
  "login", "auth", "sso", "oauth", "cdn", "static", "assets", "docs", "help", "console",
  // Client auto-discovery names: mail and proxy clients look these up on the domain
  // itself and would hand a tenant's page their credentials or proxy settings.
  "autodiscover", "autoconfig", "wpad", "isatap", "mta-sts", "openpgpkey",
]);

/**
 * A slug must be unique among projects, must not be a deployment id either (the
 * request handler resolves the first hostname label as a project slug first, then
 * as a deployment id, so a slug equal to an existing id would shadow it), and must
 * not be one of the platform's own labels.
 */
async function slugTaken(slug: string): Promise<boolean> {
  if (RESERVED_LABELS.has(slug)) return true;
  const rows = await sql`
    SELECT 1 AS hit FROM projects WHERE slug = ${slug}
    UNION ALL
    SELECT 1 FROM deployments WHERE id = ${slug}
    LIMIT 1
  `;
  return rows.length > 0;
}

export interface NewProject {
  userId: string;
  name: string;
  repoUrl: string;
  repoFullName: string | null;
  installationId: number | null;
}

/**
 * One project per (user, repository). A second import of the same repository
 * returns the existing project, upgrading it with an installation when the first
 * import was by public URL. Slugs are derived from the repository name and
 * suffixed on collision.
 */
export async function findOrCreateProject(p: NewProject): Promise<Project> {
  const existing = await sql`
    UPDATE projects
       SET installation_id = COALESCE(${p.installationId}, installation_id),
           repo_full_name = COALESCE(${p.repoFullName}, repo_full_name)
     WHERE user_id = ${p.userId} AND repo_url = ${p.repoUrl}
     RETURNING *
  `;
  if (existing[0]) return toProject(existing[0]);

  const base = slugify(p.name);
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (await slugTaken(slug)) continue;
    const rows = await sql`
      INSERT INTO projects (id, user_id, name, slug, repo_url, repo_full_name, installation_id)
      VALUES (${generateProjectId()}, ${p.userId}, ${p.name}, ${slug}, ${p.repoUrl}, ${p.repoFullName}, ${p.installationId})
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return toProject(rows[0]);
    // No conflict target, so BOTH unique constraints answer with zero rows: lost a
    // race on the slug, or on (user, repo). Re-check the latter and retry.
    const again = await sql`SELECT * FROM projects WHERE user_id = ${p.userId} AND repo_url = ${p.repoUrl}`;
    if (again[0]) return toProject(again[0]);
  }
  throw new Error(`could not find a free slug for ${p.name}`);
}

/**
 * A project's production branch is its repository's default branch, as last
 * observed: by a clone (which follows the remote's HEAD) or by a push event
 * (which names it). Renaming the default branch on GitHub therefore renames it
 * here on the next push or deploy, instead of freezing the first name forever.
 * Choosing a different branch by hand is a later feature.
 */
export async function setProductionBranch(projectId: string, branch: string): Promise<void> {
  await sql`
    UPDATE projects SET production_branch = ${branch}
     WHERE id = ${projectId} AND production_branch IS DISTINCT FROM ${branch}
  `;
}

/**
 * Points production at one of the project's deployed builds. The ownership and
 * "belongs to this project and is deployed" tests are the query. Promote and
 * rollback are the same operation, with one difference in what they leave
 * behind: moving the pointer BACK switches automatic promotion off, so the next
 * push cannot silently undo a rollback taken because the tip was broken; moving
 * it FORWARD switches it on again. (p.* in SET reads the row as it was.)
 */
export async function promoteDeployment(
  projectId: string,
  userId: string,
  deploymentId: string
): Promise<Project | null> {
  const rows = await sql`
    UPDATE projects p
       SET production_deployment_id = d.id,
           auto_promote = CASE
             WHEN p.production_deployment_id IS NULL THEN true
             WHEN d.created_at > (SELECT created_at FROM deployments WHERE id = p.production_deployment_id) THEN true
             WHEN d.created_at < (SELECT created_at FROM deployments WHERE id = p.production_deployment_id) THEN false
             ELSE p.auto_promote
           END
      FROM deployments d
     WHERE p.id = ${projectId} AND p.user_id = ${userId}
       AND d.id = ${deploymentId} AND d.project_id = p.id AND d.state = 'deployed'
     RETURNING p.*
  `;
  return rows[0] ? toProject(rows[0]) : null;
}

/**
 * Deletes a project and, by cascade, its deployments. Returns the deployment ids
 * that went with it so the caller can sweep their objects, or null when the
 * project was not this user's.
 */
export async function deleteProject(id: string, userId: string): Promise<string[] | null> {
  const rows = await sql`
    WITH gone AS (
      DELETE FROM projects WHERE id = ${id} AND user_id = ${userId} RETURNING id
    ),
    ids AS (
      SELECT d.id FROM deployments d WHERE d.project_id = ${id}
    )
    SELECT ids.id, (SELECT count(*) FROM gone) AS deleted FROM ids
    UNION ALL
    SELECT NULL AS id, (SELECT count(*) FROM gone) AS deleted
  `;
  // The UNION's trailing row carries the count even when the project had no
  // deployments; a count of 0 means the project was not ours.
  if (!rows.some((r) => Number(r.deleted) === 1)) return null;
  return rows.map((r) => r.id as string | null).filter((x): x is string => x !== null);
}

/**
 * Projects a push to the repository's default branch should deploy: connected
 * through the very installation GitHub delivered the event for, and the same
 * repository (GitHub logins are case-insensitive). The caller has already
 * established that the pushed branch IS the default branch; the payload names
 * it, so a renamed default keeps matching.
 *
 * The installation is the tenancy check. A repository name alone would match a
 * project someone else created by pasting the URL, and a push by the repository's
 * owner would then build (and re-point) a stranger's project — or, for a private
 * repository, tell that stranger the branch and every commit pushed. Projects added
 * by URL therefore never deploy on push; picking the repository in Connect GitHub
 * attaches the installation and turns pushes on.
 */
export async function findProjectsForPush(installationId: number, repoFullName: string): Promise<Project[]> {
  const rows = await sql`
    SELECT * FROM projects
     WHERE installation_id = ${installationId}
       AND lower(repo_full_name) = lower(${repoFullName})
  `;
  return rows.map(toProject);
}

// ---- GitHub App installations --------------------------------------------------------

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
 * installation's GitHub account id must equal an id the user signed in with.
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

/** GitHub says the installation is gone, whoever owned it (installation webhook). */
export async function deleteInstallationAnyOwner(installationId: number): Promise<number> {
  const rows = await sql`
    DELETE FROM github_installations WHERE installation_id = ${installationId} RETURNING installation_id
  `;
  return rows.length;
}

/**
 * Once an installation is gone on GitHub, no push will ever arrive for it: the
 * projects it connected go back to "not connected", so the dashboard says pushes
 * are off and picking the repository again attaches the new installation.
 */
export async function detachInstallationFromProjects(installationId: number): Promise<number> {
  const rows = await sql`
    UPDATE projects SET installation_id = NULL WHERE installation_id = ${installationId} RETURNING id
  `;
  return rows.length;
}
