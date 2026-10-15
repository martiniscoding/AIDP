"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Scale, Sparkles, X } from "lucide-react";
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
import { TableFigure } from "@/components/ui/TableFigure";
import { makeStandard, reviewFinding } from "../actions";
import {
  Excerpt,
  StandardProposal,
  TONE,
  RATIONALE_PARTS,
  rationaleParts,
  type FindingView,
  type ProjectRef,
} from "./Assessment";
import { SeverityTag } from "./SeverityTag";

/**
 * Longer than this and the strip behind this dialog clamped the gap, so the
 * whole rationale is worth repeating here. Shorter and the strip showed all of
 * it, and repeating it would be the same sentence twice. Only reached when the
 * rationale is not the three sentences the judge is asked for.
 */
const RATIONALE_CLAMP = 160;

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
  onClose,
}: {
  finding: FindingView;
  project: ProjectRef | null;
  /** Whether this person may change the standards. See canManageStandards. */
  mayCurate: boolean;
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

  const panel = useRef<HTMLDivElement | null>(null);

  // Escape closes, and the page behind does not scroll while this is up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const severity = severityOf(finding.verdict, finding.confidence, finding.obligation);
  const decided = finding.reviewerState !== "pending";
  const parts = rationaleParts(finding.rationale);
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
              "mt-0.5 inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-[11px]",
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
              className="mt-0.5 font-display text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink"
            >
              {finding.clauseTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink/58 transition-colors hover:bg-canvas-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
          >
            <X size={16} />
          </button>
        </div>

        {/* The detail scrolls inside the dialog rather than moving the page. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 sm:px-5">
        {/* Gap, impact and fix on their own lines, where the engine wrote
            three sentences. Labelled rather than run together: the reader is
            asking "how bad, and what do I do?", and a three-clause paragraph
            makes them parse it to find out. A rationale that is not three
            sentences is shown as the paragraph it is — see rationaleParts. */}
        {parts ? (
          <dl className="mb-3.5 grid gap-2">
            {parts.map((text, i) => (
              <div key={RATIONALE_PARTS[i]} className="grid grid-cols-[56px_1fr] gap-x-3 gap-y-0.5 sm:grid-cols-[62px_1fr]">
                <dt className="pt-px font-display text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/52">
                  {RATIONALE_PARTS[i]}
                </dt>
                <dd className="min-w-0 text-[13px] leading-relaxed text-ink/82">{text}</dd>
              </div>
            ))}
          </dl>
        ) : (
          finding.rationale.length > RATIONALE_CLAMP && (
            <p className="mb-3 text-[13px] leading-relaxed text-ink/78">
              {finding.rationale}
            </p>
          )
        )}
        {finding.clauseStatement && (
          <p className="mb-3 text-[13px] leading-relaxed text-ink/72">
            <span className="text-ink/62">Requires: </span>
            {finding.clauseStatement}
          </p>
        )}

        {/* How strongly the clause binds, and how that was established.
            Severity is a function of it, so a reviewer who disagrees with a
            severity needs to see this to know what to argue with — and where
            the standard never said, the honest answer is on the screen rather
            than a level the engine made up. */}
        <p className="mb-3 text-[12px] text-ink/58">
          <span className="text-ink/72">{OBLIGATION_META[finding.obligation].label}</span>
          {" · "}
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

        {/* Kept, and kept here. Somebody who thinks a verdict is wrong wants
            to know how sure the engine was; somebody working down the list
            does not, and it was taking up the one place on the row where the
            priority belongs.

            Called heuristic, not a probability: it is the model's opinion of
            itself with no calibration dataset behind it, and presenting it as
            a measured likelihood would be the same overclaim as a fabricated
            citation. */}
        <p className="mb-3 text-[12px] text-ink/58">
          {severity ? `${SEVERITY_META[severity].blurb} ` : ""}
          Heuristic confidence {Math.round(finding.confidence * 100)}% — the model&rsquo;s own
          certainty in this verdict, not a calibrated probability.
        </p>

        {finding.evidence.length > 0 ? (
          <ul className="mb-3 space-y-2">
            {finding.evidence.map((item) => (
              <li
                key={item.chunkId}
                className="overflow-hidden rounded-lg border border-line bg-card"
              >
                <div className="px-3 py-2.5">
                  <p className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink/62">
                    {/* Which design, when the run covered several. A heading
                        and a page number are not an address on their own
                        across a project, and the reviewer has to know which
                        file to open. */}
                    {item.documentTitle && (
                      <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink/72">
                        {item.documentTitle}
                      </span>
                    )}
                    {/* A quote from a whole-document reading has no heading;
                        what a reviewer needs to know is that it was checked. */}
                    <span>
                      {item.sourceKind === "quote"
                        ? "Quoted from the design, checked word for word"
                        : item.headingPath}
                    </span>
                    {item.page != null && <span>· page {item.page}</span>}
                    {item.figureId && (
                      <span
                        title="A model's reading of a diagram, not text from the page"
                        className="inline-flex items-center gap-1 rounded border border-warn-line px-1.5 py-px text-[10.5px] text-warn"
                      >
                        <Sparkles size={9} />
                        model-described diagram
                      </span>
                    )}
                  </p>
                  {/* A fifth of the evidence in these reports is table cells
                      printed as a run-on line — "Category: Programming
                      Languages | Comments: V 11" is a five-column row with
                      its three empty columns dropped. Where the passage came
                      out of a table, the table is what the reviewer is shown,
                      with the cited row marked. */}
                  {item.table ? (
                    <TableFigure
                      table={item.table.table}
                      bare
                      highlightRow={item.table.row}
                      caption={
                        item.table.row === null
                          ? "Quoted from this table"
                          : "Quoted from the highlighted row"
                      }
                    />
                  ) : (
                    <Excerpt item={item} />
                  )}
                </div>

                {/*
                  The diagram, beside the claim made about it. Checking here —
                  when a verdict actually depends on it — is worth more than
                  reviewing every figure speculatively at ingest.
                */}
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
          <p className="mb-3 text-[12.5px] text-ink/62">
            No passage in the submitted document was cited for this finding.
          </p>
        )}

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
                  className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink/78"
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
          <p className="mb-3 text-[12.5px] text-ink/68">
            <span className="text-ink/62">Note: </span>
            {finding.reviewerNote}
            {finding.promotedDecisionId && (
              <span className="ml-2 rounded bg-royal/8 px-1.5 py-0.5 text-[11px] text-royal">
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
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/72 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
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
                  className="w-full resize-y rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
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
                  <span className="block text-[12.5px] text-ink/88">
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
                  className="rounded-full bg-royal px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
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
                  className="text-[12px] text-ink/62 hover:text-ink/78"
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
                className="rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
              >
                Confirm issue with a reason…
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setMode("override")}
                className="rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/68 transition-colors hover:border-warn-line hover:text-warn disabled:opacity-50"
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
                  className="rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
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
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/68 transition-colors hover:border-royal-mid/50 hover:text-royal disabled:opacity-50"
                >
                  <Scale size={12} />
                  Make a standard…
                </button>
              )}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
