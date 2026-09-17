"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalIconBadge,
  ModalTitle,
} from "@/components/Modal";
import { repoName, type Deployment } from "@/lib/deployments";
import type { Project } from "@/lib/projects";

/** What is about to be deleted. The modal derives its own wording from the
 *  record, so a caller cannot pair the deployment text with a project. */
export type DeleteTarget =
  | { kind: "deployment"; deployment: Deployment }
  | { kind: "project"; project: Project };

export function DeleteModal({
  target,
  open,
  onOpenChange,
  onConfirm,
}: {
  target: DeleteTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      // Keep the modal open on failure — closing it would hide the reason.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalIconBadge status="error">
            <Trash2 />
          </ModalIconBadge>
          <div className="flex flex-col gap-xs">
            <ModalTitle>
              {target.kind === "project" ? "Delete project" : "Delete deployment"}
            </ModalTitle>
            <ModalDescription>
              {target.kind === "project"
                ? `Are you sure you want to delete ${target.project.name}? Every deployment it has is removed from storage and all of its URLs stop working, the production one included. This cannot be undone.`
                : `Are you sure you want to delete ${repoName(target.deployment.repo_url)} (${target.deployment.id})? Its files are removed from storage and the URL stops working. This cannot be undone.`}
            </ModalDescription>
          </div>
        </ModalHeader>

        {error ? (
          <p className="px-3xl text-sm text-fg-error break-words">{error}</p>
        ) : null}

        <ModalFooter>
          <ModalClose asChild>
            <button
              type="button"
              disabled={busy}
              className="flex-1 h-10 px-2xl rounded-md border border-secondary text-sm font-medium text-foreground-secondary hover:bg-background-hover disabled:opacity-50"
            >
              Cancel
            </button>
          </ModalClose>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={busy}
            className="flex-1 h-10 px-2xl rounded-md bg-background-error-solid text-white text-sm font-medium hover:bg-background-error-solid-hover disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
