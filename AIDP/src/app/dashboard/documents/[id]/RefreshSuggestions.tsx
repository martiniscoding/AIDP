"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { refreshSuggestions } from "../actions";

/**
 * Ask for a new set of suggested improvements.
 *
 * Suggestions are reused while the design and the standards stay the same, so
 * running the assessment again gives the same set. This is the one way to get a
 * different one: it redoes the suggestions alone, keeps the findings as they are,
 * and the new set replaces the reused one from then on.
 *
 * Not disabled merely because a request is on record as in progress: a request
 * whose job was lost would otherwise leave the button dead for good. The action
 * refuses a second request while one is really running, and says so.
 */
export function RefreshSuggestions({
  runId,
  refreshing,
  label,
}: {
  runId: string;
  refreshing: boolean;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const working = pending || refreshing;

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await refreshSuggestions(runId);
            setMessage(result.ok ? null : result.message);
            router.refresh();
          })
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] text-ink/72 transition-colors",
          "hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-55",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        )}
      >
        <RefreshCw
          size={12}
          aria-hidden="true"
          className={working ? "motion-safe:animate-spin" : undefined}
        />
        {working ? "Working out new suggestions…" : label}
      </button>
      {message && (
        <span role="status" className="max-w-xs text-right text-[11.5px] text-warn">
          {message}
        </span>
      )}
    </span>
  );
}
