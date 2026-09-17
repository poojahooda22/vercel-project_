import { neon } from "@neondatabase/serverless";
import { required } from "@vercel-clone/shared";

export const sql = neon(required("NEON_DB"));

// queued -> building. The WHERE clause is the claim: if another worker already
// took this deployment, no row matches and we skip it instead of double-building.
// The claim also carries back the deployer's build-time env, so the build needs
// no second round-trip and cannot read a row it does not own.
export async function claimDeployment(
  id: string
): Promise<{ claimed: boolean; buildEnv: Record<string, string> | null }> {
  const rows = await sql`
    UPDATE deployments
       SET state = 'building', building_at = now()
     WHERE id = ${id} AND state = 'queued'
     RETURNING id, build_env
  `;
  if (rows.length !== 1) return { claimed: false, buildEnv: null };
  return { claimed: true, buildEnv: (rows[0].build_env as Record<string, string> | null) ?? null };
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

/**
 * Moves the project's production pointer to this deployment, if it is a build of
 * the production branch, newer than what production currently serves, and the
 * project still promotes automatically. Newest wins, so two builds finishing out
 * of order cannot leave an older one live. A rollback switches auto_promote off
 * (the upload service does that), so a push cannot silently undo it.
 */
export async function promoteIfNewer(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE projects p
       SET production_deployment_id = d.id
      FROM deployments d
     WHERE d.id = ${id}
       AND p.id = d.project_id
       AND d.state = 'deployed'
       AND p.auto_promote
       AND (p.production_branch IS NULL OR d.git_ref IS NULL OR d.git_ref = p.production_branch)
       AND (
         p.production_deployment_id IS NULL
         OR d.created_at > (SELECT created_at FROM deployments WHERE id = p.production_deployment_id)
       )
     RETURNING p.id
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
