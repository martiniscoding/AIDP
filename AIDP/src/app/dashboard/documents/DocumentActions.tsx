"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { deleteDocument, reprocessDocument } from "./actions";

/**
 * Re-queue and delete.
 *
 * Delete asks first and says what else goes with it. Removing a document takes
 * its clauses, chunks and vectors too, and that is not obvious from a bin icon.
 */
export function DocumentActions({
  documentId,
  title,
  redirectAfterDelete = false,
}: {
  documentId: string;
  title: string;
  redirectAfterDelete?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = (action: () => Promise<{ ok: boolean; message: string }>, thenRedirect = false) => {
    startTransition(async () => {
      const result = await action();
      setMessage(result.message);
      setConfirming(false);
      if (result.ok && thenRedirect) router.push("/dashboard/documents");
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {message && <span className="text-[12px] text-ink/66">{message}</span>}

      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => reprocessDocument(documentId))}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5",
          "text-[12.5px] text-ink/72 transition-colors",
          "hover:border-line-strong hover:text-ink disabled:opacity-50",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <RotateCw size={13} className={pending ? "animate-spin" : undefined} />
        Re-run
      </button>

      {confirming ? (
        <span className="inline-flex items-center gap-2 rounded-full border border-warn-line bg-warn-tint px-3 py-1.5 text-[12.5px]">
          <span className="text-ink/78">
            Delete “{title}” with its clauses and vectors?
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => deleteDocument(documentId), redirectAfterDelete)}
            className="font-medium text-warn underline underline-offset-2 hover:text-danger disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-ink/66 hover:text-ink/78"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5",
            "text-[12.5px] text-ink/68 transition-colors",
            "hover:border-warn-line hover:text-danger disabled:opacity-50",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          )}
        >
          <Trash2 size={13} />
          Delete
        </button>
      )}
    </div>
  );
}
