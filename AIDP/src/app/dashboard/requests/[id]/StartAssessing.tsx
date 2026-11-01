"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { startAssessing } from "../actions";

/**
 * The button the intake flow ends on.
 *
 * A request used to assess itself. Indexing finished, the embed worker pinged
 * the app, and a run opened with nobody watching — which was right while the
 * only thing being assessed was the rendered intake form, because there was
 * nothing left for a person to add. The designs live inside the request now, so
 * the moment a submission is complete is a judgement its author makes, not one
 * the queue can infer from the last document to finish embedding.
 *
 * ## Why the refusal is shown rather than prevented
 *
 * Every reason this can be refused is checked again on the server — see
 * `startAssessment` — and some of them cannot be known here at all: whether the
 * standards library has anything indexed in it, whether a document failed to
 * parse, whether somebody else pressed this a second ago. So the button does
 * not try to decide in advance whether it will work. It asks, and shows what
 * came back.
 *
 * That is also why there is no optimistic state. A run that was refused and a
 * run that is starting look identical for the second the request takes, and
 * guessing wrong here means telling somebody their design is being assessed
 * when it is not.
 */
export function StartAssessing({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await startAssessing(id);
            if (result.ok) {
              // The page reads the request's state on the server, so the new
              // one arrives with the refresh rather than being set here.
              router.refresh();
            } else {
              setError(result.message);
            }
          })
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5",
          "text-[13px] font-medium text-white cursor-pointer",
          "transition-opacity disabled:cursor-default disabled:opacity-50",
        )}
      >
        <Play size={14} aria-hidden="true" />
        {pending ? "Starting…" : "Start assessing"}
      </button>

      {error && (
        <p
          role="status"
          className="mt-2 rounded-xl border border-warn-line bg-warn-tint px-3.5 py-2.5 text-[12.5px] text-ink/80"
        >
          {error}
        </p>
      )}
    </div>
  );
}
