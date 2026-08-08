"use client";

import { useEffect, useRef, useState } from "react";
import { CloudUpload, ExternalLink } from "lucide-react";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll until the deployment reaches a terminal state, then stop.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${UPLOAD_SERVICE}/status?id=${id}`);
        const body = await res.json();
        if (cancelled) return;
        setState(body.status);
        if (body.error) setError(body.error.split("\n")[0]);
        onDone();
        if (body.status !== "deployed" && body.status !== "failed") {
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
  }, [id, onDone]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${UPLOAD_SERVICE}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
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
              className="flex-1 h-10 px-2xl rounded-md bg-fg text-background text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Uploading…" : id && !done ? `Uploading (${id})` : "Upload Project"}
            </button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
