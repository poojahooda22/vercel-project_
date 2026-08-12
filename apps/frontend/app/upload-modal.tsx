"use client";

import { useEffect, useRef, useState } from "react";
import { CloudUpload, ExternalLink, Loader2, Minus, Plus } from "lucide-react";
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
import { DOT, LABEL, type State } from "@/lib/deployments";

export function UploadProjectModal({
  open,
  onOpenChange,
  onDone,
  onDeployed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** Called once the build succeeds, so the page can open its detail view. */
  onDeployed?: (id: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  // Build-time variables, kept as ordered rows so the inputs stay stable while
  // typing; folded into a KEY -> value object only at submit.
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Every open starts clean. The dismissal reset in change() cannot cover the
  // success path: the parent closes this modal by flipping `open` after
  // onDeployed, so onOpenChange never fires and the previous URL survives to
  // the next open. State is adjusted during render, not in an effect, so the
  // stale value never reaches the DOM — an effect would paint one stale frame.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setRepoUrl("");
      setEnvRows([]);
      setId(null);
      setState(null);
      setError(null);
    }
  }

  // Held in refs so an inline arrow from the parent cannot change identity every
  // render and restart the polling effect.
  const onDoneRef = useRef(onDone);
  const onDeployedRef = useRef(onDeployed);
  useEffect(() => {
    onDoneRef.current = onDone;
    onDeployedRef.current = onDeployed;
  });

  // Poll until the deployment reaches a terminal state, then stop.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function poll() {
      try {
        // credentials: both /status and /deploy require a session now, and a
        // cross-origin fetch drops the cookie unless asked to send it.
        const res = await fetch(`${UPLOAD_SERVICE}/status?id=${id}`, {
          credentials: "include",
        });
        const body = await res.json();
        if (cancelled) return;
        setState(body.status);
        if (body.error) setError(body.error.split("\n")[0]);
        onDoneRef.current();

        if (body.status === "deployed") {
          // Success needs no acknowledgement — hand straight to the detail view.
          onDeployedRef.current?.(body.id);
          return;
        }
        // A failure keeps the modal open so the reason stays on screen.
        if (body.status !== "failed") {
          timer.current = setTimeout(poll, 2000);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Rows with an empty key are unfinished edits, not variables — drop them
      // instead of failing the whole deploy on a leftover blank row.
      const env: Record<string, string> = {};
      for (const row of envRows) {
        const key = row.key.trim();
        if (key) env[key] = row.value;
      }
      const res = await fetch(`${UPLOAD_SERVICE}/deploy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.keys(env).length ? { repoUrl, env } : { repoUrl }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      setId(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const done = state === "deployed" || state === "failed";
  const inFlight = busy || (!!id && !done);

  // Reset when the modal is dismissed, so reopening starts clean.
  function change(next: boolean) {
    if (!next) {
      setRepoUrl("");
      setEnvRows([]);
      setId(null);
      setState(null);
      setError(null);
    }
    onOpenChange(next);
  }

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
              <ModalDescription>Enter the URL of your GitHub repository</ModalDescription>
            </div>
          </ModalHeader>

          <ModalBody>
            <label
              htmlFor="repoUrl"
              className="block mb-sm text-sm font-medium text-foreground"
            >
              GitHub Repository URL
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
              className="w-full h-10 px-xl rounded-md bg-background-secondary border border-border text-foreground text-sm placeholder:text-foreground-placeholder outline-none focus:border-brand disabled:opacity-50"
            />

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
              disabled={inFlight}
              className="flex-1 inline-flex items-center justify-center gap-md h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90 disabled:opacity-70"
            >
              {inFlight ? <Loader2 className="size-4 animate-spin" /> : null}
              {/* A build runs 1-2 minutes, so the label names the current phase
                  rather than leaving a bare spinner with no explanation. */}
              {!inFlight
                ? "Deploy Project"
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
