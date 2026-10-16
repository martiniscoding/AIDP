"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { reprocessDocument } from "../actions";

/**
 * The warning that a standard measures less than it should, beside the button
 * that fixes it.
 *
 * The parse already raises this — `no_clauses` when a reference document
 * yielded none, `few_clauses` when it yielded implausibly few for its size —
 * but the notice lived on the parsed-content page and the repair lived on the
 * document page, so nobody holding one ever saw the other. A customer ran four
 * assessments against a standard that had collapsed into a single clause, and
 * every screen they looked at reported that number without suggesting it was
 * wrong or that one click would fix it.
 *
 * So it says what happened, why the assessment is affected, and re-parses in
 * place. In place matters: `reprocessDocument` keeps the same document id, so a
 * project already measuring against this standard keeps its link and the next
 * framework version is cut from the repaired clauses.
 *
 * Only for a reference standard. A submitted design is not measured by its own
 * clause count, and raising this against one would be noise.
 */
export function ClauseYield({
  documentId,
  kind,
  detail,
  canRerun,
}: {
  documentId: string;
  /** "no_clauses" or "few_clauses", as the parse recorded it. */
  kind: "no_clauses" | "few_clauses";
  /** The parse's own sentence, which carries the counts. */
  detail: string;
  /** Whether this person may re-queue the document. See canManageStandards. */
  canRerun: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const severe = kind === "no_clauses";

  const rerun = () =>
    startTransition(async () => {
      const result = await reprocessDocument(documentId);
      setMessage(result.message);
      if (result.ok) router.refresh();
    });

  return (
    <div
      className={cn(
        "mb-6 rounded-xl border px-4 py-3.5",
        severe
          ? "border-danger-line bg-danger-tint"
          : "border-warn-line bg-warn-tint",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <AlertTriangle
          size={15}
          aria-hidden="true"
          className={cn("mt-0.5 shrink-0", severe ? "text-danger" : "text-warn")}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-display text-[13.5px] font-semibold",
              severe ? "text-danger" : "text-warn",
            )}
          >
            {severe
              ? "No rules were extracted from this standard"
              : "Fewer rules were extracted than this standard looks to hold"}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink/78">{detail}</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/64">
            Every assessment measures against the clauses extracted here, so a standard that
            came out thin quietly narrows every report that uses it. Re-parsing reads the
            document again with the current extractor — which recognises rules tables that
            earlier versions flattened into one clause — and keeps this document&rsquo;s
            place in any project already measuring against it.
          </p>
          {message && <p className="mt-2 text-[12.5px] text-ink/72">{message}</p>}
        </div>

        {canRerun && (
          <button
            type="button"
            disabled={pending}
            onClick={rerun}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5",
              "text-[12.5px] font-medium text-white transition-colors disabled:opacity-50",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
              severe ? "bg-danger hover:opacity-90" : "bg-royal hover:bg-royal-mid",
            )}
          >
            <RotateCw size={13} className={pending ? "animate-spin" : undefined} />
            {pending ? "Re-parsing…" : "Re-parse standard"}
          </button>
        )}
      </div>
    </div>
  );
}
