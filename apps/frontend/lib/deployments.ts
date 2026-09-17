import { UPLOAD_SERVICE } from "./config";

export type State = "queued" | "ingesting" | "building" | "deployed" | "failed" | "canceled";

/** How a deployment came to exist: an upload from the dashboard, a push to the
 *  repository, or the production pointer being moved back to an older build. */
export type Trigger = "manual" | "webhook" | "rollback";

export interface Deployment {
  id: string;
  repo_url: string;
  state: State;
  error_message: string | null;
  created_at: string;
  building_at: string | null;
  finished_at: string | null;
  /** When the screenshot was captured; null means there isn't one. */
  screenshot_at: string | null;
  /** "owner/name" when deployed through the GitHub App; null for a public URL. */
  repo_full_name: string | null;
  /** The commit that was built; null for rows from before this was recorded. */
  git_sha: string | null;
  /** The project this belongs to; null for rows from before projects existed. */
  project_id: string | null;
  /** The branch that was built; null when it was not recorded. */
  git_ref: string | null;
  trigger: Trigger | null;
}

/** What the upload modal needs to decide between the repo picker and a URL box. */
export interface GithubStatus {
  /** False when the server has no GitHub App registered: public URLs only. */
  configured: boolean;
  /** Where "Connect GitHub" sends the user. Absent when not configured. */
  installUrl?: string;
  /** Whether this account signed in with GitHub at least once. Needed to connect. */
  githubLinked: boolean;
  installations: { installation_id: number; account_login: string }[];
  /** True when the user's installation exists on GitHub but is suspended there. */
  suspended?: boolean;
}

export interface GithubRepoChoice {
  installation_id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

// Served by the upload service rather than straight from the bucket: ids are short
// enough that a public key namespace would be enumerable.
export function screenshotUrl(id: string): string {
  return `${UPLOAD_SERVICE}/screenshot/${id}`;
}

// The UI is monochrome apart from status, where colour carries real meaning:
// green = live, amber = working, red = broken. Canceled is a step fainter than
// queued: it never ran and never will, so it must not read as "waiting".
export const DOT: Record<State, string> = {
  queued: "bg-fg-disabled",
  ingesting: "bg-fg-warning animate-pulse",
  building: "bg-fg-warning animate-pulse",
  deployed: "bg-fg-success",
  failed: "bg-fg-error",
  canceled: "bg-fg-disabled-subtle",
};

export const STATUS_TEXT: Record<State, string> = {
  queued: "text-foreground-tertiary",
  ingesting: "text-fg-warning",
  building: "text-fg-warning",
  deployed: "text-fg-success",
  failed: "text-fg-error",
  canceled: "text-foreground-placeholder",
};

export const LABEL: Record<State, string> = {
  queued: "Queued",
  ingesting: "Preparing",
  building: "Building",
  deployed: "Ready",
  failed: "Failed",
  canceled: "Canceled",
};

export const TRIGGER_LABEL: Record<Trigger, string> = {
  manual: "Manual",
  webhook: "Push",
  rollback: "Rollback",
};

/** Whether the deployment can still change state on its own. Everything else
 *  is final: a poller has no reason to ask again. */
export function inProgress(state: State): boolean {
  return state === "queued" || state === "ingesting" || state === "building";
}

/** How long after a build finishes a missing screenshot still counts as "coming". */
export const CAPTURE_GRACE_MS = 3 * 60_000;

/** True when the build succeeded but its screenshot has not landed yet and still
 *  could. Bounded on purpose: a capture that never succeeds must not keep a
 *  poller alive forever. */
export function awaitingCapture(
  d: Pick<Deployment, "state" | "screenshot_at" | "finished_at">
): boolean {
  if (d.state !== "deployed" || d.screenshot_at) return false;
  const finished = d.finished_at ? new Date(d.finished_at).getTime() : 0;
  return Date.now() - finished < CAPTURE_GRACE_MS;
}

/** Whether a poller still has a reason to ask about this deployment. */
export function stillMoving(
  d: Pick<Deployment, "state" | "screenshot_at" | "finished_at">
): boolean {
  return inProgress(d.state) || awaitingCapture(d);
}

export function repoName(url: string): string {
  return url.replace(/\/+$/, "").split("/").slice(-1)[0] || url;
}

export function repoOwner(url: string): string {
  const parts = url.replace(/\/+$/, "").split("/");
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : url;
}

/** The seven characters git itself abbreviates to; null when no commit was recorded. */
export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

export function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function buildDuration(d: Deployment): string | null {
  if (!d.building_at || !d.finished_at) return null;
  const ms = new Date(d.finished_at).getTime() - new Date(d.building_at).getTime();
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}

// The API is a different origin in dev (:3000 vs :3002), and fetch defaults to
// credentials: "same-origin" — so without this the session cookie is silently
// dropped and every call comes back 401. Harmless once Caddy puts both behind one
// origin in production; required until then.
export const withSession: RequestInit = { credentials: "include" };

export async function listDeployments(): Promise<Deployment[]> {
  const res = await fetch(`${UPLOAD_SERVICE}/deployments`, withSession);
  if (!res.ok) throw new Error(`deployments ${res.status}`);
  return (await res.json()).deployments ?? [];
}

export async function githubStatus(): Promise<GithubStatus> {
  const res = await fetch(`${UPLOAD_SERVICE}/github/status`, withSession);
  if (!res.ok) throw new Error(`github status ${res.status}`);
  return res.json();
}

export interface GithubReposResponse {
  repos: GithubRepoChoice[];
  /** Installation ids still valid on GitHub after this call. */
  installations: number[];
  /** True when at least one installation had been removed on GitHub and was dropped. */
  removed: boolean;
  /** True when at least one installation is suspended on GitHub. */
  suspended: boolean;
}

export async function githubRepos(): Promise<GithubReposResponse> {
  const res = await fetch(`${UPLOAD_SERVICE}/github/repos`, withSession);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `github repos ${res.status}`);
  }
  const body = await res.json();
  return {
    repos: body.repos ?? [],
    installations: body.installations ?? [],
    removed: !!body.removed,
    suspended: !!body.suspended,
  };
}

export async function deleteDeployment(id: string): Promise<void> {
  const res = await fetch(`${UPLOAD_SERVICE}/deployments/${id}`, {
    ...withSession,
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `delete failed (${res.status})`);
  }
}
