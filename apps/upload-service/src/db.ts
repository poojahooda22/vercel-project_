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

// Reserving the id IS the collision check: a duplicate id makes the insert
// return no rows rather than silently overwriting another deployment.
export async function createDeployment(
  id: string,
  repoUrl: string,
  userId: string
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO deployments (id, repo_url, state, user_id)
    VALUES (${id}, ${repoUrl}, 'queued', ${userId})
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

export async function getDeployment(id: string, userId: string): Promise<Deployment | null> {
  const rows = await sql`
    SELECT * FROM deployments WHERE id = ${id} AND user_id = ${userId}
  `;
  return (rows[0] as Deployment) ?? null;
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
  return rows as Deployment[];
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
