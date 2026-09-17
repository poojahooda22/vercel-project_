"use client";

import { useState } from "react";
import { ArrowLeft, ExternalLink, GitBranch, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { deployedUrl, hostOf } from "@/lib/config";
import { Screenshot } from "./screenshot";
import {
  DOT,
  LABEL,
  TRIGGER_LABEL,
  buildDuration,
  repoName,
  repoOwner,
  shortSha,
  timeAgo,
  type Deployment,
} from "@/lib/deployments";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm text-foreground-tertiary mb-xs">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

/** The instant-rollback action, offered only by a parent that knows the
 *  project's history: `toId` is the deployment production would return to. */
export interface RollbackAction {
  toId: string;
  run: () => Promise<void>;
}

export function DeploymentDetail({
  deployment,
  onBack,
  onDelete,
  backLabel = "All projects",
  production = false,
  rollback,
}: {
  deployment: Deployment;
  onBack: () => void;
  onDelete: () => void;
  /** Where "back" leads. The deployments tab has no project to name. */
  backLabel?: string;
  /** Whether the project's stable URL currently serves this deployment. */
  production?: boolean;
  /** Absent when there is no earlier deployment to return to; the button then
   *  stays disabled and says so. */
  rollback?: RollbackAction;
}) {
  const d = deployment;
  const live = d.state === "deployed";
  const duration = buildDuration(d);
  const sha = shortSha(d.git_sha);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // The parent moves the pointer and refreshes; this only reports the outcome,
  // so the reason for a refusal lands next to the button that asked.
  async function rollBack() {
    if (!rollback) return;
    setRollbackError(null);
    setRollingBack(true);
    try {
      await rollback.run();
    } catch (e) {
      setRollbackError(e instanceof Error ? e.message : String(e));
    } finally {
      setRollingBack(false);
    }
  }

  return (
    <div className="px-5xl py-4xl">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-md text-sm text-foreground-tertiary hover:text-foreground mb-2xl"
      >
        <ArrowLeft className="size-4" />
        {backLabel}
      </button>

      <div className="rounded-lg border border-secondary bg-background-secondary">
        <div className="flex items-start justify-between gap-2xl p-3xl border-b border-secondary">
          <h2 className="text-lg font-semibold text-foreground">
            {production ? "Production Deployment" : "Deployment"}
          </h2>
          <div className="flex items-center gap-md">
            <a
              href={d.repo_url}
              target="_blank"
              rel="noreferrer"
              title="View repository"
              className="inline-flex items-center justify-center size-9 rounded-md border border-secondary text-foreground-secondary hover:bg-background-hover"
            >
              <GitBranch className="size-4" />
            </a>
            {rollback ? (
              <button
                type="button"
                disabled={rollingBack}
                onClick={rollBack}
                title={`Move production back to ${rollback.toId}`}
                className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-secondary text-sm text-foreground-secondary hover:bg-background-hover disabled:opacity-50"
              >
                {rollingBack ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCcw className="size-4" />
                )}
                Instant Rollback
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="No earlier deployment to roll back to"
                className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-secondary text-sm text-foreground-disabled cursor-not-allowed"
              >
                <RotateCcw className="size-4" />
                Instant Rollback
              </button>
            )}
            {live ? (
              <a
                href={deployedUrl(d.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-md h-9 px-xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90"
              >
                Visit
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </div>
        </div>

        {rollbackError ? (
          <div className="mx-3xl mt-3xl p-xl rounded-md border border-error bg-background-error text-fg-error text-sm">
            {rollbackError}
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-3xl p-3xl">
          <Screenshot deployment={d} />

          <div className="flex flex-col gap-2xl min-w-0">
            <Field label="Deployment">
              <span className="font-medium break-all">{repoName(d.repo_url)}-{d.id}</span>
            </Field>

            <Field label="Domains">
              {live ? (
                <a
                  href={deployedUrl(d.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-xs hover:underline break-all"
                >
                  {hostOf(deployedUrl(d.id))}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="text-foreground-placeholder">Assigned once the build succeeds</span>
              )}
            </Field>

            <div className="flex gap-6xl">
              <Field label="Status">
                <span className="inline-flex items-center gap-md">
                  <span className={`size-2 rounded-full ${DOT[d.state]}`} />
                  {LABEL[d.state]}
                </span>
              </Field>
              <Field label="Created">{timeAgo(d.created_at)}</Field>
              {duration ? <Field label="Build time">{duration}</Field> : null}
            </div>

            {sha || d.git_ref || d.trigger ? (
              <div className="flex gap-6xl">
                {sha || d.git_ref ? (
                  <Field label="Commit">
                    {sha ? <span className="font-mono">{sha}</span> : null}
                    {d.git_ref ? (
                      <span className="text-foreground-secondary">
                        {sha ? " on " : ""}
                        {d.git_ref}
                      </span>
                    ) : null}
                  </Field>
                ) : null}
                {d.trigger ? <Field label="Trigger">{TRIGGER_LABEL[d.trigger]}</Field> : null}
              </div>
            ) : null}

            <Field label="Source">
              <span className="break-all text-foreground-secondary">{repoOwner(d.repo_url)}</span>
            </Field>

            {d.state === "failed" && d.error_message ? (
              <div className="p-xl rounded-md border border-error bg-background-error">
                <p className="text-sm text-fg-error whitespace-pre-wrap break-words">
                  {d.error_message}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2xl px-3xl py-2xl border-t border-secondary">
          <p className="text-sm text-foreground-tertiary">
            {production
              ? "This is what the project's URL serves. Promote or roll back to another deployment before deleting it."
              : "Every push or upload creates a new immutable deployment with its own id."}
          </p>
          <button
            onClick={onDelete}
            disabled={production}
            title={production ? "Promote or roll back to another deployment first" : undefined}
            className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-error text-sm text-fg-error hover:bg-background-error disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <Trash2 className="size-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
