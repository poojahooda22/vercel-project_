"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, ExternalLink, FileText, MoreVertical, Plus, Trash2 } from "lucide-react";
import { DashboardShell } from "./dashboard-shell";
import { DeleteModal, type DeleteTarget } from "./delete-modal";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentsTable } from "./deployments-table";
import { ProjectDetail } from "./project-detail";
import { UploadProjectModal } from "./upload-modal";
import { hostOf, projectUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  deleteDeployment,
  inProgress,
  listDeployments,
  repoOwner,
  stillMoving,
  timeAgo,
  type Deployment,
} from "@/lib/deployments";
import { deleteProject, listProjects, promoteDeployment, type Project } from "@/lib/projects";

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  // Fetched alongside projects: the Deployments tab lists every deployment
  // across projects, and its detail view reads from this list.
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Which project page is open, and which deployment the Deployments tab has
  // opened. A project page opens its own rows itself.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nav, setNav] = useState("projects");
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  // Starts true: projects arrive from a client-side fetch, so on the very first
  // render the list is legitimately empty but UNKNOWN. Without this the page shows
  // the "no projects yet" empty state to someone who has six, until the request
  // returns. Only the FIRST load flips it — the 3s poller must not re-show a
  // spinner over content that is already on screen.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // One failure fails the load as a whole: a fresh project list next to a
      // stale deployments list would let the two tabs disagree.
      const [p, d] = await Promise.all([listProjects(), listDeployments()]);
      setProjects(p);
      setDeployments(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // After installing the App, GitHub lands the browser on /?github=<outcome>. The
  // parameter is consumed once and removed, so a reload does not repeat the notice.
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("github");
    if (!outcome) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "connected") {
      setModalOpen(true);
      return;
    }
    // Unknown values are not echoed back: the banner is first-party text, and a
    // crafted link must not be able to put its own sentence there.
    setGithubNotice(
      Object.hasOwn(GITHUB_OUTCOME, outcome)
        ? GITHUB_OUTCOME[outcome]
        : "GitHub connect did not complete. Try connecting again."
    );
  }, []);

  // Keep polling only while something is still moving. A project's `latest`
  // says whether a build is running; the deployments list is checked too, since
  // a screenshot lands a few seconds AFTER the state reaches 'deployed' and only
  // those rows carry screenshot_at — bounded by the capture grace window, or a
  // capture that never succeeds would poll this page forever.
  useEffect(() => {
    // An open project page polls itself; two pollers for one screen would only
    // double the traffic.
    if (openProjectId) return;
    const active =
      projects.some((p) => p.latest !== null && inProgress(p.latest.state)) ||
      deployments.some(stillMoving);
    if (!active) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [projects, deployments, openProjectId, load]);

  // The modal owns the confirmation; this only performs the delete and rethrows
  // so the modal can show the reason instead of closing on a failure.
  async function remove(target: DeleteTarget) {
    if (target.kind === "deployment") {
      await deleteDeployment(target.deployment.id);
      if (selectedId === target.deployment.id) setSelectedId(null);
    } else {
      await deleteProject(target.project.id);
    }
    await load();
  }

  function openProject(id: string) {
    setSelectedId(null);
    setOpenProjectId(id);
  }

  function closeProject() {
    setOpenProjectId(null);
    // This page stopped polling while the project page had the screen; other
    // projects may have moved on meanwhile.
    load();
  }

  const selected = deployments.find((d) => d.id === selectedId) ?? null;
  // The Deployments tab spans projects, so the context its detail view needs —
  // the production pointer and the rollback candidate — is looked up here.
  const selectedProject = selected
    ? (projects.find((p) => p.id === selected.project_id) ?? null)
    : null;
  // The server computes the rollback target over the project's whole history; a
  // page of twenty rows across projects could not.
  const rollbackTo = selected && selectedProject ? selectedProject.rollback_to : null;
  const productionIds = new Set(
    projects
      .map((p) => p.production_deployment_id)
      .filter((id): id is string => id !== null)
  );

  return (
    <DashboardShell
      active={nav}
      onNavigate={(id) => {
        setNav(id);
        setSelectedId(null);
        setOpenProjectId(null);
      }}
    >
      {openProjectId ? (
        // Keyed so switching projects mounts a fresh page: no fetch from the
        // previous project can land in the new one's state.
        <ProjectDetail
          key={openProjectId}
          id={openProjectId}
          onBack={closeProject}
          onChanged={load}
          onDeleted={closeProject}
        />
      ) : selected ? (
        <DeploymentDetail
          deployment={selected}
          backLabel="All deployments"
          production={selectedProject?.production_deployment_id === selected.id}
          rollback={
            selectedProject && rollbackTo
              ? {
                  toId: rollbackTo,
                  run: async () => {
                    await promoteDeployment(selectedProject.id, rollbackTo);
                    await load();
                  },
                }
              : undefined
          }
          onBack={() => setSelectedId(null)}
          onDelete={() => setPendingDelete({ kind: "deployment", deployment: selected })}
        />
      ) : nav === "deployments" ? (
        <DeploymentsTable
          deployments={deployments}
          onOpen={setSelectedId}
          loading={loading}
          productionIds={productionIds}
        />
      ) : nav === "logs" || nav === "analytics" ? (
        <ChooseProject
          key={nav}
          title={nav === "logs" ? "Logs" : "Analytics"}
          projects={projects}
          onChoose={openProject}
        />
      ) : nav !== "projects" ? (
        <Placeholder title={nav} />
      ) : (
        <div className="px-5xl py-4xl">
          <header className="flex items-center justify-between mb-4xl">
            <div>
              <h1 className="text-display-xs font-semibold text-foreground">Projects</h1>
              <p className="text-sm text-foreground-tertiary mt-xs">
                {loading
                  ? "Loading…"
                  : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
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

          {githubNotice ? (
            <div className="mb-2xl p-xl rounded-md border border-error bg-background-error text-fg-error text-sm">
              {githubNotice}
            </div>
          ) : null}

          {/* Skeletons rather than a spinner: they hold the same shape as the cards
              that replace them, so the layout does not jump when data lands. */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2xl">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="p-2xl rounded-lg border border-secondary bg-background-secondary animate-pulse"
                >
                  <div className="h-5 w-1/2 rounded bg-background-active" />
                  <div className="mt-md h-4 w-1/3 rounded bg-background-active" />
                  <div className="mt-xl h-4 w-4/5 rounded bg-background-active" />
                  <div className="mt-xs h-3 w-1/4 rounded bg-background-active" />
                </div>
              ))}
            </div>
          ) : null}

          {/* Only claim "none" once we have actually asked. */}
          {!loading && !loadError && projects.length === 0 ? (
            <div className="p-6xl rounded-lg border border-secondary text-center">
              <p className="text-foreground-secondary text-sm">No projects yet.</p>
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
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() => openProject(p.id)}
                onDelete={() => setPendingDelete({ kind: "project", project: p })}
              />
            ))}
          </div>
        </div>
      )}

      <UploadProjectModal
        open={modalOpen}
        onOpenChange={(o) => {
          setModalOpen(o);
          if (o) setGithubNotice(null);
        }}
        onDone={load}
        onDeployed={(_id, projectId) => {
          setModalOpen(false);
          setNav("projects");
          openProject(projectId);
        }}
      />

      {pendingDelete ? (
        <DeleteModal
          target={pendingDelete}
          open
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          onConfirm={() => remove(pendingDelete)}
        />
      ) : null}
    </DashboardShell>
  );
}

const GITHUB_OUTCOME: Record<string, string> = {
  "link-required":
    "Sign in with GitHub once before connecting repositories, so the installation can be tied to your GitHub account.",
  unknown:
    "GitHub did not recognise that installation for your account. Install the app on the GitHub account you signed in with, on your own account rather than an organization.",
  unconfigured: "This server has no GitHub App registered, so only public repository URLs can be deployed.",
  "github-error": "GitHub did not answer. Try connecting again in a minute.",
  "server-error": "Something went wrong on our side while connecting GitHub. Try again in a minute.",
  suspended: "That installation is suspended on GitHub, so it cannot be used yet.",
  busy: "Too many connect attempts in a short time. Try again in a minute.",
};

function Placeholder({ title }: { title: string }) {
  return (
    <div className="px-5xl py-4xl">
      <h1 className="text-display-xs font-semibold text-foreground capitalize">{title}</h1>
      <p className="mt-xs text-sm text-foreground-tertiary">Not built yet.</p>
    </div>
  );
}

/** Centered project picker: these pages are per-project surfaces, so until a
 *  project is chosen the whole viewport is the chooser, not an empty layout. */
function ChooseProject({
  title,
  projects,
  onChoose,
}: {
  title: string;
  projects: Project[];
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.repo_full_name ?? repoOwner(p.repo_url)).toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q)
      )
    : [];

  return (
    <div className="flex h-full flex-col items-center justify-center px-5xl">
      <div className="inline-flex items-center justify-center size-10 rounded-md border border-secondary text-foreground-secondary">
        {title === "Logs" ? <FileText className="size-5" /> : <BarChart3 className="size-5" />}
      </div>
      <h1 className="mt-xl text-md font-semibold text-foreground">Continue to {title}</h1>
      <p className="mt-xs text-sm text-foreground-tertiary">Choose a project to continue</p>

      <div className="mt-3xl w-full max-w-sm">
        <input
          autoFocus
          placeholder="Find Project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full h-10 px-xl rounded-md bg-background-secondary border border-border text-foreground text-sm placeholder:text-foreground-placeholder outline-none focus:border-brand"
        />

        {q ? (
          matches.length ? (
            <div className="mt-md py-xs rounded-md border border-secondary bg-background-secondary">
              {matches.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  onClick={() => onChoose(p.id)}
                  className="w-full flex items-center justify-between gap-md px-xl py-md text-sm text-foreground hover:bg-background-hover"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="flex items-center gap-md shrink-0 text-foreground-tertiary">
                    <span
                      className={`size-2 rounded-full ${p.latest ? DOT[p.latest.state] : "bg-fg-disabled-subtle"}`}
                    />
                    {p.repo_full_name ?? repoOwner(p.repo_url)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-md text-center text-sm text-foreground-tertiary">
              No project matches “{query}”.
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

function ProjectCard({
  project: p,
  onOpen,
  onDelete,
}: {
  project: Project;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const latest = p.latest;

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
          <h2 className="text-md font-medium text-foreground truncate">{p.name}</h2>
          {p.production_deployment_id ? (
            <a
              href={projectUrl(p.slug)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-xs text-sm text-foreground-tertiary hover:text-foreground truncate"
            >
              {hostOf(projectUrl(p.slug))}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="text-sm text-foreground-tertiary">No production deployment yet</span>
          )}
        </div>

        <div ref={ref} className="flex items-center gap-md shrink-0">
          <span
            className={`size-2 rounded-full ${latest ? DOT[latest.state] : "bg-fg-disabled-subtle"}`}
            title={latest ? LABEL[latest.state] : "No deployments"}
          />
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
                Open project
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

      <p className="mt-xl text-sm text-foreground-tertiary truncate">
        {p.repo_full_name ?? repoOwner(p.repo_url)}
      </p>
      <p className="mt-xs text-xs text-foreground-placeholder">
        {latest
          ? `${LABEL[latest.state]} · ${timeAgo(latest.created_at)}`
          : `No deployments · created ${timeAgo(p.created_at)}`}
      </p>

      {latest?.state === "failed" && latest.error_message ? (
        <p className="mt-md text-xs text-fg-error line-clamp-2">
          {latest.error_message.split("\n")[0]}
        </p>
      ) : null}
    </article>
  );
}
