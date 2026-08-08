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
}

// Monochrome status dots — the palette stays greyscale except for genuine
// failure, which is the one thing that must stand out.
export const DOT: Record<State, string> = {
  queued: "bg-fg-disabled",
  building: "bg-fg-secondary animate-pulse",
  deployed: "bg-fg",
  failed: "bg-fg-error",
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

export async function listDeployments(): Promise<Deployment[]> {
  const res = await fetch(`${UPLOAD_SERVICE}/deployments`);
  if (!res.ok) throw new Error(`deployments ${res.status}`);
  return (await res.json()).deployments ?? [];
}

export async function deleteDeployment(id: string): Promise<void> {
  const res = await fetch(`${UPLOAD_SERVICE}/deployments/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `delete failed (${res.status})`);
  }
}
