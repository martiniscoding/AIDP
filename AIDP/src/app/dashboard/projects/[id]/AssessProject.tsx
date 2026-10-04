"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Layers, RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { startProjectAssessment } from "../actions";

export type ProjectRunSummary = {
  state: string;
  totalClauses: number;
  completedClauses: number;
  orphaned: boolean;
  /** Findings worth a reviewer's attention: everything the designs are not silent on. */
  reported: number;
  open: number;
  failureReason: string | null;
};

/**
 * Assessing the project as a whole.
 *
 * A design document rarely stands alone, and judged one at a time the answers
 * in one file were reported as gaps in another. This is the way in: one run
 * over every design, and the report it produces.
 *
 * Centred and stated as the action it is, for the same reason "New project" is
 * — it is the thing this page exists to let somebody do, and as a small
 * outlined control beside the designs it read as a caption.
 */
export function AssessProject({
  projectId,
  designs,
  unready,
  archived,
  run,
}: {
  projectId: string;
  /** Designs that have finished processing, and so can be read. */
  designs: number;
  unready: number;
  archived: boolean;
  run: ProjectRunSummary | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const live = run !== null && !run.orphaned && (run.state === "queued" || run.state === "running");
  const begin = () =>
    startTransition(async () => {
      const result = await startProjectAssessment(projectId);
      setMessage(result.message);
      router.refresh();
    });

  const blocked = archived || designs === 0;

  return (
    <section
      className={cn(
        "mb-7 rounded-2xl border border-line bg-card p-5 shadow-card",
        "flex flex-col items-center gap-3 text-center",
      )}
    >
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Assess the whole project
        </h2>
        <p className="mx-auto mt-1.5 max-w-xl text-[12.5px] text-ink/64">
          Every clause judged once against all{" "}
          {designs === 1 ? "of this project's designs" : `${designs} designs`} together, so what one
          design leaves out another can answer.
          {unready > 0 && (
            <>
              {" "}
              <span className="text-warn">
                {unready} more {unready === 1 ? "is" : "are"} still being processed.
              </span>
            </>
          )}
        </p>
      </div>

      {run && (
        <p className="text-[12px] text-ink/66">
          {live
            ? run.state === "queued"
              ? "Waiting for a worker to pick it up…"
              : `Assessing — ${run.completedClauses} of ${run.totalClauses} clauses`
            : run.state === "complete"
              ? `Last run: ${run.reported} finding${run.reported === 1 ? "" : "s"} to read` +
                (run.open > 0 ? `, ${run.open} contradicting a standard` : "")
              : run.orphaned
                ? "The last run never started — its job was lost. Start another."
                : `Last run failed. ${run.failureReason ?? ""}`.trim()}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          onClick={begin}
          disabled={pending || live || blocked}
          className={cn(
            "inline-flex items-center gap-2 rounded-full bg-royal px-5 py-2.5",
            "text-[14px] font-medium text-white shadow-card",
            "transition-[transform,box-shadow] duration-300",
            "hover:-translate-y-0.5 hover:shadow-card-hover",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
            "disabled:translate-y-0 disabled:opacity-40 disabled:shadow-card",
          )}
        >
          {pending ? (
            <RotateCw size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Layers size={15} aria-hidden="true" />
          )}
          {run ? "Assess again" : "Assess all designs together"}
        </button>

        {run && (
          <Link
            href={`/dashboard/projects/${projectId}/assessment`}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-[13px] text-ink/78 transition-colors hover:border-royal/40 hover:text-ink"
          >
            Open the report
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>

      {/* Why the button is off, rather than leaving somebody to guess. */}
      {blocked && (
        <p className="text-[12px] text-ink/58">
          {archived
            ? "This project is archived. Reopen it to assess the designs inside."
            : unready > 0
              ? "Wait for the designs to finish processing."
              : "Add a design first."}
        </p>
      )}
      {message && (
        <p role="status" className="text-[12.5px] text-ink/72">
          {message}
        </p>
      )}
    </section>
  );
}
