import { UPLOAD_SERVICE } from "./config";

export type State = "queued" | "building" | "deployed" | "failed";

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
}

// Served by the upload service rather than straight from the bucket: ids are short
// enough that a public key namespace would be enumerable.
export function screenshotUrl(id: string): string {
  return `${UPLOAD_SERVICE}/screenshot/${id}`;
}

// The UI is monochrome apart from status, where colour carries real meaning:
// green = live, amber = working, red = broken.
export const DOT: Record<State, string> = {
  queued: "bg-fg-disabled",
  building: "bg-fg-warning animate-pulse",
  deployed: "bg-fg-success",
  failed: "bg-fg-error",
};

export const STATUS_TEXT: Record<State, string> = {
  queued: "text-foreground-tertiary",
  building: "text-fg-warning",
  deployed: "text-fg-success",
  failed: "text-fg-error",
};

export const LABEL: Record<State, string> = {
  queued: "Queued",
  building: "Building",
  deployed: "Ready",
  failed: "Failed",
};

export function repoName(url: string): string {
  return url.replace(/\/+$/, "").split("/").slice(-1)[0] || url;
}

export function repoOwner(url: string): string {
  const parts = url.replace(/\/+$/, "").split("/");
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : url;
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
const withSession: RequestInit = { credentials: "include" };

export async function listDeployments(): Promise<Deployment[]> {
  const res = await fetch(`${UPLOAD_SERVICE}/deployments`, withSession);
  if (!res.ok) throw new Error(`deployments ${res.status}`);
  return (await res.json()).deployments ?? [];
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
