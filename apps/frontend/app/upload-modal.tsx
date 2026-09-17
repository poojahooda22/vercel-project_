"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CloudUpload,
  ExternalLink,
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalIconBadge,
  ModalTitle,
} from "@/components/Modal";
import { UPLOAD_SERVICE, deployedUrl } from "@/lib/config";
import {
  DOT,
  LABEL,
  githubRepos,
  githubStatus,
  inProgress,
  type GithubRepoChoice,
  type State,
} from "@/lib/deployments";

/**
 * Where the source can come from, decided per open from the server's answer:
 *   url      — no GitHub App on this server, or GitHub could not be reached; a
 *              public URL is the only way in (with a retry when it was an error)
 *   connect  — the App exists but this user has no live installation
 *   pick     — installed: choose from the repositories the App may read
 */
type Source =
  | { kind: "loading" }
  | { kind: "url"; retry: boolean }
  | { kind: "connect"; installUrl: string; githubLinked: boolean }
  | { kind: "pick"; installationId: number; repos: GithubRepoChoice[] };

const INPUT =
  "w-full h-10 px-xl rounded-md bg-background-secondary border border-border text-foreground text-sm placeholder:text-foreground-placeholder outline-none focus:border-brand disabled:opacity-50";

export function UploadProjectModal({
  open,
  onOpenChange,
  onDone,
  onDeployed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** Called once the build succeeds, with the project it belongs to, so the
   *  page can open that project. */
  onDeployed?: (id: string, projectId: string) => void;
}) {
  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [selected, setSelected] = useState<GithubRepoChoice | null>(null);
  const [query, setQuery] = useState("");
  // The URL box is always reachable, so a public repo that is not in the
  // installation can still be deployed without touching GitHub settings.
  const [useUrl, setUseUrl] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  // Build-time variables, kept as ordered rows so the inputs stay stable while
  // typing; folded into a KEY -> value object only at submit.
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>([]);
  // The accepted deployment and its project, held together: the project id is
  // only ever reported alongside a success for this same id, so the two must
  // not be able to drift apart across renders.
  const [job, setJob] = useState<{ id: string; projectId: string } | null>(null);
  const id = job?.id ?? null;
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function reset() {
    setSource({ kind: "loading" });
    setSelected(null);
    setQuery("");
    setUseUrl(false);
    setRepoUrl("");
    setEnvRows([]);
    setJob(null);
    setState(null);
    setError(null);
  }

  // Every open starts clean. The dismissal reset in change() cannot cover the
  // success path: the parent closes this modal by flipping `open` after
  // onDeployed, so onOpenChange never fires and the previous state survives to
  // the next open. State is adjusted during render, not in an effect, so the
  // stale value never reaches the DOM — an effect would paint one stale frame.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) reset();
  }

  // Ask the server which way in applies, each time the modal opens. `refresh`
  // re-runs it after the user changes the installation on GitHub, or to retry.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await githubStatus();
        if (cancelled) return;
        if (!status.configured) {
          setSource({ kind: "url", retry: false });
          return;
        }
        const connect: Source = {
          kind: "connect",
          installUrl: status.installUrl ?? "",
          githubLinked: status.githubLinked,
        };
        if (status.installations.length === 0) {
          setSource(connect);
          if (status.suspended) {
            setError("Your GitHub installation is suspended on GitHub, so its repositories cannot be read.");
          }
          return;
        }
        const answer = await githubRepos();
        if (cancelled) return;
        if (answer.removed) {
          // At least one installation was removed or suspended on GitHub since it was
          // connected; say so even when another one still lists repositories.
          const what = answer.suspended ? "suspended" : "removed";
          setError(
            answer.installations.length === 0
              ? `Your GitHub installation was ${what} on GitHub. ${answer.suspended ? "Check its status on GitHub." : "Connect again to pick repositories."}`
              : `One of your GitHub installations was ${what} on GitHub; its repositories are no longer listed.`
          );
        }
        if (answer.installations.length === 0) {
          setSource(connect);
          return;
        }
        setSource({ kind: "pick", installationId: answer.installations[0], repos: answer.repos });
      } catch (e) {
        if (cancelled) return;
        // GitHub or the server is unreachable: fall back to the URL box rather
        // than a dead dialog, say why, and offer a retry.
        setSource({ kind: "url", retry: true });
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refresh]);

  function retry() {
    setSource({ kind: "loading" });
    setSelected(null);
    setError(null);
    setRefresh((n) => n + 1);
  }

  // Held in refs so an inline arrow from the parent cannot change identity every
  // render and restart the polling effect.
  const onDoneRef = useRef(onDone);
  const onDeployedRef = useRef(onDeployed);
  useEffect(() => {
    onDoneRef.current = onDone;
    onDeployedRef.current = onDeployed;
  });

  // Poll until the deployment reaches a terminal state, then stop. The page is
  // told only when the state actually changes (it polls on its own while a
  // build runs, so a call per tick would just double the traffic), and a
  // transient fetch failure retries with a longer wait rather than ending the
  // dialog's view of a build that is still running.
  useEffect(() => {
    if (!job) return;
    const { id: deploymentId, projectId } = job;
    let cancelled = false;
    let lastStatus: string | null = null;
    let failures = 0;

    async function poll() {
      try {
        // credentials: both /status and /deploy require a session now, and a
        // cross-origin fetch drops the cookie unless asked to send it.
        const res = await fetch(`${UPLOAD_SERVICE}/status?id=${deploymentId}`, {
          credentials: "include",
        });
        const body = await res.json();
        if (cancelled) return;
        failures = 0;
        setState(body.status);
        if (body.error) setError(body.error.split("\n")[0]);
        if (body.status !== lastStatus) {
          lastStatus = body.status;
          onDoneRef.current();
        }

        if (body.status === "deployed") {
          // Success needs no acknowledgement — hand straight to the project.
          onDeployedRef.current?.(body.id, projectId);
          return;
        }
        // A failure — or a cancellation, when a newer push superseded this
        // build — keeps the modal open so the outcome stays on screen.
        if (inProgress(body.status)) {
          timer.current = setTimeout(poll, 2000);
        }
      } catch (e) {
        if (cancelled) return;
        failures++;
        if (failures < 5) {
          timer.current = setTimeout(poll, 2000 * failures);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job]);

  const picking = source.kind === "pick" && !useUrl;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (picking && !selected) {
      setError("Choose a repository first.");
      return;
    }
    setBusy(true);
    try {
      // Rows with an empty key are unfinished edits, not variables — drop them
      // instead of failing the whole deploy on a leftover blank row.
      const env: Record<string, string> = {};
      for (const row of envRows) {
        const key = row.key.trim();
        if (key) env[key] = row.value;
      }
      const body: Record<string, unknown> =
        picking && selected
          ? { installationId: selected.installation_id, repo: selected.full_name }
          : { repoUrl };
      if (Object.keys(env).length) body.env = env;

      const res = await fetch(`${UPLOAD_SERVICE}/deploy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = await res.json();
      if (!res.ok) throw new Error(answer.error ?? `deploy failed (${res.status})`);
      setJob({ id: answer.id, projectId: answer.projectId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const done = state !== null && !inProgress(state);
  const inFlight = busy || (!!id && !done);

  // Reset when the modal is dismissed, so reopening starts clean.
  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const q = query.trim().toLowerCase();
  const visibleRepos =
    source.kind === "pick"
      ? q
        ? source.repos.filter((r) => r.full_name.toLowerCase().includes(q))
        : source.repos
      : [];

  const showUrlBox = source.kind === "url" || useUrl;

  return (
    <Modal open={open} onOpenChange={change}>
      <ModalContent>
        <form onSubmit={submit}>
          <ModalHeader>
            <ModalIconBadge status="default">
              <CloudUpload />
            </ModalIconBadge>
            <div className="flex flex-col gap-xs">
              <ModalTitle>Upload Project</ModalTitle>
              <ModalDescription>
                {picking
                  ? "Choose a repository. Private ones are read through the GitHub App."
                  : source.kind === "connect" && !useUrl
                    ? "Connect GitHub to deploy any of your repositories, private ones included."
                    : "Enter the URL of a public GitHub repository"}
              </ModalDescription>
            </div>
          </ModalHeader>

          <ModalBody>
            {source.kind === "loading" ? (
              <div className="flex items-center gap-md text-sm text-foreground-tertiary">
                <Loader2 className="size-4 animate-spin" />
                Checking your GitHub connection…
              </div>
            ) : null}

            {source.kind === "connect" && !useUrl ? (
              <div className="flex flex-col gap-md">
                <button
                  type="button"
                  disabled={!source.githubLinked || !source.installUrl}
                  onClick={() => window.location.assign(source.installUrl)}
                  className="inline-flex items-center justify-center gap-md h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  <GitBranch className="size-4" />
                  Connect GitHub
                </button>
                {!source.githubLinked ? (
                  <p className="text-sm text-foreground-tertiary">
                    Sign in with GitHub once first, so the connection can be tied to your
                    GitHub account.
                  </p>
                ) : (
                  <p className="text-sm text-foreground-tertiary">
                    GitHub will ask which repositories this app may read. You can change that
                    list on GitHub at any time.
                  </p>
                )}
              </div>
            ) : null}

            {picking ? (
              <div>
                <input
                  autoFocus
                  placeholder="Find a repository…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={inFlight}
                  className={INPUT}
                />
                <div
                  role="radiogroup"
                  aria-label="Repositories"
                  className="mt-md max-h-56 overflow-y-auto rounded-md border border-secondary bg-background-secondary py-xs"
                >
                  {visibleRepos.length === 0 ? (
                    <p className="px-xl py-md text-sm text-foreground-tertiary">
                      {q ? `No repository matches “${query}”.` : "No repositories in this installation yet."}
                    </p>
                  ) : (
                    visibleRepos.map((r) => {
                      const on = selected?.full_name === r.full_name;
                      return (
                        <button
                          key={`${r.installation_id}:${r.full_name}`}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          disabled={inFlight}
                          onClick={() => setSelected(r)}
                          className={`w-full flex items-center justify-between gap-md px-xl py-md text-sm text-left border-l-2 disabled:opacity-50 ${
                            on
                              ? "border-brand-solid bg-background-brand text-foreground font-medium"
                              : "border-transparent text-foreground-secondary hover:bg-background-hover"
                          }`}
                        >
                          <span className="flex items-center gap-md min-w-0">
                            {r.private ? (
                              <Lock className="size-3.5 shrink-0 text-foreground-tertiary" />
                            ) : (
                              <Globe className="size-3.5 shrink-0 text-foreground-tertiary" />
                            )}
                            <span className="truncate">{r.full_name}</span>
                          </span>
                          <span className="flex items-center gap-md shrink-0 text-xs text-foreground-tertiary">
                            {r.default_branch}
                            {on ? <Check className="size-4 text-foreground" aria-hidden /> : null}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="mt-md text-sm" aria-live="polite">
                  {selected ? (
                    <>
                      <span className="text-foreground-tertiary">Selected: </span>
                      <span className="font-medium text-foreground">{selected.full_name}</span>
                    </>
                  ) : (
                    <span className="text-foreground-tertiary">Choose a repository to deploy.</span>
                  )}
                </p>
                <div className="mt-md flex items-center justify-between text-xs">
                  <a
                    href={`https://github.com/settings/installations/${source.installationId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-xs text-foreground-tertiary hover:text-foreground"
                  >
                    Add or remove repositories on GitHub <ExternalLink className="size-3" />
                  </a>
                  <button
                    type="button"
                    disabled={inFlight}
                    onClick={retry}
                    className="inline-flex items-center gap-xs text-foreground-tertiary hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className="size-3" />
                    Refresh
                  </button>
                </div>
              </div>
            ) : null}

            {showUrlBox ? (
              <div>
                <label htmlFor="repoUrl" className="block mb-sm text-sm font-medium text-foreground">
                  Public GitHub repository URL
                </label>
                <input
                  id="repoUrl"
                  type="url"
                  required
                  autoFocus
                  placeholder="https://github.com/user/repo"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  disabled={inFlight}
                  className={INPUT}
                />
              </div>
            ) : null}

            {source.kind === "pick" || source.kind === "connect" ? (
              <button
                type="button"
                disabled={inFlight}
                onClick={() => {
                  setUseUrl((v) => !v);
                  setError(null);
                }}
                className="mt-md text-xs text-foreground-tertiary hover:text-foreground disabled:opacity-50"
              >
                {useUrl ? "← Back to your repositories" : "Or paste a public repository URL"}
              </button>
            ) : null}

            {source.kind === "url" && source.retry ? (
              <button
                type="button"
                disabled={inFlight}
                onClick={retry}
                className="mt-md inline-flex items-center gap-xs text-xs text-foreground-tertiary hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className="size-3" />
                Try GitHub again
              </button>
            ) : null}

            <div className="mt-xl">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">
                  Environment Variables
                  <span className="ml-md text-xs font-normal text-foreground-tertiary">
                    build-time only
                  </span>
                </span>
                <button
                  type="button"
                  disabled={inFlight}
                  onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
                  className="inline-flex items-center gap-xs h-7 px-md rounded-md text-xs font-medium text-foreground-secondary border border-secondary hover:bg-background-hover disabled:opacity-50"
                >
                  <Plus className="size-3" />
                  Add
                </button>
              </div>

              {envRows.map((row, i) => (
                <div key={i} className="mt-md flex items-center gap-md">
                  <input
                    aria-label={`Variable ${i + 1} name`}
                    placeholder="KEY"
                    value={row.key}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r))
                      )
                    }
                    disabled={inFlight}
                    className="w-2/5 h-9 px-xl rounded-md bg-background-secondary border border-border text-foreground text-sm font-mono placeholder:text-foreground-placeholder outline-none focus:border-brand disabled:opacity-50"
                  />
                  <input
                    aria-label={`Variable ${i + 1} value`}
                    placeholder="value"
                    value={row.value}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r))
                      )
                    }
                    disabled={inFlight}
                    className="flex-1 h-9 px-xl rounded-md bg-background-secondary border border-border text-foreground text-sm font-mono placeholder:text-foreground-placeholder outline-none focus:border-brand disabled:opacity-50"
                  />
                  <button
                    type="button"
                    aria-label={`Remove variable ${i + 1}`}
                    disabled={inFlight}
                    onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
                    className="inline-flex items-center justify-center size-9 shrink-0 rounded-md border border-secondary text-foreground-tertiary hover:bg-background-hover hover:text-foreground disabled:opacity-50"
                  >
                    <Minus className="size-4" />
                  </button>
                </div>
              ))}
            </div>

            {state ? (
              <div className="mt-xl flex items-center gap-md text-sm text-foreground-secondary">
                <span className={`size-2 rounded-full ${DOT[state]}`} />
                <span className="text-foreground font-medium">{LABEL[state]}</span>
                {id ? <span className="text-foreground-tertiary">· {id}</span> : null}
                {state === "deployed" && id ? (
                  <a
                    href={deployedUrl(id)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-xs hover:underline"
                  >
                    Visit site <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p className="mt-md text-sm text-fg-error break-words">{error}</p>
            ) : null}
          </ModalBody>

          <ModalFooter>
            <button
              type="button"
              onClick={() => change(false)}
              className="flex-1 h-10 px-2xl rounded-md border border-secondary text-sm font-medium text-foreground-secondary hover:bg-background-hover"
            >
              {done ? "Close" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={
                inFlight ||
                source.kind === "loading" ||
                (source.kind === "connect" && !useUrl) ||
                (picking && !selected)
              }
              className="flex-1 inline-flex items-center justify-center gap-md h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90 disabled:opacity-70"
            >
              {inFlight ? <Loader2 className="size-4 animate-spin" /> : null}
              {/* A build runs 1-2 minutes, so the label names the current phase
                  rather than leaving a bare spinner with no explanation. */}
              {!inFlight
                ? picking && selected
                  ? `Deploy ${selected.full_name.split("/")[1]}`
                  : "Deploy Project"
                : state
                  ? `${LABEL[state]}…`
                  : "Uploading…"}
            </button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
