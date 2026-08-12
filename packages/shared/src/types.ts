/**
 * The deployment lifecycle, shared so the services and the dashboard cannot
 * disagree about what states exist.
 *
 *   queued   -> the row exists and the id is reserved; files are in R2
 *   building -> a worker has claimed it
 *   deployed -> the build exited 0 and its output is uploaded  (terminal)
 *   failed   -> carries the reason in error_message            (terminal)
 *
 * Only a worker moves a deployment out of 'queued', and every transition is a
 * guarded UPDATE, so two workers cannot both claim the same build.
 */
export type DeploymentState = "queued" | "building" | "deployed" | "failed";

/**
 * A row of the deployments table. snake_case because these come straight back
 * from Postgres and renaming them in transit would mean two names for one field.
 */
export interface Deployment {
  id: string;
  repo_url: string;
  state: DeploymentState;
  error_message: string | null;
  created_at: string;
  building_at: string | null;
  finished_at: string | null;
  /** When the screenshot was captured; null means there is not one. */
  screenshot_at: string | null;
  /** Owner. Nullable only for rows created before ownership existed. */
  user_id: string | null;
  /**
   * Build-time environment variables the deployer supplied in the upload
   * dialog. Injected only into this deployment's build child process; null
   * means none were given. Stored plaintext — do not echo back to clients.
   */
  build_env: Record<string, string> | null;
}
