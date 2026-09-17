/**
 * The deployment lifecycle, shared so the services and the dashboard cannot
 * disagree about what states exist.
 *
 *   queued    -> the row exists and the id is reserved; waiting for the ingest
 *                loop (nothing staged yet) or, after ingest, for a build worker
 *   ingesting -> the ingest loop has claimed it: clone and stage in progress
 *   building  -> a worker has claimed it
 *   deployed  -> the build exited 0 and its output is uploaded  (terminal)
 *   failed    -> carries the reason in error_message            (terminal)
 *   canceled  -> superseded by a newer push while still queued   (terminal)
 *
 * Every transition is a guarded UPDATE with the expected state in its WHERE
 * clause, so two loops cannot both claim the same row, and a cancel can only
 * land on a row nothing is working on.
 */
export type DeploymentState = "queued" | "ingesting" | "building" | "deployed" | "failed" | "canceled";

/** How a deployment came to exist. */
export type DeploymentTrigger = "manual" | "webhook" | "rollback";

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
  /** When the ingest loop claimed it; null until then. */
  ingesting_at: string | null;
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
  /** GitHub App installation the source was read through; null for a public URL. */
  installation_id: number | null;
  /** "owner/name" when deployed through the App; null for a public URL. */
  repo_full_name: string | null;
  /** The commit that was built. Null only for rows created before this existed. */
  git_sha: string | null;
  /** The project this deployment belongs to. Null only for rows older than projects. */
  project_id: string | null;
  /** Branch that was built, e.g. "main". */
  git_ref: string | null;
  trigger: DeploymentTrigger | null;
}

/**
 * A project is one repository. It owns many deployments, each frozen at its own
 * URL, and one production pointer: the deployment its stable `{slug}.domain`
 * hostname serves. Promote and rollback change the pointer, never the files.
 */
export interface Project {
  id: string;
  user_id: string;
  name: string;
  /** Hostname label of the production URL. Unique across the platform. */
  slug: string;
  repo_url: string;
  /** "owner/name" when connected through the GitHub App; used to match pushes. */
  repo_full_name: string | null;
  installation_id: number | null;
  /** The branch whose pushes deploy to production. Null until the first deploy resolves it. */
  production_branch: string | null;
  production_deployment_id: string | null;
  /**
   * Whether a successful build of the production branch moves the pointer by
   * itself. A rollback turns this off, so a push cannot silently undo it;
   * promoting a newer deployment turns it back on.
   */
  auto_promote: boolean;
  created_at: string;
}

/** Job on the ingest queue: the deployment to clone and stage. */
export const INGEST_QUEUE = "ingest-queue";
