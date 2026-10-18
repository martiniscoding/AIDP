"use client";

import { useState } from "react";
import { BookPlus, Check, ChevronRight, CircleCheck, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { gapKey, type CoverageGap, type CoverageView } from "@/lib/ingest/coverage";
import type { TableView } from "@/lib/ingest/documents";
import { itemKey, useReviewMarks } from "@/lib/ingest/review-marks";
import { GapDialog } from "./ItemDialogs";

/**
 * A stable name for one gap, so a mark follows the gap rather than its
 * position: the coverage array is rewritten whole by the next assessment.
 */
function keyOf(gap: CoverageGap): string {
  return itemKey([
    gap.documentId ?? "",
    gap.section,
    gap.headingPath,
    gap.title,
    gap.quote.slice(0, 80),
  ]);
}

/**
 * The standard suggested for one gap, from the same design as the gap.
 *
 * Section ordinals restart in each design, so matching on the ordinal alone
 * attached one design's proposed standard to another design's gap.
 */
function standardFor(
  gap: CoverageGap,
  suggestions: CoverageView["suggestions"],
): CoverageView["suggestions"][number] | null {
  return (
    suggestions.find(
      (s) => (s.documentId ?? null) === (gap.documentId ?? null) && s.sections.includes(gap.section),
    ) ?? null
  );
}

/**
 * The report's "Absent" section: the parts of this design no standard covers.
 *
 * Not the clauses a design fails to address — the reverse. Each gap is a part of
 * the design that describes something no clause in the library governs, so no
 * finding above ever looked at it. It is shown with the design's own words,
 * checked against the document, because "nothing governs this" is a claim a
 * reader has to be able to test. Beneath them, the standards that would govern
 * those parts, which are a model's suggestions for whoever owns the library and
 * are labelled as exactly that.
 */
export function CoverageGaps({
  coverage,
  frameworkName,
  designCount = 1,
  runId,
  gapTables = {},
  idPrefix = "",
}: {
  coverage: CoverageView | null;
  /** Which run these gaps belong to, so a reviewer's marks reset on a re-run. */
  runId: string;
  frameworkName: string;
  /**
   * How many designs this run read. Needed separately from the gaps, because a
   * project report with no gaps at all still must not call three designs "this
   * design" — and with nothing in the list there is nothing to count.
   */
  designCount?: number;
  /** The tables a gap's quote was made of, by `gapKey`. */
  gapTables?: Record<string, TableView[]>;
  /** Keeps anchors unique where several designs' results share one page. */
  idPrefix?: string;
}) {
  // Before any early return: hooks cannot be conditional, and this component
  // returns early for a missing or incomplete coverage payload.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { marks, mark } = useReviewMarks(runId, "coverage");

  if (!coverage) {
    return (
      <Notice>
        This assessment ran before designs were checked for parts no standard covers. Run it
        again to see them.
      </Notice>
    );
  }
  if (coverage.state !== "complete") {
    return (
      <Notice warn>
        {coverage.note ??
          "The parts of this design no standard covers could not be worked out for this run."}
      </Notice>
    );
  }

  const { gaps, suggestions } = coverage;
  const plural = gaps.length === 1;
  const openIndex = openKey === null ? -1 : gaps.findIndex((gap) => keyOf(gap) === openKey);

  // A project run merges every design's gaps into one list, and each one says
  // which design it came from. Without that, "section 4 is ungoverned" names
  // nothing on a report covering three designs — and the sentences below used
  // to say "this design" over all of them.
  const several = designCount > 1;
  const named = several && gaps.some((gap) => gap.documentTitle);
  const subject = several ? `these ${designCount} designs` : "this design";

  return (
    <div className="space-y-7">
      <div className="space-y-1">
        <p className="text-[13px] leading-relaxed text-ink/76">
          {gaps.length === 0
            ? `Every part of ${subject} that describes the system is governed by at least one clause in ${frameworkName}.`
            : `${gaps.length} part${plural ? "" : "s"} of ${subject} describe${plural ? "s" : ""} something no clause in ${frameworkName} governs, so nothing in this assessment checked ${plural ? "it" : "them"}.`}
        </p>
        {coverage.truncated && (
          <p className="text-[12px] text-ink/62">
            Long sections were shortened to fit into one reading, so a gap inside a shortened part
            may have been missed.
          </p>
        )}
        {coverage.setAside > 0 && (
          <p className="text-[12px] text-ink/62">
            {coverage.setAside} more proposed by the model{" "}
            {coverage.setAside === 1 ? "was" : "were"} set aside: the quote was not in the section it
            was claimed for, a clause had already judged that passage, or the description said
            nothing a reader could act on.
          </p>
        )}
      </div>

      {gaps.length === 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-ok-line bg-ok-tint px-4 py-6 text-center text-[13px] text-ok">
          <CircleCheck size={15} aria-hidden="true" />
          Nothing in {several ? "these designs" : "this design"} falls outside your standards.
        </p>
      ) : (
        <>
          <ol className="space-y-2">
            {gaps.map((gap) => {
              const key = keyOf(gap);
              return (
                <Gap
                  key={key}
                  gap={gap}
                  showDesign={named}
                  mark={marks[key]}
                  onOpen={() => setOpenKey(key)}
                />
              );
            })}
          </ol>

          {/* One dialog for the list, stepping between gaps — the same
              arrangement the compliance and improvements tabs use. */}
          {openIndex >= 0 && (
            <GapDialog
              gap={gaps[openIndex]!}
              standard={standardFor(gaps[openIndex]!, suggestions)}
              tables={gapTables[gapKey(gaps[openIndex]!)]}
              mark={marks[keyOf(gaps[openIndex]!)]}
              onMark={(value) => {
                mark(keyOf(gaps[openIndex]!), value);
                // Decide and move on, as the other two tabs do. The last one
                // closes rather than sticking.
                const next = gaps[openIndex + 1];
                setOpenKey(next ? keyOf(next) : null);
              }}
              position={{ index: openIndex, total: gaps.length }}
              onNavigate={(delta) => {
                const next = gaps[openIndex + delta];
                if (next) setOpenKey(keyOf(next));
              }}
              onClose={() => setOpenKey(null)}
            />
          )}
        </>
      )}

      {suggestions.length > 0 && (
        <section aria-labelledby={`${idPrefix}suggested-standards`}>
          <h3
            id={`${idPrefix}suggested-standards`}
            className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink"
          >
            Suggested standards to add
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-ink/62">
            Written by a model from this design, as a starting point for whoever owns your
            standards library. They are not requirements on this design.
          </p>
          <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {suggestions.map((suggestion, index) => (
              <li
                key={`${index}-${suggestion.title}`}
                id={`${idPrefix}suggested-standard-${index}`}
                className="scroll-mt-24 rounded-xl border border-royal-mid/30 bg-royal/[0.04] px-4 py-3.5"
              >
                <p className="flex items-start gap-2 text-[13.5px] font-medium text-ink/92">
                  <BookPlus size={14} className="mt-0.5 shrink-0 text-royal" aria-hidden="true" />
                  {suggestion.title}
                </p>
                {suggestion.covers && (
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/76">
                    <span className="text-ink/58">Should govern: </span>
                    {suggestion.covers}
                  </p>
                )}
                {suggestion.why && (
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink/76">
                    <span className="text-ink/58">Why: </span>
                    {suggestion.why}
                  </p>
                )}
                <p className="mt-2 text-[11.5px] text-ink/60">
                  Would cover{" "}
                  {suggestion.sections
                    .map((section) =>
                      gaps.find(
                        (gap) =>
                          gap.section === section &&
                          (gap.documentId ?? null) === (suggestion.documentId ?? null),
                      ),
                    )
                    .filter((gap): gap is CoverageGap => gap !== undefined)
                    .map((gap) => gap.title || gap.headingPath)
                    .join(", ")}
                  {named && suggestion.documentTitle ? ` in ${suggestion.documentTitle}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Gap({
  gap,
  showDesign,
  mark,
  onOpen,
}: {
  gap: CoverageGap;
  /** Only on a project report, where the list crosses several designs. */
  showDesign: boolean;
  mark: "accepted" | "dismissed" | undefined;
  onOpen: () => void;
}) {
  const settled = mark !== undefined;
  const pages =
    gap.pageStart === null
      ? null
      : gap.pageEnd !== null && gap.pageEnd !== gap.pageStart
        ? `pages ${gap.pageStart}–${gap.pageEnd}`
        : `page ${gap.pageStart}`;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          settled
            ? "border-line bg-canvas-sunk/60 hover:bg-canvas-sunk"
            : "border-danger-line bg-card hover:border-line-strong",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("truncate text-[13.5px]", settled ? "text-ink/62" : "text-ink/88")}>
              {gap.title || gap.headingPath}
            </span>
            {showDesign && gap.documentTitle && (
              <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink/65">
                {gap.documentTitle}
              </span>
            )}
            {pages && <span className="font-mono text-[11.5px] text-ink/58">{pages}</span>}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-[12.5px] leading-relaxed",
              settled ? "text-ink/50" : "text-ink/66",
            )}
          >
            {gap.what}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink/62">
          {mark === "accepted" && (
            <span className="hidden items-center gap-1 rounded bg-ok-tint px-1.5 py-0.5 text-ok sm:inline-flex">
              <Check size={10} aria-hidden="true" />
              Marked
            </span>
          )}
          {mark === "dismissed" && (
            <span className="hidden items-center gap-1 rounded bg-canvas-sunk px-1.5 py-0.5 text-ink/68 sm:inline-flex">
              <X size={10} aria-hidden="true" />
              Dismissed
            </span>
          )}
          <ChevronRight size={14} className="text-ink/40" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

function Notice({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <p
      className={
        warn
          ? "rounded-xl border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn"
          : "rounded-xl border border-line bg-card px-4 py-5 text-center text-[13px] text-ink/66"
      }
    >
      {children}
    </p>
  );
}
