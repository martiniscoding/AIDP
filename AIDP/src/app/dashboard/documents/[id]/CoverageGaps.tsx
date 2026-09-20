import { BookPlus, CircleCheck } from "lucide-react";
import type { CoverageGap, CoverageView } from "@/lib/ingest/coverage";

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
  idPrefix = "",
}: {
  coverage: CoverageView | null;
  frameworkName: string;
  /** Keeps anchors unique where several designs' results share one page. */
  idPrefix?: string;
}) {
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

  return (
    <div className="space-y-7">
      <div className="space-y-1">
        <p className="text-[13px] leading-relaxed text-ink/76">
          {gaps.length === 0
            ? `Every part of this design that describes the system is governed by at least one clause in ${frameworkName}.`
            : `${gaps.length} part${plural ? "" : "s"} of this design describe${plural ? "s" : ""} something no clause in ${frameworkName} governs, so nothing in this assessment checked ${plural ? "it" : "them"}.`}
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
            was claimed for, or a clause had already judged that passage.
          </p>
        )}
      </div>

      {gaps.length === 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-ok-line bg-ok-tint px-4 py-6 text-center text-[13px] text-ok">
          <CircleCheck size={15} aria-hidden="true" />
          Nothing in this design falls outside your standards.
        </p>
      ) : (
        <ol className="space-y-2.5">
          {gaps.map((gap) => (
            <Gap
              key={gap.section}
              gap={gap}
              idPrefix={idPrefix}
              covering={suggestions
                .map((suggestion, index) => ({ suggestion, index }))
                .filter(({ suggestion }) => suggestion.sections.includes(gap.section))}
            />
          ))}
        </ol>
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
                    .map((section) => gaps.find((gap) => gap.section === section))
                    .filter((gap): gap is CoverageGap => gap !== undefined)
                    .map((gap) => gap.title || gap.headingPath)
                    .join(", ")}
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
  idPrefix,
  covering,
}: {
  gap: CoverageGap;
  idPrefix: string;
  covering: { suggestion: CoverageView["suggestions"][number]; index: number }[];
}) {
  const pages =
    gap.pageStart === null
      ? null
      : gap.pageEnd !== null && gap.pageEnd !== gap.pageStart
        ? `pages ${gap.pageStart}–${gap.pageEnd}`
        : `page ${gap.pageStart}`;

  return (
    <li className="rounded-xl border border-danger-line bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-[14px] font-medium text-ink/92">{gap.title || gap.headingPath}</p>
        {pages && <p className="text-[11.5px] text-ink/60 tabular-nums">{pages}</p>}
      </div>
      {gap.headingPath && gap.headingPath !== gap.title && (
        <p className="mt-0.5 text-[11.5px] break-words text-ink/58">{gap.headingPath}</p>
      )}
      {gap.what && (
        <p className="mt-2 text-[13px] leading-relaxed text-ink/80">{gap.what}</p>
      )}
      <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-[12.5px] leading-relaxed text-ink/70">
        “{gap.quote}”
        {gap.page !== null && (
          <span className="ml-1.5 text-[11.5px] whitespace-nowrap text-ink/58">p. {gap.page}</span>
        )}
      </blockquote>
      {covering.length > 0 && (
        <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink/62">
          Suggested standard:
          {covering.map(({ suggestion, index }) => (
            <a
              key={index}
              href={`#${idPrefix}suggested-standard-${index}`}
              className="rounded-full border border-royal/30 bg-royal-tint px-2 py-0.5 text-royal-deep transition-colors hover:bg-royal/15"
            >
              {suggestion.title}
            </a>
          ))}
        </p>
      )}
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
