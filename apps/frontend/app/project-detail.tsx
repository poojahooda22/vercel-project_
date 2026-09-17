"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, GitBranch, Loader2, Rocket, Trash2 } from "lucide-react";
import { DeleteModal, type DeleteTarget } from "./delete-modal";
import { DeploymentDetail } from "./deployment-detail";
import { deployedUrl, hostOf, projectUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  STATUS_TEXT,
  TRIGGER_LABEL,
  buildDuration,
  deleteDeployment,
  repoOwner,
  shortSha,
  stillMoving,
  timeAgo,
  type Deployment,
} from "@/lib/deployments";
import {
  deleteProject,
  getProject,
  isNewerThanProduction,
  promoteDeployment,
  redeployProject,
  type Project,
} from "@/lib/projects";

/** Which header or row action is in flight, so only that control shows busy
 *  while every other one refuses a second click meanwhile. */
type Action = { kind: "deploy" } | { kind: "promote"; deploymentId: string };

export function ProjectDetail({
  id,
  onBack,
  onChanged,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  /** Something about this project changed (a deploy, a promotion, a deleted
   *  row), so the list behind this page should refresh. */
  onChanged: () => void;
  /** The project itself is gone; the parent must leave this page. */
  onDeleted: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  // Every read goes through this one effect, re-run by bumping `version`: a
  // mutation asks for a re-read the same way the poller does, and a response
  // that arrives after a newer request started is dropped rather than letting
  // an older snapshot overwrite a newer one.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await getProject(id);
        if (cancelled) return;
        setProject(page.project);
        setDeployments(page.deployments);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  function refresh() {
    setVersion((v) => v + 1);
  }

  // Same rule as the dashboard: poll while a build is running or a fresh
  // deployment is still waiting for its screenshot, and stop once nothing moves.
  useEffect(() => {
    if (!deployments.some(stillMoving)) return;
    const t = setTimeout(() => setVersion((v) => v + 1), 3000);
    return () => clearTimeout(t);
  }, [deployments]);

  // Moves the stable URL to a deployment: the returned project lands at once,
  // the rows follow on the re-read. Throws, so the caller decides where a
  // refusal is shown: next to the row, or in the detail view.
  async function pointProductionAt(deploymentId: string) {
    setProject(await promoteDeployment(id, deploymentId));
    refresh();
    onChanged();
  }

  async function run(action: Action, work: () => Promise<void>) {
    setActionError(null);
    setRunning(action);
    try {
      await work();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  function deploy() {
    return run({ kind: "deploy" }, async () => {
      await redeployProject(id);
      refresh();
      onChanged();
    });
  }

  function promote(d: Deployment) {
    return run({ kind: "promote", deploymentId: d.id }, () => pointProductionAt(d.id));
  }

  // The modal owns the confirmation; this only performs the delete and rethrows
  // so the modal can show the reason instead of closing on a failure.
  async function remove(target: DeleteTarget) {
    if (target.kind === "project") {
      await deleteProject(target.project.id);
      onDeleted();
      return;
    }
    await deleteDeployment(target.deployment.id);
    if (selectedId === target.deployment.id) setSelectedId(null);
    refresh();
    onChanged();
  }

  const modal = pendingDelete ? (
    <DeleteModal
      target={pendingDelete}
      open
      onOpenChange={(o) => {
        if (!o) setPendingDelete(null);
      }}
      onConfirm={() => remove(pendingDelete)}
    />
  ) : null;

  const selected = deployments.find((d) => d.id === selectedId) ?? null;
  if (project && selected) {
    const target = project.rollback_to;
    return (
      <>
        <DeploymentDetail
          deployment={selected}
          backLabel={project.name}
          production={project.production_deployment_id === selected.id}
          rollback={target ? { toId: target, run: () => pointProductionAt(target) } : undefined}
          onBack={() => setSelectedId(null)}
          onDelete={() => setPendingDelete({ kind: "deployment", deployment: selected })}
        />
        {modal}
      </>
    );
  }

  const productionHref =
    project && project.production_deployment_id ? projectUrl(project.slug) : null;

  return (
    <div className="px-5xl py-4xl">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-md text-sm text-foreground-tertiary hover:text-foreground mb-2xl"
      >
        <ArrowLeft className="size-4" />
        All projects
      </button>

      {project ? (
        <header className="flex items-start justify-between gap-2xl mb-4xl">
          <div className="min-w-0">
            <h1 className="text-display-xs font-semibold text-foreground truncate">{project.name}</h1>
            <p className="mt-xs flex flex-wrap items-center gap-md text-sm text-foreground-tertiary">
              <a
                href={project.repo_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-xs hover:text-foreground"
              >
                <GitBranch className="size-3.5" />
                {project.repo_full_name ?? repoOwner(project.repo_url)}
                <ExternalLink className="size-3" />
              </a>
              <span aria-hidden>·</span>
              <span>
                {project.production_branch
                  ? `Production branch ${project.production_branch}`
                  : "Production branch not resolved yet"}
              </span>
            </p>
            {productionHref ? (
              <a
                href={productionHref}
                target="_blank"
                rel="noreferrer"
                className="mt-xs inline-flex items-center gap-xs text-sm text-foreground-secondary hover:text-foreground"
              >
                {hostOf(productionHref)}
                <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : (
              <p className="mt-xs text-sm text-foreground-placeholder">No production deployment yet</p>
            )}
            {project.installation_id === null ? (
              <p className="mt-md text-xs text-foreground-tertiary">
                Not connected to GitHub, so pushes do not deploy it. Pick this repository under
                Connect GitHub to deploy on push.
              </p>
            ) : null}
            {!project.auto_promote ? (
              <p className="mt-md text-xs text-fg-warning">
                Auto-deploy to production is paused since the rollback. Promote a newer deployment
                to resume it.
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-md shrink-0">
            {productionHref ? (
              <a
                href={productionHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-secondary text-sm text-foreground-secondary hover:bg-background-hover"
              >
                Visit
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <button
                type="button"
                disabled
                title="No production deployment yet"
                className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-secondary text-sm text-foreground-disabled cursor-not-allowed"
              >
                Visit
                <ExternalLink className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={deploy}
              disabled={running !== null}
              title="Build the production branch again"
              className="inline-flex items-center gap-md h-9 px-xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90 disabled:opacity-70"
            >
              {running?.kind === "deploy" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              Deploy
            </button>
            <button
              type="button"
              onClick={() => setPendingDelete({ kind: "project", project })}
              className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-error text-sm text-fg-error hover:bg-background-error"
            >
              <Trash2 className="size-4" />
              Delete
            </button>
          </div>
        </header>
      ) : loadError ? null : (
        <header className="mb-4xl animate-pulse">
          <div className="h-7 w-1/3 rounded bg-background-active" />
          <div className="mt-md h-4 w-1/4 rounded bg-background-active" />
        </header>
      )}

      {loadError ? (
        <div className="mb-2xl p-xl rounded-md border border-error bg-background-error text-fg-error text-sm">
          {loadError}
        </div>
      ) : null}

      {actionError ? (
        <div className="mb-2xl p-xl rounded-md border border-error bg-background-error text-fg-error text-sm">
          {actionError}
        </div>
      ) : null}

      <h2 className="mb-xl text-md font-semibold text-foreground">Deployments</h2>

      {project === null ? (
        loadError ? null : (
          <div className="rounded-lg border border-secondary overflow-hidden">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`flex items-center gap-2xl px-2xl py-xl animate-pulse ${
                  i > 0 ? "border-t border-secondary" : ""
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block h-4 w-1/3 rounded bg-background-active" />
                  <span className="block mt-xs h-3 w-1/4 rounded bg-background-active" />
                </span>
                <span className="hidden sm:block w-[140px] h-4 rounded bg-background-active" />
                <span className="w-[80px] h-3 rounded bg-background-active" />
              </div>
            ))}
          </div>
        )
      ) : deployments.length === 0 ? (
        <div className="p-6xl rounded-lg border border-secondary text-center">
          <p className="text-foreground-secondary text-sm">
            No deployments yet. Push to {project.production_branch ?? "the repository"} or click
            Deploy.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-secondary overflow-hidden">
          {deployments.map((d, i) => {
            const isProduction = d.id === project.production_deployment_id;
            // Only a finished build can be pointed at; the current production
            // deployment has nowhere to move.
            const canPoint = d.state === "deployed" && !isProduction;
            const promoting = running?.kind === "promote" && running.deploymentId === d.id;
            const commit = [d.git_ref, shortSha(d.git_sha)]
              .filter((s): s is string => !!s)
              .join(" · ");
            return (
              <div
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`flex items-center gap-2xl px-2xl py-xl hover:bg-background-hover transition-colors cursor-pointer ${
                  i > 0 ? "border-t border-secondary" : ""
                }`}
              >
                {/* Id + commit — the widest column, so it takes the slack */}
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-md">
                    {d.state === "deployed" ? (
                      <a
                        href={deployedUrl(d.id)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-xs text-sm font-medium text-foreground font-mono hover:underline"
                      >
                        {d.id}
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-sm font-medium text-foreground font-mono">{d.id}</span>
                    )}
                    {isProduction ? (
                      <span className="inline-flex items-center h-6 px-md rounded-full border border-secondary text-xs text-foreground-secondary shrink-0">
                        Production
                      </span>
                    ) : null}
                  </span>
                  <span className="block mt-xs text-xs text-foreground-placeholder truncate">
                    {commit || "No commit recorded"}
                  </span>
                  {d.state === "failed" && d.error_message ? (
                    <span className="block mt-md p-xl rounded-md border border-error bg-background-error text-sm text-fg-error whitespace-pre-wrap break-words line-clamp-3">
                      {d.error_message}
                    </span>
                  ) : null}
                </span>

                <span className="hidden md:block w-[70px] shrink-0 text-xs text-foreground-tertiary">
                  {d.trigger ? TRIGGER_LABEL[d.trigger] : "—"}
                </span>

                {/* Status + how long the build took */}
                <span className="hidden sm:flex items-center gap-md w-[140px] shrink-0">
                  <span className={`size-2 rounded-full ${DOT[d.state]}`} />
                  <span className={`text-sm font-medium ${STATUS_TEXT[d.state]}`}>
                    {LABEL[d.state]}
                  </span>
                  {buildDuration(d) ? (
                    <span className="text-xs text-foreground-placeholder">{buildDuration(d)}</span>
                  ) : null}
                </span>

                <span className="w-[80px] shrink-0 text-right text-xs text-foreground-placeholder">
                  {timeAgo(d.created_at)}
                </span>

                <span className="w-[176px] shrink-0 flex justify-end">
                  {canPoint ? (
                    <button
                      type="button"
                      disabled={running !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        promote(d);
                      }}
                      className="inline-flex items-center gap-xs h-7 px-md rounded-md text-xs font-medium text-foreground-secondary border border-secondary hover:bg-background-hover disabled:opacity-50"
                    >
                      {promoting ? <Loader2 className="size-3 animate-spin" /> : null}
                      {isNewerThanProduction(d, project) ? "Promote to production" : "Rollback to this"}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {modal}
    </div>
  );
}
