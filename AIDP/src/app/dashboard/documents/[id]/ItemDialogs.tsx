"use client";

import { Check, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { CATEGORY_LABEL, type AdvicePriority, type Suggestion } from "@/lib/ingest/advice";
import type { CoverageGap, StandardSuggestion } from "@/lib/ingest/coverage";
import type { TableView } from "@/lib/ingest/documents";
import { TableFigure } from "@/components/ui/TableFigure";
import type { Mark } from "@/lib/ingest/review-marks";
import { Actions, Box, ReviewDialog } from "./ReviewDialog";

/**
 * The improvement and design-gap dialogs.
 *
 * Both are the compliance dialog's twin by design: same shell, same position
 * counter, same keys, same box rhythm, so a reviewer who has worked one tab
 * can work the others without learning anything new. What differs is only
 * what each one is about — a suggestion is advice on the design, a gap is a
 * standard the library is missing — and the decision each one offers.
 *
 * Neither decision reaches the database. Suggestions and gaps are JSON on the
 * run, rewritten whole by the next assessment, so there is no row to carry
 * "accepted" on; see src/lib/ingest/review-marks.ts. The marks are this
 * browser's, and each dialog says so rather than implying a shared backlog.
 */

const PRIORITY_TONE: Record<AdvicePriority, string> = {
  high: "border-royal-mid/40 bg-royal-tint text-royal-deep",
  medium: "border-line-strong bg-canvas-sunk text-ink/80",
  low: "border-line bg-card text-ink/62",
};

const PRIORITY_LABEL: Record<AdvicePriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-[11px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Where a passage came from, written the way a reviewer would look for it. */
function where(headingPath: string, sectionTitle: string, page: number | null): string {
  const path = headingPath
    .split("›")
    .map((part) => part.trim())
    .filter(Boolean);
  const name = path.length ? path[path.length - 1]! : sectionTitle;
  return page === null ? name : `${name} · page ${page}`;
}

/** The design's own words, quoted. Shared so both dialogs cite identically. */
function Quote({ text, cite }: { text: string; cite: string }) {
  return (
    <blockquote className="rounded-lg border border-line bg-card px-3 py-2.5">
      <p className="text-[13px] leading-relaxed text-ink/82">{text}</p>
      <p className="mt-1.5 text-[11.5px] text-ink/58">{cite}</p>
    </blockquote>
  );
}

/**
 * The decision row, and the sentence that keeps it honest.
 *
 * A primary action and a dismissal, plus a line saying where the decision is
 * kept. Both buttons advance to the next item, which is the whole point of the
 * pattern: a reviewer with thirty suggestions decides and moves, rather than
 * deciding, closing, finding their place and opening the next one.
 */
function Decide({
  mark,
  onAccept,
  onDismiss,
  acceptLabel,
  acceptedLabel,
}: {
  mark: Mark | undefined;
  onAccept: () => void;
  onDismiss: () => void;
  acceptLabel: string;
  acceptedLabel: string;
}) {
  return (
    <>
      <Actions>
        <button
          type="button"
          onClick={onAccept}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium",
            "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
            mark === "accepted"
              ? "bg-ok-tint text-ok ring-1 ring-ok-line"
              : "bg-royal text-white hover:bg-royal-mid",
          )}
        >
          {mark === "accepted" ? <Check size={12} /> : <Plus size={12} />}
          {mark === "accepted" ? acceptedLabel : acceptLabel}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px]",
            "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
            mark === "dismissed"
              ? "border-line-strong bg-canvas-sunk text-ink/72"
              : "border-line text-ink/68 hover:border-line-strong hover:text-ink",
          )}
        >
          <X size={12} />
          {mark === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </Actions>

      {/* Said plainly, because a button that looks like it filed a ticket and
          did not would be worse than no button. */}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink/55">
        Kept in this browser so you can see what you have been through. It is not shared
        with your team and does not survive a new assessment — the suggestions are
        rewritten each run.
      </p>
    </>
  );
}

export function ImprovementDialog({
  suggestion,
  mark,
  onMark,
  position,
  onNavigate,
  onClose,
}: {
  suggestion: Suggestion;
  mark: Mark | undefined;
  onMark: (value: Mark) => void;
  position: { index: number; total: number };
  onNavigate: (delta: number) => void;
  onClose: () => void;
}) {
  return (
    <ReviewDialog
      position={position}
      onNavigate={onNavigate}
      onClose={onClose}
      title={suggestion.title}
      badges={
        <>
          <Chip className={PRIORITY_TONE[suggestion.priority]}>
            {PRIORITY_LABEL[suggestion.priority]}
          </Chip>
          <Chip className="border-line bg-card text-ink/70">
            {CATEGORY_LABEL[suggestion.category]}
          </Chip>
          {suggestion.component && (
            <span className="font-mono text-[11.5px] text-ink/62">{suggestion.component}</span>
          )}
        </>
      }
      subtitle={where(suggestion.headingPath, suggestion.sectionTitle, suggestion.page)}
    >
      <Box label="Context in design">
        {suggestion.quote ? (
          <Quote
            text={suggestion.quote}
            cite={where(suggestion.headingPath, suggestion.sectionTitle, suggestion.page)}
          />
        ) : (
          /* An "add" suggestion is about something the design does not say, so
             there is nothing to quote. Saying that is better than an empty box
             a reader takes for a failed render. */
          <p className="text-[13px] leading-relaxed text-ink/66">
            This is about something the design does not state, so there is no passage to
            quote. It concerns{" "}
            <span className="text-ink/82">
              {where(suggestion.headingPath, suggestion.sectionTitle, suggestion.pageStart)}
            </span>
            .
          </p>
        )}
      </Box>

      <Box label="Why it matters">
        <p className="text-[13px] leading-relaxed text-ink/82">{suggestion.why}</p>
      </Box>

      <Box label="Suggested action">
        <p className="text-[13px] leading-relaxed text-ink/82">{suggestion.recommendation}</p>
      </Box>

      {suggestion.clauses.length > 0 && (
        <Box label="Related findings">
          <p className="text-[12.5px] leading-relaxed text-ink/70">
            Goes further than {suggestion.clauses.length === 1 ? "a finding" : "findings"} already
            reported against {suggestion.clauses.join(", ")}.
          </p>
        </Box>
      )}

      <Decide
        mark={mark}
        onAccept={() => onMark("accepted")}
        onDismiss={() => onMark("dismissed")}
        acceptLabel="Accept this improvement"
        acceptedLabel="Accepted"
      />
    </ReviewDialog>
  );
}

export function GapDialog({
  gap,
  standard,
  tables,
  mark,
  onMark,
  position,
  onNavigate,
  onClose,
}: {
  gap: CoverageGap;
  /** The standard the engine proposes for this gap, where it offered one. */
  standard: StandardSuggestion | null;
  /**
   * The tables the quote was assembled from, where it was.
   *
   * A fifth of this corpus's evidence is table cells printed as one run-on
   * line — "Category: Languages | Comments: V 11" is a row with its empty
   * columns dropped. Showing the table instead is what the inline view did,
   * and losing it in the move to a dialog would have been a regression.
   */
  tables?: TableView[];
  mark: Mark | undefined;
  onMark: (value: Mark) => void;
  position: { index: number; total: number };
  onNavigate: (delta: number) => void;
  onClose: () => void;
}) {
  return (
    <ReviewDialog
      position={position}
      onNavigate={onNavigate}
      onClose={onClose}
      title={gap.title || gap.headingPath}
      badges={
        <>
          <Chip className="border-royal-mid/40 bg-royal-tint text-royal-deep">
            No standard covers this
          </Chip>
          <span className="font-mono text-[11.5px] text-ink/62">
            {where(gap.headingPath, gap.title, gap.page)}
          </span>
        </>
      }
      subtitle="A part of the design no clause in your framework governs, so nothing in this assessment checked it."
    >
      <Box label="Design evidence">
        {tables && tables.length > 0 ? (
          <div className="space-y-2">
            {tables.map((table) => (
              <TableFigure key={table.id} table={table} caption="Quoted from this table" />
            ))}
          </div>
        ) : (
          <Quote text={gap.quote} cite={where(gap.headingPath, gap.title, gap.page)} />
        )}
      </Box>

      <Box label="Governance gap">
        <p className="text-[13px] leading-relaxed text-ink/82">{gap.what}</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/64">
          Your reference library holds no clause that governs this, so the assessment could
          neither pass nor fail it. That is a gap in the standards, not in the design.
        </p>
      </Box>

      {standard ? (
        <Box label="Recommended standard">
          <div className="rounded-lg border border-line bg-card px-3 py-2.5">
            <p className="font-display text-[13px] font-semibold text-ink">{standard.title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink/78">{standard.covers}</p>
            {standard.why && (
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/62">{standard.why}</p>
            )}
          </div>
        </Box>
      ) : (
        <Box label="Recommended standard">
          <p className="text-[13px] leading-relaxed text-ink/66">
            The engine did not propose wording for this one. Adding a clause that governs it to
            your reference library will bring it into the next assessment.
          </p>
        </Box>
      )}

      <Decide
        mark={mark}
        onAccept={() => onMark("accepted")}
        onDismiss={() => onMark("dismissed")}
        acceptLabel="Mark for the standards library"
        acceptedLabel="Marked"
      />
    </ReviewDialog>
  );
}
