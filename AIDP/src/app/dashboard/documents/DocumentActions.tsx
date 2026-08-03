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
      {message && <span className="text-[12px] text-white/45">{message}</span>}

      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => reprocessDocument(documentId))}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5",
          "text-[12.5px] text-white/60 transition-colors",
          "hover:border-white/25 hover:text-white disabled:opacity-50",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <RotateCw size={13} className={pending ? "animate-spin" : undefined} />
        Re-run
      </button>

      {confirming ? (
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/[0.07] px-3 py-1.5 text-[12.5px]">
          <span className="text-white/70">
            Delete “{title}” with its clauses and vectors?
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => deleteDocument(documentId), redirectAfterDelete)}
            className="font-medium text-amber-300 underline underline-offset-2 hover:text-amber-200 disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-white/45 hover:text-white/70"
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
            "inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5",
            "text-[12.5px] text-white/50 transition-colors",
            "hover:border-amber-400/40 hover:text-amber-300 disabled:opacity-50",
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
