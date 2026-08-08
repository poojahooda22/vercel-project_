import { neon } from "@neondatabase/serverless";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env, then start with "npm run dev".`
    );
  }
  return value;
}

export const sql = neon(required("NEON_DB"));

export type DeploymentState = "queued" | "building" | "deployed" | "failed";

export interface Deployment {
  id: string;
  repo_url: string;
  state: DeploymentState;
  error_message: string | null;
  created_at: string;
  building_at: string | null;
  finished_at: string | null;
}

// Reserving the id IS the collision check: a duplicate id makes the insert
// return no rows rather than silently overwriting another deployment.
export async function createDeployment(id: string, repoUrl: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO deployments (id, repo_url, state)
    VALUES (${id}, ${repoUrl}, 'queued')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const rows = await sql`SELECT * FROM deployments WHERE id = ${id}`;
  return (rows[0] as Deployment) ?? null;
}

export async function listDeployments(limit = 20): Promise<Deployment[]> {
  const rows = await sql`
    SELECT * FROM deployments ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows as Deployment[];
}

// Returns false when the row was already gone, so a double-click deletes once.
export async function deleteDeployment(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM deployments WHERE id = ${id} RETURNING id`;
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
