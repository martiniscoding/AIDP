"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Loader2,
  Play,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  VERDICTS,
  VERDICT_META,
  applyLens,
  type EvidenceItem,
  type Lens,
  type Verdict,
  type VerdictCounts,
} from "@/lib/ingest/verdicts";
import { EFFECT_META, type AppliedDecision } from "@/lib/ingest/decision-effects";
import type { CoverageView } from "@/lib/ingest/coverage";
import type { AdviceView } from "@/lib/ingest/advice";
import type { LifecycleView } from "@/lib/ingest/lifecycle";
import { SLOW_PICKUP_MS, type JobView } from "@/lib/ingest/pipeline";
import { reviewFinding, startAssessment } from "../actions";
import { Ticker } from "../Ticker";
import { CoverageGaps } from "./CoverageGaps";
import { Improvements } from "./Improvements";
import { Lifecycle } from "./Lifecycle";

export type FindingView = {
  id: string;
  clauseRef: string;
  clauseTitle: string;
  clauseStatement: string;
  verdict: string;
  confidence: number;
  rationale: string;
  evidence: EvidenceItem[];
  reviewerState: string;
  reviewerVerdict: string | null;
  reviewerNote: string | null;
  /** Standing decisions the model was given and said it applied. */
  appliedDecisions: AppliedDecision[];
  /** Set once this finding's review has been kept as a decision. */
  promotedDecisionId: string | null;
};

export type RunView = {
  id: string;
  state: string;
  totalClauses: number;
  completedClauses: number;
  frameworkName: string;
  frameworkVersion: number;
  model: string | null;
  failureReason: string | null;
  /** How the judge saw the design: "retrieval" (search) or "document" (read whole). */
  mode: string;
  /** Why the run did not use the mode it was asked for, when it did not. */
  note: string | null;
  /** Queued or running with no job a worker could take, so it will never move. */
  orphaned: boolean;
  /** The live run's job: picked up yet, preparing, retrying, or stalled. */
  job: JobView | null;
  /** Parts of the design no clause governs, and standards to add. The "Absent" section. */
  coverage: CoverageView | null;
  /** Improvements to the design itself, suggested after the assessment. Advice, not a verdict. */
  advice: AdviceView | null;
  /** Whether the products the design names are still supported, from endoflife.date. Facts, not a verdict. */
  lifecycle: LifecycleView | null;
} | null;

const TONE: Record<string, string> = {
  bad: "border-danger-line bg-danger-tint text-danger",
  warn: "border-warn-line bg-warn-tint text-warn",
  unknown: "border-line bg-card text-ink/72",
  good: "border-royal-mid/30 bg-royal/8 text-royal",
};

/**
 * Where a live run has got to, told from its job as well as the run.
 *
 * The run row only turns "running" once the worker has loaded everything and
 * reached the first clause, and stays "running" through a retry or a worker
 * that died — so on its own it cannot tell a run nobody has touched from one a
 * worker is preparing, one waiting to try again after a provider refused, or one
 * nobody is working on any more. The job can. The page refreshes every few
 * seconds, so this moves on its own as the worker does.
 */
function RunProgress({ run }: { run: NonNullable<RunView> }) {
  const job = run.job;
  const started = run.state === "running";
  const slow = job?.state === "queued" && (job.sinceMs ?? 0) >= SLOW_PICKUP_MS;
  const troubled = slow || job?.state === "retrying" || job?.state === "stalled";
  const clock =
    job && job.sinceMs !== null && (job.state === "queued" || job.state === "running")
      ? job.sinceMs
      : null;

  let headline: string;
  let detail: React.ReactNode = null;
  switch (job?.state) {
    case "queued":
      headline = slow
        ? "Still waiting for an analysis worker"
        : "Queued — waiting for an analysis worker to pick this up";
      if (slow) {
        detail = "None has picked it up yet. Every analysis worker may be busy, or none may be running.";
      }
      break;
    case "retrying":
      headline = "Trying again after an error";
      detail = (
        <>
          Attempt {job.attempt} of {job.maxAttempts} failed
          {job.problem ? `: ${job.problem.summary}` : "."}{" "}
          {job.retryInMs ? (
            <>
              Next attempt in <Ticker ms={job.retryInMs} direction="down" />.
            </>
          ) : (
            "Next attempt shortly."
          )}
        </>
      );
      break;
    case "stalled":
      headline = "The analysis worker stopped responding";
      detail =
        "It goes back in the queue automatically, and carries on from the last clause it finished.";
      break;
    case "running":
      headline = started
        ? "Assessing clause by clause"
        : "Picked up by an analysis worker — getting ready";
      // Before the first clause the step is the only sign of life; after it, the
      // clause count says more than "Assessing clauses" would.
      if (!started && job.step) {
        detail =
          job.total !== null && job.done !== null
            ? `${job.step} · ${job.done} of ${job.total}`
            : job.step;
      }
      break;
    default:
      headline = started
        ? "Assessing clause by clause"
        : "Queued — waiting for an analysis worker to pick this up";
  }

  return (
    <div
      className={cn(
        "mb-4 rounded-xl border bg-card px-4 py-3",
        troubled ? "border-warn-line" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12.5px]">
        <span role="status" className={cn("font-medium", troubled ? "text-warn" : "text-ink/80")}>
          {headline}
        </span>
        <span className="text-ink/62 tabular-nums">
          {started && `${run.completedClauses} / ${run.totalClauses} clauses`}
          {started && clock !== null && " · "}
          {clock !== null && <Ticker ms={clock} />}
        </span>
      </div>
      {detail && <p className="mt-1 text-[12px] leading-relaxed text-ink/66">{detail}</p>}

      {/* No bar while nothing has begun: a bar at 0% claims work has started
          and is going slowly. Moving but uncountable while the worker gets
          ready; counted once clauses are being judged. */}
      {started ? (
        <div
          role="progressbar"
          aria-label="Clauses assessed"
          aria-valuemin={0}
          aria-valuemax={run.totalClauses}
          aria-valuenow={run.completedClauses}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas-sunk"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700",
              troubled ? "bg-warn/60" : "bg-royal-mid",
            )}
            style={{
              width: `${Math.max(2, run.totalClauses ? Math.min(100, (run.completedClauses / run.totalClauses) * 100) : 0)}%`,
            }}
          />
        </div>
      ) : job?.state === "running" ? (
        <span
          aria-hidden="true"
          className="mt-2 block h-1.5 overflow-hidden rounded-full bg-canvas-sunk"
        >
          <span className="rail-slide block h-full w-1/4 bg-linear-to-r from-transparent via-royal to-transparent" />
        </span>
      ) : null}
    </div>
  );
}

/**
 * "Absent" asks the reverse of every other chip. The others count clauses by
 * what the design does about them; this counts the parts of the design no clause
 * governs at all. Clauses the design says nothing about are not listed: the
 * question a reviewer asked for is what the standards leave uncovered.
 */
const ABSENT_META = {
  label: "Absent",
  tone: "bad",
  blurb: "Parts of this design that no clause in your standards covers.",
} as const;

/**
 * The assessment surface for a submitted design.
 *
 * Findings arrive worst-first and default to collapsed. A reviewer working a
 * hundred-clause run needs the shape of the result before any one row, and the
 * rows they will actually open are the handful at the top.
 *
 * The list opens on what needs attention, with covered findings folded away.
 * They are *not* discarded: a covered finding is the evidence that a clause was
 * checked and passed, which is precisely what an audit asks for, and it is also
 * the only way anybody catches a wrong one — a false "covered" ships a gap,
 * which is the most expensive mistake this tool can make. So the count stays on
 * screen and they are one click away; what changes is only which of them a
 * reviewer has to scroll past to reach the work.
 */
export function Assessment({
  documentId,
  run,
  counts,
  findings,
  decisionsInForce,
}: {
  documentId: string;
  run: RunView;
  counts: VerdictCounts;
  findings: FindingView[];
  /** Standing decisions this run will be judged with. */
  decisionsInForce: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Which findings to show. A verdict narrows to that one; "attention" is the
   * default and hides only covered; "all" is the explicit way back.
   */
  const [lens, setLens] = useState<Lens>("attention");

  /**
   * Queued and running are different things, and collapsing them hid a real
   * failure: with no analyse worker up, a run sat queued for two days while
   * this panel said "Assessing clause by clause…" and showed a progress bar
   * pinned at 0. Nothing was assessing anything. A run nobody has picked up
   * needs to look like one, because the fix is to go and start a worker.
   */
  // A run with no job behind it is neither: it is stuck, and the buttons stay
  // live so it can be started again. See `latestRun`.
  const orphaned = run?.orphaned === true;
  const queued = run?.state === "queued" && !orphaned;
  const assessing = run?.state === "running" && !orphaned;
  const inFlight = queued || assessing;
  const shown = applyLens(findings, lens);
  const reviewed = findings.filter((finding) => finding.reviewerState !== "pending").length;
  // Only worth mentioning the fold when it is actually hiding something.
  const folded = lens === "attention" ? counts.covered : 0;


  // One way to assess a design, so no mode to choose: every clause is judged on
  // the passages a search finds, and whatever comes back absent is re-read
  // against the whole document before it is reported. See Workers/aidp/stages.
  const begin = () =>
    startTransition(async () => {
      const result = await startAssessment(documentId);
      setMessage(result.message);
      router.refresh();
    });

  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            Assessment
          </h2>
          <p className="mt-1 text-[12.5px] text-ink/64">
            {run
              ? `${run.frameworkName} v${run.frameworkVersion}` +
                (run.model ? ` · ${run.model}` : "") +
                (run.mode === "document" ? " · read the whole document" : " · by search")
              : "Measure this design against every clause in the standards library."}
            {decisionsInForce > 0 && (
              <>
                {" · "}
                <a
                  href="/dashboard/decisions"
                  className="text-royal underline decoration-royal/40 underline-offset-2 hover:text-ink"
                >
                  {decisionsInForce} standing decision
                  {decisionsInForce === 1 ? "" : "s"} in force
                </a>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => begin()}
            disabled={pending || inFlight}
            title="Every clause is checked against this design, and anything that looks unaddressed is re-read against the whole document."
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors",
              "border-royal/40 bg-royal-tint text-royal-deep hover:bg-royal/15",
              "disabled:cursor-not-allowed disabled:opacity-55",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
            )}
          >
            {pending || inFlight ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            {queued
              ? "Queued…"
              : assessing
                ? "Running…"
                : run
                  ? "Re-run assessment"
                  : "Run assessment"}
          </button>
        </div>
      </div>

      {message && <p className="mb-3 text-[12.5px] text-ink/68">{message}</p>}

      {orphaned && (
        <p className="mb-4 rounded-xl border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn">
          This assessment never started. It is marked {run?.state}, but there is nothing queued for
          a worker to pick up — its job was removed, most often by re-processing the document — so
          it will not move on its own. Start it again with one of the buttons above.
        </p>
      )}

      {run?.failureReason && (
        <p className="mb-4 rounded-xl border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn">
          {run.failureReason}
        </p>
      )}

      {/* A whole-document run that fell back to search says so, so its
          verdicts are never mistaken for a reading of the whole document. */}
      {run?.note && (
        <p className="mb-4 rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-ink/74">
          {run.note}
        </p>
      )}

      {inFlight && run && <RunProgress run={run} />}

      {run && (findings.length > 0 || run.coverage !== null) && (
        <>
          {/* Coverage across the framework. Also the filter. */}
          <div className="mb-4 flex flex-wrap gap-2">
            {VERDICTS.map((verdict) => {
              const gapsChip = verdict === "absent";
              const meta = gapsChip ? ABSENT_META : VERDICT_META[verdict];
              const count = gapsChip ? (run.coverage?.gaps.length ?? 0) : counts[verdict];
              const active = lens === verdict;
              return (
                <button
                  key={verdict}
                  type="button"
                  title={meta.blurb}
                  onClick={() => setLens(active ? "attention" : verdict)}
                  // Always open: with nothing to list it still says why — an
                  // older run, a check that could not run, or no gaps at all.
                  disabled={!gapsChip && count === 0}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-opacity",
                    TONE[meta.tone],
                    count === 0 && "opacity-35",
                    active && "ring-2 ring-line-strong",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
                  )}
                >
                  <span className="font-display text-[15px] font-semibold">{count}</span>
                  {meta.label}
                </button>
              );
            })}
          </div>

          {lens === "absent" ? (
            <CoverageGaps coverage={run.coverage} frameworkName={run.frameworkName} />
          ) : (
          <>
          {lens === "attention" && (run.coverage?.gaps.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setLens("absent")}
              className="mb-3 flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-danger-line bg-danger-tint px-4 py-2.5 text-left text-[12.5px] text-danger transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
            >
              <span>
                {run.coverage?.gaps.length} part{run.coverage?.gaps.length === 1 ? "" : "s"} of
                this design no standard covers
                {(run.coverage?.suggestions.length ?? 0) > 0 &&
                  ` · ${run.coverage?.suggestions.length} standard${run.coverage?.suggestions.length === 1 ? "" : "s"} suggested`}
              </span>
              <span className="shrink-0 underline underline-offset-2">View</span>
            </button>
          )}

          <p className="mb-3 text-[12px] text-ink/62">
            {reviewed} of {findings.length} reviewed
            {folded > 0 && (
              <>
                {" · "}
                {folded} covered {folded === 1 ? "clause is" : "clauses are"} folded away
                {" · "}
                <button
                  type="button"
                  onClick={() => setLens("all")}
                  className="text-royal hover:text-ink"
                >
                  show everything
                </button>
              </>
            )}
            {lens === "all" && counts.covered > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setLens("attention")}
                  className="text-royal hover:text-ink"
                >
                  hide covered
                </button>
              </>
            )}
            {lens !== "all" && lens !== "attention" && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setLens("attention")}
                  className="text-royal hover:text-ink"
                >
                  clear filter
                </button>
              </>
            )}
          </p>

          {shown.length === 0 ? (
            // Reachable when every clause passed. An empty list would read as a
            // broken page rather than as the best possible result.
            <p className="rounded-xl border border-ok-line bg-ok-tint px-4 py-6 text-center text-[13px] text-ok">
              {lens === "attention" && findings.length > 0
                ? `Nothing to resolve — every one of the ${findings.length} clause findings is covered.`
                : "No findings match that filter."}
              {lens === "attention" && findings.length > 0 && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => setLens("all")}
                    className="underline underline-offset-2"
                  >
                    Show them
                  </button>
                </>
              )}
            </p>
          ) : (
            <ul className="space-y-2">
              {shown.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
          </>
          )}
        </>
      )}

      {run && findings.length === 0 && !inFlight && run.coverage === null && (
        <p className="rounded-xl border border-line bg-card px-5 py-8 text-center text-[13.5px] text-ink/64">
          No findings recorded. The run may have failed before it reached a clause.
        </p>
      )}

      {/* After the findings, never among them: advice on the design, not a verdict
          on a clause. Only for a finished run — a live one has nothing to show yet. */}
      {run && run.state === "complete" && <Lifecycle lifecycle={run.lifecycle} />}
      {run && run.state === "complete" && <Improvements advice={run.advice} runId={run.id} />}
    </section>
  );
}


/**
 * A cited passage, rendered the way it was written.
 *
 * A table's meaning is which value sits in which column, so showing its rows as
 * a run-on paragraph makes the evidence unreadable at exactly the moment a
 * reviewer is deciding whether a finding is fair. Prose is left alone — its line
 * breaks are where the PDF wrapped and mean nothing.
 */
function Excerpt({ item }: { item: EvidenceItem }) {
  const rows = item.excerpt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|").map((cell) => cell.trim()));

  // Two or more lines that each split on a pipe into the same number of cells is
  // a grid. One line, or ragged ones, is prose that happens to contain a pipe.
  const width = rows[0]?.length ?? 0;
  const isTable =
    rows.length > 1 && width > 1 && rows.every((row) => row.length === width);

  if (!isTable) {
    return (
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink/78">
        {item.excerpt}
      </p>
    );
  }

  const [head, ...body] = rows;
  return (
    // Its own scroller: a wide table must never make the report scroll sideways.
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                scope="col"
                className="border-b border-line px-2 py-1.5 text-left font-medium text-ink/70"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="align-top">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={cn(
                    "border-b border-line px-2 py-1.5",
                    c === 0 ? "text-ink/84" : "text-ink/72",
                  )}
                >
                  {/* An empty cell is written out at ingest, so a blank here is
                      a real gap in the source rather than a lost value. */}
                  {cell || "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingRow({ finding }: { finding: FindingView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  /**
   * Which panel is open, if any.
   *
   * There used to be a boolean for "overriding", which meant the note and the
   * remember checkbox existed only on the override path. Agreeing with a
   * verdict could therefore never become a standing decision — not because the
   * checkbox was missed, but because there was no checkbox to miss. The server
   * had always supported it: `promoteFinding` maps a confirmed "covered" to an
   * `accepts` decision, a branch nothing could reach.
   *
   * Confirming a `partial` and writing down the scope everyone agreed to is a
   * ruling worth carrying into the next assessment, and it was unreachable.
   */
  const [mode, setMode] = useState<"confirm" | "override" | null>(null);

  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const decided = finding.reviewerState !== "pending";

  const decide = (confirm: boolean, verdict?: string) =>
    startTransition(async () => {
      await reviewFinding(finding.id, {
        confirm,
        verdict,
        note: note.trim() || undefined,
        remember,
      });
      setMode(null);
      setChosen(null);
      setNote("");
      setRemember(false);
      router.refresh();
    });

  const close = () => {
    setMode(null);
    setChosen(null);
    setRemember(false);
    // Also the note: leaving it behind would attach an abandoned reason to
    // whatever the reviewer does next.
    setNote("");
  };

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
      >
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
            TONE[meta.tone],
          )}
        >
          {meta.tone === "bad" ? (
            <ShieldAlert size={11} />
          ) : meta.tone === "warn" ? (
            <TriangleAlert size={11} />
          ) : meta.tone === "good" ? (
            <Check size={11} />
          ) : (
            <CircleHelp size={11} />
          )}
          {meta.label}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[11.5px] text-ink/62">{finding.clauseRef}</span>
            <span className="text-[13.5px] text-ink/88">{finding.clauseTitle}</span>
          </span>
          {finding.rationale && (
            <span className="mt-1 block text-[12.5px] leading-relaxed text-ink/66">
              {finding.rationale}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink/62">
          {decided && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                finding.reviewerState === "overridden"
                  ? "bg-warn-tint text-warn"
                  : "bg-canvas-sunk text-ink/68",
              )}
            >
              {finding.reviewerState === "overridden"
                ? `→ ${finding.reviewerVerdict ?? "changed"}`
                : "confirmed"}
            </span>
          )}
          <span>{Math.round(finding.confidence * 100)}%</span>
          <ChevronDown
            size={14}
            className={cn("transition-transform duration-200", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3.5">
          {finding.clauseStatement && (
            <p className="mb-3 text-[13px] leading-relaxed text-ink/72">
              <span className="text-ink/62">Requires: </span>
              {finding.clauseStatement}
            </p>
          )}

          {finding.evidence.length > 0 ? (
            <ul className="mb-3 space-y-2">
              {finding.evidence.map((item) => (
                <li
                  key={item.chunkId}
                  className="overflow-hidden rounded-lg border border-line bg-card"
                >
                  <div className="px-3 py-2.5">
                    <p className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink/62">
                      {/* A quote from a whole-document reading has no heading;
                          what a reviewer needs to know is that it was checked. */}
                      <span>
                        {item.sourceKind === "quote"
                          ? "Quoted from the document, checked word for word"
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
                    <Excerpt item={item} />
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

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => decide(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/72 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              <Check size={12} />
              Confirm
            </button>

            {mode ? (
              /* Choosing a verdict no longer submits on the spot. The reason
                 for a review is the most valuable thing a reviewer produces
                 — it is what a standing decision is made of — and a flow that
                 never asked for it was throwing that away. */
              <div className="w-full space-y-3 rounded-lg border border-line bg-canvas-sunk p-3">
                {mode === "override" && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[11.5px] text-ink/64">Correct verdict:</span>
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

                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-ink/64">
                    Why? This becomes the decision if you keep it.
                  </span>
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={2}
                    placeholder="e.g. KMS-managed keys in eu-west-1 satisfy this clause."
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
                        ? "Every later assessment of this clause will be judged with this decision in front of it."
                        : "Add a reason first — a decision with no stated basis is not one worth keeping."}
                    </span>
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending || (mode === "override" && !chosen)}
                    onClick={() =>
                      mode === "override"
                        ? decide(false, chosen ?? undefined)
                        : decide(true)
                    }
                    className="rounded-full bg-royal px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
                  >
                    {remember
                      ? "Save and remember"
                      : mode === "override"
                        ? "Save override"
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
                  Confirm with a reason…
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setMode("override")}
                  className="rounded-full border border-line px-3 py-1.5 text-[12px] text-ink/68 transition-colors hover:border-warn-line hover:text-warn disabled:opacity-50"
                >
                  Override
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
