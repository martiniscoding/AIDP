import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DesignResult as Result } from "@/lib/ingest/results";

const TONE: Record<string, string> = {
  bad: "border-danger-line bg-danger-tint text-danger",
  warn: "border-warn-line bg-warn-tint text-warn",
  unknown: "border-line bg-card text-ink/72",
  good: "border-royal-mid/30 bg-royal/8 text-royal",
};

/**
 * A design's latest finished assessment, beneath the design on its project page.
 *
 * Counts only. What each finding says, its evidence and the uncovered parts of
 * the design are read on the document's own page, which this links to, along
 * with confirming, overriding and re-running.
 */
export function DesignResult({
  result,
  documentId,
  title,
}: {
  result: Result;
  documentId: string;
  title: string;
}) {
  const coverage = result.coverage;
  const gaps = coverage?.state === "complete" ? coverage.gaps.length : null;

  const chips: { label: string; count: number | null; tone: string }[] = [
    { label: "Contradicts", count: result.counts.contradicts, tone: "bad" },
    { label: "Absent", count: gaps, tone: "bad" },
    { label: "Partial", count: result.counts.partial, tone: "warn" },
    { label: "Needs review", count: result.counts.needs_review, tone: "unknown" },
    { label: "Covered", count: result.counts.covered, tone: "good" },
  ];

  return (
    <section
      aria-label={`Assessment result for ${title}`}
      className="border-t border-line bg-canvas/40 px-4 pt-3.5 pb-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium text-ink/88">Assessment result</h3>
        <p className="text-[11.5px] text-ink/60">
          {result.frameworkName} v{result.frameworkVersion}
          {result.mode === "document" ? " · read the whole design" : " · by search"}
          {result.completedAt &&
            ` · ${result.completedAt.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}`}
        </p>
      </div>

      {result.superseding && (
        <p className="mt-1 text-[11.5px] text-ink/62">
          A newer assessment is under way. This is the last one that finished.
        </p>
      )}

      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Summary">
        {chips.map((chip) => (
          <li
            key={chip.label}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]",
              TONE[chip.tone],
              chip.count === 0 && "opacity-40",
            )}
          >
            <span className="font-display text-[14px] font-semibold tabular-nums">
              {chip.count ?? "—"}
            </span>
            {chip.label}
          </li>
        ))}
      </ul>

      <Link
        href={`/dashboard/documents/${documentId}`}
        className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-royal transition-colors hover:text-ink"
      >
        Open the full report
        <ArrowRight size={12} aria-hidden="true" />
      </Link>
    </section>
  );
}
