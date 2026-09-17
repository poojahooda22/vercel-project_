import { UPLOAD_SERVICE } from "./config";
import { withSession, type Deployment, type State, type Trigger } from "./deployments";

export type { Trigger };

/** The newest deployment of a project, as the list endpoint summarises it. */
export interface ProjectLatest {
  id: string;
  state: State;
  git_sha: string | null;
  trigger: Trigger | null;
  created_at: string;
  finished_at: string | null;
  error_message: string | null;
}

/** One repository. It has many immutable deployments and one production
 *  pointer: the deployment its stable URL serves. */
export interface Project {
  id: string;
  /** The repository name, e.g. "personal-website". */
  name: string;
  /** Hostname label of the stable URL; see projectUrl(). */
  slug: string;
  repo_url: string;
  /** "owner/name" when connected through the GitHub App; null for a public URL. */
  repo_full_name: string | null;
  installation_id: number | null;
  /** The branch pushes deploy from; null until the first deploy resolves it. */
  production_branch: string | null;
  /** What the stable URL serves; null until a build has succeeded. */
  production_deployment_id: string | null;
  /** False after a rollback: pushes build but do not move the stable URL until a
   *  newer deployment is promoted by hand. */
  auto_promote: boolean;
  created_at: string;
  /** When the production deployment was created; null while there is none. The
   *  server sends it so a row can be labelled against the pointer itself rather
   *  than against whichever page of rows this client holds. */
  production_created_at: string | null;
  /** The deployment an instant rollback restores (the newest deployed one older
   *  than production), computed by the server over the whole history; null when
   *  nothing is in production yet or nothing deployed preceded it. */
  rollback_to: string | null;
  latest: ProjectLatest | null;
}

export interface ProjectPage {
  project: Project;
  /** Newest first. */
  deployments: Deployment[];
}

// The server explains every refusal with { error }; the status code is the
// fallback for a proxy or a crash that answers with something else.
async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  return new Error(body.error ?? `${what} (${res.status})`);
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${UPLOAD_SERVICE}/projects`, withSession);
  if (!res.ok) throw await failure(res, "projects");
  return (await res.json()).projects ?? [];
}

export async function getProject(id: string): Promise<ProjectPage> {
  const res = await fetch(`${UPLOAD_SERVICE}/projects/${encodeURIComponent(id)}`, withSession);
  if (!res.ok) throw await failure(res, "project");
  const body = await res.json();
  return { project: body.project, deployments: body.deployments ?? [] };
}

/** Builds the production branch again. Resolves to the new deployment's id as
 *  soon as it is queued; progress shows up through the project's own list. */
export async function redeployProject(id: string): Promise<string> {
  const res = await fetch(`${UPLOAD_SERVICE}/projects/${encodeURIComponent(id)}/deploy`, {
    ...withSession,
    method: "POST",
  });
  if (!res.ok) throw await failure(res, "deploy failed");
  return (await res.json()).id;
}

/** Points the stable URL at `deploymentId`. A rollback is the same call aimed
 *  at an older deployment; the server refuses anything that is not deployed. */
export async function promoteDeployment(projectId: string, deploymentId: string): Promise<Project> {
  const res = await fetch(`${UPLOAD_SERVICE}/projects/${encodeURIComponent(projectId)}/promote`, {
    ...withSession,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deploymentId }),
  });
  if (!res.ok) throw await failure(res, "promote failed");
  return (await res.json()).project;
}

/** Removes the project and every deployment it has. */
export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${UPLOAD_SERVICE}/projects/${encodeURIComponent(id)}`, {
    ...withSession,
    method: "DELETE",
  });
  if (!res.ok) throw await failure(res, "delete failed");
}

/** Whether `d` went live after the deployment production currently serves.
 *  Decides the wording of the row action: moving the pointer forward is a
 *  promotion, moving it back is a rollback. Compared against the pointer's own
 *  timestamp from the server, so the answer does not depend on the production
 *  row being inside the page of rows this client holds. */
export function isNewerThanProduction(d: Pick<Deployment, "created_at">, project: Project): boolean {
  if (!project.production_created_at) return true;
  return new Date(d.created_at).getTime() > new Date(project.production_created_at).getTime();
}
