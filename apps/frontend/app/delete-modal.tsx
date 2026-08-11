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

export function DeleteProjectModal({
  id,
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  id: string;
  name: string;
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
            <ModalTitle>Delete deployment</ModalTitle>
            <ModalDescription>
              Are you sure you want to delete {name} ({id})? Its files are removed from
              storage and the URL stops working. This cannot be undone.
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
