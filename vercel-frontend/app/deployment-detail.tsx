"use client";

import { ArrowLeft, ExternalLink, GitBranch, RotateCcw, Trash2 } from "lucide-react";
import { deployedUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  buildDuration,
  repoName,
  repoOwner,
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

export function DeploymentDetail({
  deployment,
  onBack,
  onDelete,
}: {
  deployment: Deployment;
  onBack: () => void;
  onDelete: () => void;
}) {
  const d = deployment;
  const live = d.state === "deployed";
  const duration = buildDuration(d);

  return (
    <div className="px-5xl py-4xl">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-md text-sm text-foreground-tertiary hover:text-foreground mb-2xl"
      >
        <ArrowLeft className="size-4" />
        All projects
      </button>

      <div className="rounded-lg border border-secondary bg-background-secondary">
        <div className="flex items-start justify-between gap-2xl p-3xl border-b border-secondary">
          <h2 className="text-lg font-semibold text-foreground">Production Deployment</h2>
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
            <button
              disabled
              title="Rollback needs deployment history per project — not built yet"
              className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-secondary text-sm text-foreground-disabled cursor-not-allowed"
            >
              <RotateCcw className="size-4" />
              Instant Rollback
            </button>
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

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-3xl p-3xl">
          <div className="aspect-[4/3] rounded-md border border-secondary bg-background flex items-center justify-center">
            <span className="text-sm text-foreground-placeholder">No Screenshot Available</span>
          </div>

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
                  {deployedUrl(d.id).replace(/^https?:\/\//, "").replace(/\/$/, "")}
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
            Every upload creates a new immutable deployment with its own id.
          </p>
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-md h-9 px-xl rounded-md border border-error text-sm text-fg-error hover:bg-background-error"
          >
            <Trash2 className="size-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
