"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { deleteDocument } from "./actions";

/**
 * Take a standard out of the library, for good.
 *
 * Asks first, and says what is actually at stake. A standard is its clauses:
 * removing one does not tidy the library, it changes what every future
 * assessment measures against, and the number of clauses that stop being
 * checked is the only honest way to put that. The bin icon alone invited
 * somebody to find out afterwards.
 *
 * Past reports are safe, and the confirmation says so, because the fear of
 * breaking them is the reason a stale standard sits in a library for a year.
 * A finding keeps the clause's reference, title and wording on its own row —
 * see the Finding model — so a report written last quarter still reads the
 * same once the standard behind it is gone.
 *
 * The server action is the access control; this only withholds a control that
 * would be refused, so it reads as a rule rather than a fault.
 */
export function RemoveStandard({
  documentId,
  title,
  clauses,
}: {
  documentId: string;
  title: string;
  /** Clauses this standard contributes, and so what stops being checked. */
  clauses: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const remove = () =>
    startTransition(async () => {
      const result = await deleteDocument(documentId);
      setMessage(result.message);
      setConfirming(false);
      router.refresh();
    });

  if (message) {
    return (
      <span role="status" className="shrink-0 text-right text-[11.5px] text-ink/66">
        {message}
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Remove ${title} from the standards`}
        title="Remove from the standards"
        onClick={() => setConfirming(true)}
        className={cn(
          "shrink-0 rounded-lg border border-transparent p-1.5 text-ink/38 transition-colors",
          "hover:border-warn-line hover:text-danger",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    );
  }

  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 rounded-lg border border-warn-line bg-warn-tint px-2.5 py-1.5 text-[11.5px]">
      <span className="text-ink/78">
        Remove “{title}”?{" "}
        {clauses > 0 ? (
          <>
            Assessments stop checking its {clauses} clause
            {clauses === 1 ? "" : "s"}.
          </>
        ) : (
          <>It has no clauses indexed yet.</>
        )}{" "}
        <span className="text-ink/58">Reports already written keep their wording.</span>
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={remove}
        className="font-medium text-warn underline underline-offset-2 hover:text-danger disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-ink/66 hover:text-ink/78"
      >
        Cancel
      </button>
    </span>
  );
}
