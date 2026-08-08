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

// queued -> building. The WHERE clause is the claim: if another worker already
// took this deployment, no row matches and we skip it instead of double-building.
export async function claimDeployment(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'building', building_at = now()
     WHERE id = ${id} AND state = 'queued'
     RETURNING id
  `;
  return rows.length === 1;
}

// building -> deployed. Guarded so a reaper that already requeued this build
// cannot be overwritten by the worker it gave up on.
export async function markDeployed(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'deployed', finished_at = now()
     WHERE id = ${id} AND state = 'building'
     RETURNING id
  `;
  return rows.length === 1;
}

// building -> failed, carrying the reason so /status can explain itself.
export async function markFailed(id: string, message: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'failed', error_message = ${message}, finished_at = now()
     WHERE id = ${id} AND state = 'building'
     RETURNING id
  `;
  return rows.length === 1;
}
