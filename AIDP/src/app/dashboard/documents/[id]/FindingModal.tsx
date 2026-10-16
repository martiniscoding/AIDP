"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Scale,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  OBLIGATION_META,
  SEVERITY_META,
  VERDICTS,
  VERDICT_META,
  severityOf,
  type Verdict,
} from "@/lib/ingest/verdicts";
import { EFFECT_META, SCOPE_META, type DecisionScope } from "@/lib/ingest/decision-effects";
import { rationaleSections } from "@/lib/ingest/verdicts";
import type { EvidenceView } from "@/lib/ingest/evidence-tables";
import { TableFigure } from "@/components/ui/TableFigure";
import { makeStandard, reviewFinding } from "../actions";
import {
  Excerpt,
  StandardProposal,
  TONE,
  type FindingView,
  type ProjectRef,
} from "./Assessment";
import { SeverityTag } from "./SeverityTag";


/**
 * What each design actually says, for the comparison a contradiction is.
 *
 * Only the passages the judge named as the conflict and the worker verified
 * word for word against the text the model was shown — see `_mark_conflict`
 * in analyse.py. Nothing is inferred here and nothing is chosen here.
 *
 * It used to take the first retrieved passage per design, which is a guess:
 * retrieval ranks passages for the judge to read, not for being the sentence
 * that breaks the clause. Over one project's fifteen contradictions that
 * guess quoted a design the finding never mentions twenty times out of forty,
 * and twice put a design's own remediation plan in its mouth as the breach.
 * Where no quote was verified the comparison is not drawn at all.
 */
function designVoices(evidence: EvidenceView[]): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!item.conflictQuote || seen.has(item.documentId)) continue;
    seen.add(item.documentId);
    out.push({ title: item.documentTitle, text: item.conflictQuote });
  }
  return out;
}

/**
 * The reading measure for prose in this dialog.
 *
 * The panel is `max-w-3xl` because a table needs the width. Prose does not:
 * at 768px less its padding, a 13px line ran to about 112 characters, where
 * comfortable reading is 45 to 75. The panel keeps its width for the evidence
 * and the text inside it stops before the edge.
 */
const PROSE_MEASURE = "max-w-[68ch]";

/** Past this, the clause is folded behind a control rather than printed. */
const CLAUSE_CLAMP = 320;

/**
 * One finding, in full, over the list.
 *
 * The list is a queue: eighty rows a reviewer triages by severity, where the
 * detail of any one is three sentences, a handful of quotes and a decision to
 * take. Expanding that in place pushed the rest of the queue off screen, so
 * working down the list meant scrolling back to find your place — and with
 * every row expandable, the page read as a wall of text whichever row was open.
 *
 * So the detail comes over the top and the queue stays where it is. The
 * reviewer reads, decides, and this closes onto the same list position with
 * that row marked settled. Nothing here is new behaviour: it is the panel that
 * used to open inside the row, with the decision controls it always had.
 *
 * Dismissal is the usual three — Escape, the close button, the backdrop — and
 * focus moves in on open, because a reviewer working a queue from the keyboard
 * should not be dropped at the top of the document between findings.
 */
export function FindingModal({
  finding,
  project,
  mayCurate,
  position,
  onNavigate,
  onClose,
}: {
  finding: FindingView;
  project: ProjectRef | null;
  /** Whether this person may change the standards. See canManageStandards. */
  mayCurate: boolean;
  /** Where this finding sits in the list on screen, for "3 of 41". */
  position: { index: number; total: number };
  /** Step by -1 or +1 through the list behind the dialog. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /**
   * Which decision panel is open, if any.
   *
   * "allow" is an override with its answers already filled in: the design
   * stands, the clause is satisfied for this piece of work, and nothing else
   * inherits that. A board allows a breach for one migration far more often
   * than it rewrites the standard.
   */
  const [mode, setMode] = useState<"confirm" | "override" | "allow" | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<DecisionScope>("organisation");
  // Which finding's clause is unfolded, rather than a boolean that would
  // have to be reset every time the dialog steps to another one.
  const [clauseOpenFor, setClauseOpenFor] = useState<string | null>(null);
  // Key disclosure state to the finding itself. As soon as navigation changes
  // the finding id, the new finding renders collapsed without waiting for an
  // effect (including when navigation comes from the keyboard).
  const [evidenceOpenFor, setEvidenceOpenFor] = useState<string | null>(null);

  const panel = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const hasPrev = position.index > 0;
  const hasNext = position.index < position.total - 1;
  const isEvidenceExpanded = evidenceOpenFor === finding.id;

  const navigate = useCallback((delta: number) => {
    // Clear even if the reviewer later returns to this same finding; the
    // evidence accordion is reset by each navigation action, not just when a
    // different id happens to render.
    setEvidenceOpenFor(null);
    onNavigate(delta);
  }, [onNavigate]);

  // Escape closes, and the page behind does not scroll while this is up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      /**
       * Arrow keys and j/k step through the list, except while typing.
       *
       * The justification box is a textarea inside this dialog, and a reviewer
       * writing "k" in a sentence must not be thrown onto the next finding. So
       * anything with a text caret keeps its keystrokes, and a modifier means
       * the shortcut was not meant for us either.
       */
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "ArrowLeft" || event.key === "k") {
        event.preventDefault();
        navigate(-1);
      } else if (event.key === "ArrowRight" || event.key === "j") {
        event.preventDefault();
        navigate(1);
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, navigate]);

  /**
   * Scroll back to the top when the dialog moves to another finding.
   *
   * Without this, stepping from a long finding to a short one opens the next
   * one already scrolled past its own gap — the one line the reader most needs.
   */
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [finding.id]);

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const severity = severityOf(finding.verdict, finding.obligation);
  const hasQuotedText = finding.evidence.some((item) => item.sourceKind === "quote");
  const hasExtractedText = finding.evidence.some(
    (item) => item.sourceKind !== "quote" && item.sourceKind !== "figure",
  );
  const hasDiagramDescription = finding.evidence.some((item) => item.sourceKind === "figure");
  const evidenceBasis =
    finding.evidence.length === 0
      ? "No source passage cited"
      : [
          hasQuotedText && "Source quotation checked against the document",
          hasExtractedText && "Extracted source text",
          hasDiagramDescription && "Model-described diagram; inspect the original figure",
        ]
          .filter(Boolean)
          .join(" · ");
  const decided = finding.reviewerState !== "pending";
  // "Gap / Impact / Fix" on a clause that passed contradicts its own
  // verdict, so a covered finding is labelled as the description it is.
  const clauseOpen = clauseOpenFor === finding.id;
  const sections = rationaleSections(finding.rationale, finding.verdict);
  // The clause against the design's own words, for the one verdict that is
  // a comparison. Only when both halves exist — half of it is the paragraph
  // it already was.
  const voices = finding.verdict === "contradicts" ? designVoices(finding.evidence) : [];
  const facing = voices.length > 0 && Boolean(finding.clauseStatement);
  const draft = finding.draft;

  /**
   * Offered on a breach, and only with a project to confine it to. Not on
   * "partial" or "needs_review": those are arguments about what the design
   * says, and the answer to them is a verdict, not a dispensation.
   */
  const allowable = finding.verdict === "contradicts" && project !== null && !decided;

  /**
   * Offered on a confirmed `partial`, and nothing else. A partial somebody has
   * agreed with is the system saying it could not judge the clause as written —
   * the one verdict whose cause may be the wording rather than the design.
   */
  const sharpenable =
    mayCurate &&
    finding.verdict === "partial" &&
    finding.reviewerState === "confirmed" &&
    finding.draft === null;

  /**
   * Record the decision, then close.
   *
   * Closing is the point of the pattern: the reviewer is working a queue, and
   * what they want next is the list with this row marked and the next one under
   * the cursor. `router.refresh()` re-reads the findings, so the strip behind
   * this comes back settled rather than needing its own local state.
   */
  const decide = (confirm: boolean, verdict?: string) =>
    startTransition(async () => {
      await reviewFinding(finding.id, {
        confirm,
        verdict,
        note: note.trim() || undefined,
        remember,
        scope,
      });
      router.refresh();
      onClose();
    });

  /** Pre-arm the whole override: covered, remembered, and confined. */
  const beginAllow = () => {
    setMode("allow");
    setChosen("covered");
    setRemember(true);
    setScope("project");
  };

  const close = () => {
    setMode(null);
    setChosen(null);
    setRemember(false);
    setScope("organisation");
    // Also the note: leaving it behind would attach an abandoned reason to
    // whatever the reviewer does next.
    setNote("");
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="finding-modal-title"
    >
      {/* A button, so a pointer and the keyboard both dismiss it. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/45 backdrop-blur-[2px]"
      />

      <div
        ref={panel}
        tabIndex={-1}
        className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line bg-canvas shadow-card-hover focus-visible:outline-none sm:max-h-[88vh] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-line bg-card px-4 py-3 sm:px-5">
          <span
            className={cn(
              "mt-0.5 inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-[11.5px]",
              TONE[meta.tone],
            )}
          >
            {meta.label}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-[11.5px] text-ink/62">{finding.clauseRef}</span>
              {severity && <SeverityTag severity={severity} />}
            </p>
            <h2
              id="finding-modal-title"
              className="mt-0.5 font-display text-[13px] font-semibold leading-snug tracking-[-0.01em] text-ink/88"
            >
              {finding.clauseTitle}
            </h2>
          </div>
          {/* Where the reader is, and the two controls that move them.
              A standard now yields tens of clauses, so stepping through them
              without closing the dialog is the difference between reviewing a
              report and clicking through one. */}
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden whitespace-nowrap px-1 text-[11.5px] tabular-nums text-ink/58 sm:inline">
              {position.index + 1} of {position.total}
            </span>
            <button
              type="button"
              onClick={() => navigate(-1)}
              disabled={!hasPrev}
              aria-label="Previous finding"
              title="Previous finding (← or k)"
              className="rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => navigate(1)}
              disabled={!hasNext}
              aria-label="Next finding"
              title="Next finding (→ or j)"
              className="rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-0.5 rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* The detail scrolls inside the dialog rather than moving the page. */}
        <div
          ref={scroller}
          // pb-6 so the decision buttons, which are the last thing in here,
          // clear the keyboard-hint bar below instead of sitting flush against
          // it. They were reading as clipped at the end of a long finding.
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6 sm:px-5"
        >
        {/* Gap, impact and fix on their own lines, wherever the engine's
            sentences can be told apart. Labelled rather than run together:
            the reader is asking "how bad, and what do I do?", and a
            three-clause paragraph makes them parse it to find out.
            A rationale whose parts cannot be named is shown whole, as the
            paragraph it is — never withheld. It used to be withheld below 160
            characters, on the reasoning that the row behind had already shown
            it in full; the dialog covers that row, so for 102 of the stored
            findings the reviewer opened a finding and was told less than the
            list had already told them. See rationaleSections. */}
        {sections ? (
          <dl className="mb-3.5 grid gap-2">
            {sections.map(({ label, text }) => (
              <div key={label} className="grid grid-cols-[66px_1fr] gap-x-3 gap-y-0.5 sm:grid-cols-[92px_1fr]">
                {/* The scanning aid was the faintest thing in the dialog at
                    10.5px and ink/52 — under the body floor globals.css sets
                    for itself, at the smallest size in the file. */}
                <dt className="pt-0.5 font-display text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink/62">
                  {label}
                </dt>
                <dd className={cn(PROSE_MEASURE, "min-w-0 text-[15px] leading-relaxed text-ink/88")}>
                  {text}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          finding.rationale && (
            <p className={cn(PROSE_MEASURE, "mb-3 text-[15px] leading-relaxed text-ink/88")}>
              {finding.rationale}
            </p>
          )
        )}
        {/* Keep the governing requirement visible in the clean view. The
            design's quoted response belongs with source evidence below. */}
        {facing && (
          <div className="mb-3.5 rounded-lg border border-line bg-card px-3 py-2.5">
            <p className="mb-1 font-display text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink/62">
              The standard requires
            </p>
            <p className="max-w-[68ch] text-[13px] leading-relaxed text-ink/82">
              {finding.clauseStatement}
            </p>
          </div>
        )}

        {finding.clauseStatement && !facing && (
          <div className={cn(PROSE_MEASURE, "mb-3")}>
            <p
              className={cn(
                "text-[13px] leading-relaxed text-ink/72",
                // Median 25 words, but the longest clause in this workspace is
                // 293 — a wall that arrives before the evidence and is where a
                // reviewer stops reading. Only the long ones are folded.
                !clauseOpen && "line-clamp-3",
              )}
            >
              <span className="text-ink/62">Requires: </span>
              {finding.clauseStatement}
            </p>
            {finding.clauseStatement.length > CLAUSE_CLAMP && (
              <button
                type="button"
                onClick={() => setClauseOpenFor(clauseOpen ? null : finding.id)}
                className="mt-0.5 text-[11.5px] text-ink/62 underline decoration-ink/25 underline-offset-2 transition-colors hover:text-ink/88"
              >
                {clauseOpen ? "Show less of the clause" : "Show the whole clause"}
              </button>
            )}
          </div>
        )}

        {/* The source starts closed so reviewers can read the finding before
            opening excerpts, table rows, or diagram images. */}
        <section className="mb-3.5 overflow-hidden rounded-xl border border-line bg-card">
          <button
            type="button"
            aria-expanded={isEvidenceExpanded}
            aria-controls={`finding-evidence-${finding.id}`}
            onClick={() => setEvidenceOpenFor(isEvidenceExpanded ? null : finding.id)}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left text-[13px] font-medium text-ink/78 transition-colors hover:bg-canvas-sunk focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-royal-mid"
          >
            <span>
              {isEvidenceExpanded
                ? "[-] Hide Source Evidence"
                : `[+] View Source Evidence (${finding.evidence.length} ${finding.evidence.length === 1 ? "excerpt" : "excerpts"})`}
            </span>
            <ChevronDown
              size={15}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-ink/52 transition-transform duration-200 motion-reduce:transition-none",
                isEvidenceExpanded && "rotate-180",
              )}
            />
          </button>

          <div
            id={`finding-evidence-${finding.id}`}
            aria-hidden={!isEvidenceExpanded}
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
              isEvidenceExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              {isEvidenceExpanded && (
                <div className="space-y-2.5 border-t border-line p-3.5">
                  {facing && voices.length > 0 && (
                    <div className="rounded-lg border border-line bg-canvas-sunk px-3 py-2.5">
                      <p className="mb-1 font-display text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink/62">
                        {voices.length > 1 ? "What the designs say" : "What the design says"}
                      </p>
                      <ul className="space-y-1.5">
                        {voices.map((voice) => (
                          <li key={voice.title || voice.text}>
                            {voices.length > 1 && voice.title && (
                              <span className="mr-1.5 rounded border border-line px-1.5 py-px text-[11.5px] text-ink/72">
                                {voice.title}
                              </span>
                            )}
                            <span className="text-[13px] leading-relaxed text-ink/82">
                              {voice.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {finding.evidence.length > 0 ? (
                    <ul className="space-y-2">
                      {finding.evidence.map((item) => (
                        <li
                          key={item.chunkId}
                          className="overflow-hidden rounded-lg border border-line bg-canvas-sunk"
                        >
                          <div className="px-3 py-2.5">
                            <p className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink/62">
                              {item.documentTitle && (
                                <span className="rounded border border-line px-1.5 py-px text-[11.5px] text-ink/72">
                                  {item.documentTitle}
                                </span>
                              )}
                              <span>
                                {item.sourceKind === "quote"
                                  ? "Quoted from the design, checked word for word"
                                  : item.headingPath}
                              </span>
                              {item.page != null && <span>· page {item.page}</span>}
                              {item.figureId && (
                                <span
                                  title="A model's reading of a diagram, not text from the page"
                                  className="inline-flex items-center gap-1 rounded border border-warn-line px-1.5 py-px text-[11.5px] text-warn"
                                >
                                  <Sparkles size={9} />
                                  model-described diagram
                                </span>
                              )}
                            </p>
                            {item.table ? (
                              <TableFigure
                                table={item.table.table}
                                bare
                                highlightRows={item.table.rows}
                                caption={
                                  item.table.rows.length === 0
                                    ? "Quoted from this table"
                                    : item.table.rows.length === 1
                                      ? "Quoted from the highlighted row"
                                      : "Quoted from the highlighted rows"
                                }
                              />
                            ) : (
                              <Excerpt item={item} />
                            )}
                          </div>

                          {item.figureId && (
                            <div className="border-t border-line bg-white p-2">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/figures/${item.figureId}`}
                                alt="The figure this description was written from"
                                className="h-auto w-full rounded"
                              />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-ink/62">
                      No passage in the submitted document was cited for this finding.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* How strongly the clause binds, and how that was established.
            Severity is a function of it, so a reviewer who disagrees with a
            severity needs to see this to know what to argue with — and where
            the standard never said, the honest answer is on the screen rather
            than a level the engine made up. */}
        <p className={cn(PROSE_MEASURE, "mb-3 text-[11.5px] text-ink/58")}>
          {/* The label is empty for an unstated obligation — see OBLIGATION_META
              — so the separator goes with it rather than leaving a leading
              "· " on the line. */}
          {OBLIGATION_META[finding.obligation].label && (
            <>
              <span className="text-ink/72">{OBLIGATION_META[finding.obligation].label}</span>
              {" · "}
            </>
          )}
          {OBLIGATION_META[finding.obligation].blurb}
          {finding.obligation !== "unstated" && finding.obligationSource !== "parsed" && (
            <>
              {" "}
              {finding.obligationSource === "read"
                ? "Read from the clause's own wording, not from a structured requirement."
                : "The model's reading of the clause, not the standard's own structure."}
            </>
          )}
        </p>

        {/* Severity explains priority; the uncalibrated model confidence stays
            internal and is not presented as a probability to reviewers. */}
        <p className={cn(PROSE_MEASURE, "mb-3 text-[11.5px] text-ink/58")}>
          {severity ? `${SEVERITY_META[severity].blurb} ` : ""}
          Evidence basis: {evidenceBasis}.
        </p>

        {/* What the verdict rested on besides the document. Shown before the
            review controls, because whether a standing decision was applied
            changes how much a reviewer needs to look at the verdict at all. */}
        {finding.appliedDecisions.length > 0 && (
          <div className="mb-3 rounded-lg border border-royal-mid/25 bg-royal/[0.07] px-3 py-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-royal">
              <Sparkles size={11} />
              Judged with {finding.appliedDecisions.length} standing decision
              {finding.appliedDecisions.length === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1">
              {finding.appliedDecisions.map((decision) => (
                <li
                  key={decision.id}
                  className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink/78"
                >
                  <span className="text-ink/62">
                    {EFFECT_META[decision.effect].label}:
                  </span>
                  {decision.title}
                </li>
              ))}
            </ul>
            <a
              href="/dashboard/decisions"
              className="mt-1.5 inline-block text-[11.5px] text-ink/62 underline decoration-ink/25 underline-offset-2 transition-colors hover:text-ink/78"
            >
              Open the decisions register
            </a>
          </div>
        )}

        {finding.reviewerNote && (
          <p className={cn(PROSE_MEASURE, "mb-3 text-[13px] text-ink/68")}>
            <span className="text-ink/62">Note: </span>
            {finding.reviewerNote}
            {finding.promotedDecisionId && (
              <span className="ml-2 rounded bg-royal/8 px-1.5 py-0.5 text-[11.5px] text-royal">
                kept as a decision
              </span>
            )}
          </p>
        )}

        {draft && <StandardProposal draft={draft} clauseRef={finding.clauseRef} />}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => decide(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink/72 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            <Check size={12} />
            Confirm issue
          </button>

          {mode ? (
            /* Choosing a verdict no longer submits on the spot. The reason
               for a review is the most valuable thing a reviewer produces
               — it is what a standing decision is made of — and a flow that
               never asked for it was throwing that away. */
            <div className="w-full space-y-3 rounded-lg border border-line bg-canvas-sunk p-3">
              {mode === "override" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11.5px] text-ink/64">
                    The engine judged this wrongly. Correct verdict:
                  </span>
                  {/* Not "Absent": that section lists parts of the design, not
                      clauses, so a clause corrected to it would vanish. */}
                  {VERDICTS.filter((v) => v !== finding.verdict && v !== "absent").map((verdict) => (
                    <button
                      key={verdict}
                      type="button"
                      disabled={pending}
                      aria-pressed={chosen === verdict}
                      onClick={() => setChosen(verdict)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11.5px] transition-[opacity,box-shadow] hover:opacity-80 disabled:opacity-50",
                        TONE[VERDICT_META[verdict].tone],
                        chosen === verdict && "ring-2 ring-line-strong",
                      )}
                    >
                      {VERDICT_META[verdict].label}
                    </button>
                  ))}
                </div>
              )}

              {mode === "confirm" && (
                <p className="text-[11.5px] text-ink/64">
                  Agreeing with{" "}
                  <span className="text-ink/78">
                    {VERDICT_META[finding.verdict as Verdict]?.label ?? finding.verdict}
                  </span>
                  . Say why, and it can be kept as a standing decision.
                </p>
              )}

              {/* The breach is not being denied, and the wording says so: the
                  clause is still broken, and this is the dispensation for it.
                  "the engine got this wrong" is the Override verdict path
                  and means something else. */}
              {mode === "allow" && project && (
                <p className="text-[11.5px] leading-relaxed text-ink/64">
                  Allowing this breach for{" "}
                  <span className="text-ink/82">{project.name}</span>. The clause stays
                  broken on the record; later assessments of this project will be judged
                  with the allowance in front of them, and no other project inherits it.
                </p>
              )}

              <label className="block">
                <span className="mb-1 block text-[11.5px] text-ink/64">
                  {mode === "allow"
                    ? "Why is it allowed here? This is the exception's stated basis."
                    : "Why? This becomes the decision if you keep it."}
                </span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  placeholder={
                    mode === "allow"
                      ? "e.g. the legacy protocol stays until the gateway migration completes in Q3."
                      : "e.g. KMS-managed keys in eu-west-1 satisfy this clause."
                  }
                  className="w-full resize-y rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
                />
              </label>

              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                  remember
                    ? "border-royal-mid/40 bg-royal/[0.10]"
                    : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={!note.trim()}
                  onChange={(event) => setRemember(event.target.checked)}
                  className="mt-0.5 size-3.5 shrink-0 accent-royal-mid disabled:opacity-40"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink/88">
                    Remember this for future assessments
                  </span>
                  <span className="block text-[11.5px] leading-relaxed text-ink/64">
                    {note.trim()
                      ? SCOPE_META[project ? scope : "organisation"].blurb
                      : "Add a reason first — a decision with no stated basis is not one worth keeping."}
                  </span>

                  {/* Only once there is something to remember, and only with a
                      project to confine it to. A choice between one option is
                      not a choice, and showing it on a design that belongs to
                      no project would offer a reach that cannot be granted. */}
                  {remember && project && (
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      {(["project", "organisation"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          disabled={pending}
                          aria-pressed={scope === option}
                          // Inside a <label>: without this, clicking either
                          // pill toggles the checkbox it sits in.
                          onClick={(event) => {
                            event.preventDefault();
                            setScope(option);
                          }}
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50",
                            scope === option
                              ? "border-royal-mid/50 bg-royal/10 text-royal"
                              : "border-line text-ink/68 hover:border-line-strong hover:text-ink",
                          )}
                        >
                          {option === "project"
                            ? `Only ${project.name}`
                            : SCOPE_META.organisation.label}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={
                    pending ||
                    (mode !== "confirm" && !chosen) ||
                    // Reachable only in "allow" mode, which arrives with the
                    // box already ticked and nothing written in it yet.
                    (remember && !note.trim())
                  }
                  onClick={() =>
                    mode === "confirm" ? decide(true) : decide(false, chosen ?? undefined)
                  }
                  className="rounded-full bg-royal px-3.5 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
                >
                  {remember
                    ? scope === "project"
                      ? "Save and allow here"
                      : "Save and remember"
                    : mode === "override"
                      ? "Save corrected verdict"
                      : "Save"}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="text-[11.5px] text-ink/62 hover:text-ink/78"
                >
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Kept beside the bare Confirm rather than replacing it. A
                  reviewer agreeing with twenty verdicts in a row should still
                  do it in one click each; this is the door to the register for
                  the handful that deserve a reason. */}
              <button
                type="button"
                disabled={pending}
                onClick={() => setMode("confirm")}
                className="rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
              >
                Confirm issue with a reason…
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setMode("override")}
                className="rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink/68 transition-colors hover:border-warn-line hover:text-warn disabled:opacity-50"
              >
                Override verdict&hellip;
              </button>
              {/* Last, and deliberately not dressed as the easy way out: it
                  is the one action here that lets a design ship against a
                  standard, and it should take a moment longer to reach than
                  agreeing with the verdict does. */}
              {allowable && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={beginAllow}
                  className="rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
                >
                  Accept risk for this project…
                </button>
              )}
              {/* The other direction entirely: not a dispensation for this
                  design but a sharper rule for every design after it. Shown
                  only once the verdict is agreed, because that agreement is
                  the whole evidence that the wording was the problem. */}
              {sharpenable && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await makeStandard(finding.id);
                      router.refresh();
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
                >
                  <Scale size={12} />
                  Make a standard…
                </button>
              )}
            </>
          )}
        </div>
        </div>

        {/* Named, because a shortcut nobody is told about is not a feature.
            Hidden on a phone, where there is no keyboard to use it with. */}
        <div className="hidden items-center justify-between gap-3 border-t border-line bg-card px-5 py-2 text-[11.5px] text-ink/55 sm:flex">
          <span>
            <kbd className="rounded border border-line px-1 font-mono">←</kbd>
            {" / "}
            <kbd className="rounded border border-line px-1 font-mono">→</kbd>
            {" or "}
            <kbd className="rounded border border-line px-1 font-mono">k</kbd>
            {" / "}
            <kbd className="rounded border border-line px-1 font-mono">j</kbd>
            {" to step between findings"}
          </span>
          <span>
            <kbd className="rounded border border-line px-1 font-mono">Esc</kbd>
            {" to close"}
          </span>
        </div>
      </div>
    </div>
  );
}
