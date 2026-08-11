import { neon } from "@neondatabase/serverless";
import { required } from "@vercel-clone/shared";

export const sql = neon(required("NEON_DB"));

/**
 * Record that a screenshot now exists for this deployment.
 *
 * Guarded on state = 'deployed' so a capture that finishes after the row was
 * deleted, or after a reaper moved the deployment on, writes nothing. Returns
 * false in that case, which the worker logs rather than treats as an error —
 * the deployment is the source of truth, the screenshot is decoration.
 */
export async function markScreenshot(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE deployments
       SET screenshot_at = now()
     WHERE id = ${id} AND state = 'deployed'
     RETURNING id
  `;
  return rows.length === 1;
}
