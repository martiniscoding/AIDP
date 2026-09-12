import { ChevronRight, Quote } from "lucide-react";
import { cn } from "@/lib/cn";
import { VERDICTS, VERDICT_META, type Verdict } from "@/lib/ingest/verdicts";
import type { ComparedFinding, ComparisonRow, ComparisonView } from "@/lib/ingest/comparison";

const TONE: Record<string, string> = {
  bad: "border-danger-line bg-danger-tint text-danger",
  warn: "border-warn-line bg-warn-tint text-warn",
  unknown: "border-line bg-card text-ink/72",
  good: "border-royal-mid/30 bg-royal/8 text-royal",
};

function meta(verdict: string) {
  return VERDICT_META[verdict as Verdict] ?? VERDICT_META.needs_review;
}

/**
 * The two assessment modes, side by side.
 *
 * Read for its disagreements. Where search and a reading of the whole document
 * reach different verdicts, one of them missed something — a passage the
 * search never surfaced, or a reading that overlooked one — and the quotes and
 * passages under each verdict are how a reviewer tells which. Agreements are
 * folded: they are the reassurance, not the work.
 */
export function Comparison({ view }: { view: ComparisonView }) {
  const differ = view.rows.filter((row) => !row.agree);
  const same = view.rows.filter((row) => row.agree);

  const count = (side: "search" | "whole", verdict: string) =>
    view.rows.filter((row) => row[side]?.verdict === verdict).length;

  return (
    <section className="mb-10">
      <div className="mb-3">
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Search vs whole document
        </h2>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink/64">
          {view.agreed} of {view.rows.length} clauses reached the same verdict both ways. Where
          they differ, one of the two readings missed something — the quotes and passages under
          each verdict show which.
        </p>
      </div>

      <div className="mb-4 overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[420px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-ink/62">
              <th className="px-3 py-2 font-normal">Verdict</th>
              <th className="px-3 py-2 font-normal">Search</th>
              <th className="px-3 py-2 font-normal">Whole document</th>
            </tr>
          </thead>
          <tbody>
            {VERDICTS.map((verdict) => (
              <tr key={verdict} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-1.5 text-ink/80">{VERDICT_META[verdict].label}</td>
                <td className="px-3 py-1.5 tabular-nums text-ink/80">{count("search", verdict)}</td>
                <td className="px-3 py-1.5 tabular-nums text-ink/80">{count("whole", verdict)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {differ.length === 0 ? (
        <p className="rounded-xl border border-ok-line bg-ok-tint px-4 py-4 text-center text-[13px] text-ok">
          Both readings reached the same verdict on every clause.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {differ.map((row) => (
            <li key={row.clauseId}>
              <Disagreement row={row} />
            </li>
          ))}
        </ul>
      )}

      {same.length > 0 && (
        <details className="group mt-3 rounded-xl border border-line bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] text-ink/80 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={13} className="text-ink/58 transition-transform group-open:rotate-90" />
            Same verdict both ways ({same.length})
          </summary>
          <ul className="border-t border-line px-4 py-2">
            {same.map((row) => (
              <li
                key={row.clauseId}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12.5px]"
              >
                <span className="min-w-0 text-ink/80">
                  <span className="mr-2 font-mono text-[11px] text-ink/58">{row.clauseRef}</span>
                  {row.clauseTitle}
                </span>
                {row.whole && <Chip verdict={row.whole.verdict} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Chip({ verdict }: { verdict: string }) {
  const m = meta(verdict);
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-[11.5px]", TONE[m.tone])}>
      {m.label}
    </span>
  );
}

function Disagreement({ row }: { row: ComparisonRow }) {
  return (
    <div className="rounded-xl border border-line bg-card">
      <p className="border-b border-line px-4 py-2.5 text-[13.5px] font-medium text-ink/90">
        <span className="mr-2 font-mono text-[11px] font-normal text-ink/58">{row.clauseRef}</span>
        {row.clauseTitle}
      </p>
      <div className="grid gap-0 md:grid-cols-2">
        <Side label="Search" finding={row.search} />
        <Side label="Whole document" finding={row.whole} bordered />
      </div>
    </div>
  );
}

function Side({
  label,
  finding,
  bordered = false,
}: {
  label: string;
  finding: ComparedFinding | null;
  bordered?: boolean;
}) {
  return (
    <div className={cn("min-w-0 px-4 py-3", bordered && "border-t border-line md:border-l md:border-t-0")}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] uppercase tracking-[0.08em] text-ink/58">{label}</span>
        {finding ? (
          <>
            <Chip verdict={finding.verdict} />
            <span className="text-[11.5px] text-ink/58">{Math.round(finding.confidence * 100)}%</span>
          </>
        ) : (
          <span className="text-[12px] text-ink/58">Not assessed</span>
        )}
      </div>
      {finding && (
        <>
          <p className="text-[12.5px] leading-relaxed text-ink/78">{finding.rationale}</p>
          {finding.evidence.slice(0, 2).map((item) => (
            <blockquote
              key={item.chunkId}
              className="mt-2 border-l-2 border-line pl-2.5 text-[12px] leading-relaxed text-ink/70"
            >
              <span className="mb-0.5 flex items-center gap-1 text-[11px] text-ink/56">
                {item.sourceKind === "quote" && <Quote size={9} />}
                {item.sourceKind === "quote" ? "Quoted, checked word for word" : item.headingPath}
                {item.page != null && ` · page ${item.page}`}
              </span>
              <span className="line-clamp-4 break-words">{item.excerpt}</span>
            </blockquote>
          ))}
        </>
      )}
    </div>
  );
}
