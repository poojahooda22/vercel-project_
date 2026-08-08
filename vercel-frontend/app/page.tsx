"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, MoreVertical, Plus, Trash2 } from "lucide-react";
import { DashboardShell } from "./dashboard-shell";
import { DeploymentDetail } from "./deployment-detail";
import { DeleteProjectModal } from "./delete-modal";
import { UploadProjectModal } from "./upload-modal";
import { deployedUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  deleteDeployment,
  listDeployments,
  repoName,
  timeAgo,
  type Deployment,
} from "@/lib/deployments";

export default function DashboardPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nav, setNav] = useState("projects");
  const [pendingDelete, setPendingDelete] = useState<Deployment | null>(null);

  const load = useCallback(async () => {
    try {
      setDeployments(await listDeployments());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep polling only while something is still moving.
  useEffect(() => {
    const active = deployments.some((d) => d.state === "queued" || d.state === "building");
    if (!active) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [deployments, load]);

  // The modal owns the confirmation; this only performs the delete and rethrows
  // so the modal can show the reason instead of closing on a failure.
  async function remove(id: string) {
    await deleteDeployment(id);
    if (selectedId === id) setSelectedId(null);
    await load();
  }

  const selected = deployments.find((d) => d.id === selectedId) ?? null;

  return (
    <DashboardShell
      active={nav}
      onNavigate={(id) => {
        setNav(id);
        setSelectedId(null);
      }}
    >
      {selected ? (
        <DeploymentDetail
          deployment={selected}
          onBack={() => setSelectedId(null)}
          onDelete={() => setPendingDelete(selected)}
        />
      ) : nav !== "projects" ? (
        <Placeholder title={nav} />
      ) : (
        <div className="px-5xl py-4xl">
          <header className="flex items-center justify-between mb-4xl">
            <div>
              <h1 className="text-display-xs font-semibold text-foreground">Projects</h1>
              <p className="text-sm text-foreground-tertiary mt-xs">
                {deployments.length} deployment{deployments.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-md h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90"
            >
              <Plus className="size-4" />
              Upload Project
            </button>
          </header>

          {loadError ? (
            <div className="mb-2xl p-xl rounded-md border border-error bg-background-error text-fg-error text-sm">
              {loadError}
            </div>
          ) : null}

          {!loadError && deployments.length === 0 ? (
            <div className="p-6xl rounded-lg border border-secondary text-center">
              <p className="text-foreground-secondary text-sm">No deployments yet.</p>
              <button
                onClick={() => setModalOpen(true)}
                className="mt-xl inline-flex items-center gap-md h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium"
              >
                <Plus className="size-4" />
                Upload Project
              </button>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2xl">
            {deployments.map((d) => (
              <ProjectCard
                key={d.id}
                deployment={d}
                onOpen={() => setSelectedId(d.id)}
                onDelete={() => setPendingDelete(d)}
              />
            ))}
          </div>
        </div>
      )}

      <UploadProjectModal open={modalOpen} onOpenChange={setModalOpen} onDone={load} />

      {pendingDelete ? (
        <DeleteProjectModal
          id={pendingDelete.id}
          name={repoName(pendingDelete.repo_url)}
          open
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          onConfirm={() => remove(pendingDelete.id)}
        />
      ) : null}
    </DashboardShell>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="px-5xl py-4xl">
      <h1 className="text-display-xs font-semibold text-foreground capitalize">{title}</h1>
      <p className="mt-xs text-sm text-foreground-tertiary">Not built yet.</p>
    </div>
  );
}

function ProjectCard({
  deployment: d,
  onOpen,
  onDelete,
}: {
  deployment: Deployment;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on any outside click, so the menu never strands itself open.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <article
      onClick={onOpen}
      className="relative p-2xl rounded-lg border border-secondary bg-background-secondary hover:border-primary cursor-pointer transition-colors"
    >
      <div className="flex items-start justify-between gap-md">
        <div className="min-w-0">
          <h2 className="text-md font-medium text-foreground truncate">{repoName(d.repo_url)}</h2>
          {d.state === "deployed" ? (
            <a
              href={deployedUrl(d.id)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-xs text-sm text-foreground-tertiary hover:text-foreground truncate"
            >
              {d.id}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="text-sm text-foreground-tertiary">{d.id}</span>
          )}
        </div>

        <div ref={ref} className="flex items-center gap-md shrink-0">
          <span className={`size-2 rounded-full ${DOT[d.state]}`} title={LABEL[d.state]} />
          <button
            aria-label="Project actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="inline-flex items-center justify-center size-7 rounded-md text-foreground-tertiary hover:bg-background-hover hover:text-foreground"
          >
            <MoreVertical className="size-4" />
          </button>

          {menuOpen ? (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-2xl top-5xl z-10 w-[180px] py-xs rounded-md border border-secondary bg-background shadow-lg"
            >
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpen();
                }}
                className="w-full text-left px-xl py-md text-sm text-foreground hover:bg-background-hover"
              >
                View deployment
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="w-full flex items-center gap-md px-xl py-md text-sm text-fg-error hover:bg-background-error"
              >
                <Trash2 className="size-4" />
                Delete project
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-xl text-sm text-foreground-tertiary truncate">{d.repo_url}</p>
      <p className="mt-xs text-xs text-foreground-placeholder">
        {LABEL[d.state]} · {timeAgo(d.created_at)}
      </p>

      {d.state === "failed" && d.error_message ? (
        <p className="mt-md text-xs text-fg-error line-clamp-2">
          {d.error_message.split("\n")[0]}
        </p>
      ) : null}
    </article>
  );
}
