"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ScanLine } from "lucide-react";
import { confirmStructure } from "../actions";

/**
 * The gate on a model-read standard.
 *
 * This document's headings and rules were inferred, not parsed — nothing in its
 * own formatting said where anything started. That is worth having, and it is
 * not worth trusting unread: assessment stays blocked until someone confirms
 * the rules below are the rules their standard actually contains.
 *
 * A banner rather than a modal, sitting directly above the extracted clauses,
 * because the confirmation is only meaningful if the thing being confirmed is
 * on screen at the same time.
 */
export function ConfirmStructure({
  documentId,
  clauseCount,
  confirmedAt,
  confirmedBy,
}: {
  documentId: string;
  clauseCount: number;
  confirmedAt: string | null;
  confirmedBy: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (confirmedAt) {
    return (
      <p className="mb-6 inline-flex items-center gap-2 rounded-lg border border-ok-line bg-ok-tint px-3 py-2 text-[12.5px] text-ok">
        <Check size={13} className="shrink-0" />
        Structure read by a model and confirmed
        {confirmedBy ? ` by ${confirmedBy}` : ""} on{" "}
        {new Date(confirmedAt).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
        .
      </p>
    );
  }

  return (
    <section className="mb-7 rounded-xl border border-warn-line bg-warn-tint p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ScanLine size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-warn">
            This standard&apos;s structure was read by a model
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-warn">
            Nothing in the document&apos;s own formatting marked where its
            sections and rules begin, so they were inferred from the text. We
            extracted {clauseCount} rule{clauseCount === 1 ? "" : "s"}. Every
            word below is from your document — nothing was rewritten — but the{" "}
            <span className="text-warn">grouping is a machine&apos;s reading</span>{" "}
            of it.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-warn">
            Check the rules below. Nothing can be assessed against this standard
            until you confirm them. If the reading is wrong, fix the source
            document and reprocess rather than confirming.
          </p>

          {message && (
            <p role="status" className="mt-2.5 text-[12.5px] text-warn">
              {message}
            </p>
          )}

          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await confirmStructure(documentId);
                setMessage(result.message);
                router.refresh();
              })
            }
            className="mt-3.5 inline-flex items-center gap-1.5 rounded-full bg-warn px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-warn/85 disabled:opacity-55"
          >
            <Check size={13} />
            These rules are correct
          </button>
        </div>
      </div>
    </section>
  );
}
