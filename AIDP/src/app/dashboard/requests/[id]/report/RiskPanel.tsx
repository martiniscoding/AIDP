import { AlertTriangle, CircleHelp, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { BRIEF_SEVERITY_LABEL, type BriefSeverity } from "@/lib/ingest/verdicts";
import type { RiskView } from "@/lib/ingest/risk";

/**
 * Risk, along the five dimensions the brief names.
 *
 * Read-only and server-rendered: it draws what `buildRisk` worked out and
 * decides nothing of its own. The one thing it has to get right is the
 * difference between a dimension that was looked at and found quiet, and one
 * nothing in the run could speak to — so an unassessed row is drawn as a
 * question rather than as a clean bill of health, and never carries a grade.
 */

const TONE: Record<BriefSeverity, string> = {
  critical: "border-danger-line bg-danger-tint text-danger",
  high: "border-warn-line bg-warn-tint text-warn",
  medium: "border-warn-line bg-warn-tint text-warn",
  low: "border-line bg-canvas-sunk text-ink/70",
};

export function RiskPanel({ risk }: { risk: RiskView }) {
  const assessed = risk.rows.filter((row) => row.assessed);

  return (
    <section className="rounded-xl border border-line bg-card">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[13.5px] font-medium text-ink">Risk</h2>
        <p className="mt-0.5 text-[12px] text-ink/60">
          {assessed.length === 0
            ? "Nothing in this run spoke to any of these. That is not the same as nothing being wrong."
            : `${assessed.length} of ${risk.rows.length} dimensions could be assessed from this submission.`}
        </p>
      </div>

      <ul className="divide-y divide-line">
        {risk.rows.map((row) => (
          <li key={row.dimension} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-[13px] font-medium",
                    row.assessed ? "text-ink" : "text-ink/55",
                  )}
                >
                  {row.label}
                </p>
                <p className="mt-0.5 text-[12px] text-ink/55">{row.blurb}</p>
              </div>

              {/* The grade, or the absence of one. An unassessed dimension shows
                  a question, not a dash that reads as "clear". */}
              {row.assessed && row.severity ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium",
                    TONE[row.severity],
                  )}
                >
                  {BRIEF_SEVERITY_LABEL[row.severity]}
                </span>
              ) : row.assessed ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ok-line bg-ok-tint px-2.5 py-0.5 text-[11.5px] text-ok">
                  <Minus size={11} aria-hidden="true" />
                  Nothing raised
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-ink/55">
                  <CircleHelp size={11} aria-hidden="true" />
                  Not assessed
                </span>
              )}
            </div>

            {row.clauses.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {row.clauses.slice(0, 6).map((clause) => (
                  <li
                    key={clause.ref}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11.5px]",
                      TONE[clause.severity],
                    )}
                  >
                    {clause.ref}
                    {/* An unsettled grade is the engine saying a person has to
                        look. It travels with the number, because "Low" on its
                        own reads as "small". */}
                    {!clause.settled && <span className="opacity-70"> · unsettled</span>}
                  </li>
                ))}
                {row.clauses.length > 6 && (
                  <li className="px-1 py-0.5 text-[11.5px] text-ink/50">
                    +{row.clauses.length - 6} more
                  </li>
                )}
              </ul>
            )}

            {row.notes.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {row.notes.map((note) => (
                  <li key={note} className="flex gap-1.5 text-[12px] text-ink/70">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                    {note}
                  </li>
                ))}
              </ul>
            )}

            {!row.assessed && (
              <p className="mt-1.5 text-[12px] text-ink/50">
                {row.dimension === "lock_in"
                  ? "This run predates the vendor lock-in check, or the design said nothing a reviewer could weigh. Support dates are not evidence about it."
                  : "Nothing in this submission spoke to it."}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
