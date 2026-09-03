"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import { setDocumentSummary } from "../actions";

/**
 * What the system understood this document to be.
 *
 * Retrieval hands the model eight passages per clause and tells it that it
 * cannot see the rest of the document. That is fine for a standard, whose
 * clauses are self-contained by construction, and wrong for a submission: a
 * deck comparing two vendors reads, eight passages at a time, as unrelated
 * claims about two products.
 *
 * So this paragraph goes in front of the model for every clause of every run —
 * which is exactly why it is on screen. A reviewer needs to see the premise the
 * assessment is reasoning from before reading its conclusions, and a premise
 * that is wrong and cannot be corrected is a bad assessment happening in slow
 * motion.
 *
 * Placed above the counts and the findings for the same reason the structure
 * gate is: the numbers below mean nothing until the reading that produced them
 * is agreed.
 */
export function Understanding({
  documentId,
  summary,
  editable,
  assessed,
}: {
  documentId: string;
  summary: string | null;
  editable: boolean;
  assessed: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await setDocumentSummary(documentId, draft);
      setMessage(result.message);
      if (result.ok) {
        setEditing(false);
        router.refresh();
      }
    });
  };

  // Nothing was written. Say why and what it costs, rather than rendering an
  // empty box that reads as a page still loading.
  if (!summary && !editing) {
    return (
      <section className="mb-7 rounded-xl border border-line bg-surface p-4">
        <Header />
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink/64">
          No summary was written for this document. Assessments will still run, but
          each clause is judged on its retrieved passages alone — without knowing what
          the document as a whole sets out to do.
        </p>
        {editable && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/72 transition-colors hover:border-ink/25 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          >
            <Pencil size={13} />
            Write one
          </button>
        )}
        {message && <p className="mt-2 text-[12.5px] text-ink/64">{message}</p>}
      </section>
    );
  }

  if (editing) {
    return (
      <section className="mb-7 rounded-xl border border-royal-mid/30 bg-royal/[0.05] p-4">
        <Header />
        <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-ink/60">
          Say what this document is for, what it concerns, and — if it sets out
          options — what is being compared against what. Every clause of the next run
          is judged with this in view.
        </p>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={5}
          maxLength={1200}
          autoFocus
          className="mt-3 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink/35 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          placeholder="A vendor evaluation comparing Solution A and Solution B for a B2B payments programme, to support a build-versus-buy recommendation."
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-royal px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          >
            <Check size={13} />
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(summary ?? "");
              setEditing(false);
              setMessage(null);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/72 transition-colors hover:border-ink/25 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          >
            <X size={13} />
            Cancel
          </button>
          <span className="text-[11.5px] tabular-nums text-ink/40">
            {draft.trim().length}/1200
          </span>
        </div>
        {message && <p className="mt-2 text-[12.5px] text-ink/64">{message}</p>}
      </section>
    );
  }

  return (
    <section className="mb-7 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header />
        {editable && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink/64 transition-colors hover:border-ink/25 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          >
            <Pencil size={12} />
            Correct
          </button>
        )}
      </div>
      <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink/85">{summary}</p>
      {assessed && (
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink/50">
          Every clause is assessed with this in view. Correcting it changes the next
          run — findings already recorded were reached on the understanding above.
        </p>
      )}
      {message && <p className="mt-2 text-[12.5px] text-ink/64">{message}</p>}
    </section>
  );
}

function Header() {
  return (
    <h2 className="inline-flex items-center gap-2 font-display text-[15px] font-semibold tracking-[-0.01em] text-ink">
      <Sparkles size={14} className="text-ink/45" strokeWidth={1.9} />
      What this document is
    </h2>
  );
}
