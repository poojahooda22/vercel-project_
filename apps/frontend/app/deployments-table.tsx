"use client";

import { ExternalLink } from "lucide-react";
import { deployedUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  STATUS_TEXT,
  buildDuration,
  repoName,
  repoOwner,
  timeAgo,
  type Deployment,
} from "@/lib/deployments";

export function DeploymentsTable({
  deployments,
  onOpen,
  loading = false,
}: {
  deployments: Deployment[];
  onOpen: (id: string) => void;
  /** True until the first fetch resolves, so an unknown list is not called empty. */
  loading?: boolean;
}) {
  return (
    <div className="px-5xl py-4xl">
      <header className="mb-4xl">
        <h1 className="text-display-xs font-semibold text-foreground">Deployments</h1>
        <p className="text-sm text-foreground-tertiary mt-xs">
          {loading
            ? "Loading…"
            : `${deployments.length} deployment${deployments.length === 1 ? "" : "s"} across all projects`}
        </p>
      </header>

      {loading ? (
        <div className="rounded-lg border border-secondary overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
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
      ) : deployments.length === 0 ? (
        <div className="p-6xl rounded-lg border border-secondary text-center">
          <p className="text-foreground-secondary text-sm">No deployments yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-secondary overflow-hidden">
          {deployments.map((d, i) => (
            <button
              key={d.id}
              onClick={() => onOpen(d.id)}
              className={`w-full text-left flex items-center gap-2xl px-2xl py-xl hover:bg-background-hover transition-colors ${
                i > 0 ? "border-t border-secondary" : ""
              }`}
            >
              {/* Project — the widest column, so it takes the slack */}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-foreground truncate">
                  {repoName(d.repo_url)}
                </span>
                <span className="block text-xs text-foreground-placeholder truncate">
                  {repoOwner(d.repo_url)}
                </span>
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

              {/* Everything here is production: there is no preview concept yet. */}
              <span className="hidden lg:inline-flex items-center h-6 px-md rounded-full border border-secondary text-xs text-foreground-secondary shrink-0">
                Production
              </span>

              <span className="hidden md:block w-[90px] shrink-0 text-sm text-foreground-tertiary font-mono">
                {d.id}
              </span>

              <span className="w-[80px] shrink-0 text-right text-xs text-foreground-placeholder">
                {timeAgo(d.created_at)}
              </span>

              <span className="w-[24px] shrink-0 flex justify-end">
                {d.state === "deployed" ? (
                  <a
                    href={deployedUrl(d.id)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Visit ${d.id}`}
                    className="text-foreground-tertiary hover:text-foreground"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
