"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Loader2,
  Play,
  Scale,
  ShieldAlert,
  Square,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  VERDICTS,
  SEVERITY_META,
  VERDICT_META,
  applyLens,
  severityOf,
  type EvidenceItem,
  type Lens,
  type Verdict,
  type VerdictCounts,
} from "@/lib/ingest/verdicts";
import {
  EFFECT_META,
  SCOPE_META,
  type AppliedDecision,
  type DecisionScope,
} from "@/lib/ingest/decision-effects";
import type { CoverageView } from "@/lib/ingest/coverage";
import type { AdviceView } from "@/lib/ingest/advice";
import type { LifecycleView } from "@/lib/ingest/lifecycle";
import { SLOW_PICKUP_MS, type JobView } from "@/lib/ingest/pipeline";
import {
  applyStandard,
  cancelAssessment,
  discardStandard,
  makeStandard,
  reviewFinding,
  startAssessment,
} from "../actions";
import { PipelineWatcher } from "../PipelineWatcher";
import { startProjectAssessment } from "../../projects/actions";
import { Ticker } from "../Ticker";
import { useLiveProgress } from "../useLiveProgress";
import { CoverageGaps } from "./CoverageGaps";
import { SeverityTag } from "./SeverityTag";
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
  /** How far that decision reaches. Null until one has been kept. */
  promotedScope: DecisionScope | null;
  /**
   * The live proposal to sharpen this finding's clause, if one has been asked
   * for. Only a `partial` ever has one — see SHARPENABLE in
   * src/lib/ingest/standards.ts.
   */
  draft: StandardDraft | null;
};

/**
 * A proposed sharpening, as the report shows it.
 *
 * Flattened from `DraftView` for the client: dates and Prisma JSON do not
 * cross the boundary, and the panel needs none of the rest.
 */
export type StandardDraft = {
  id: string;
  state: "drafting" | "ready" | "failed" | "applied" | "discarded";
  /** The lines proposed, in the words a standard would use. */
  requirements: string[];
  /** The model's one line on what the clause left unsaid. */
  note: string;
  error: string | null;
  /** Lines the checks threw away, with the reason. */
  setAside: { text: string; reason: string }[];
  /** What the clause requires today, to read the proposal against. */
  existing: string[];
  /**
   * Active "accepts" rulings anchored to this clause's reference. They carry
   * over to the sharpened clause, so one recorded against the vaguer wording
   * would excuse the new requirement — see DraftView.decisionsInTheWay.
   */
  decisionsInTheWay: { id: string; title: string; effect: string }[];
};

/** The project a report's findings belong to, when they belong to one. */
export type ProjectRef = { id: string; name: string };

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

/**
 * Longer than this and the collapsed row's two-line clamp may be hiding some of
 * the reason, so the expanded panel repeats it in full. Shorter and the clamp
 * shows all of it, and repeating it would just be the same sentence twice.
 */
const RATIONALE_CLAMP = 160;

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
 * nobody is working on any more. The job can.
 *
 * The numbers come from `useLiveProgress`, which polls the run on its own every
 * couple of seconds. They used to come from the page re-rendering on a timer,
 * and that could not keep up with itself: the whole report was re-queried to
 * carry one number, so the count stuck on its first clause until somebody
 * reloaded.
 */
function RunProgress({ run }: { run: NonNullable<RunView> }) {
  const live = useLiveProgress({
    id: run.id,
    state: run.state,
    totalClauses: run.totalClauses,
    completedClauses: run.completedClauses,
    orphaned: run.orphaned,
    job: run.job,
  });
  const job = live.job;
  const started = live.state === "running";
  // Every clause judged, and the run still working: what is left is coverage,
  // the suggestions and the technology dates.
  const pastClauses =
    live.totalClauses > 0 && live.completedClauses >= live.totalClauses;
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
      headline = !started
        ? "Picked up by an analysis worker — getting ready"
        : pastClauses
          ? "Finishing the report"
          : "Assessing clause by clause";
      // Before the first clause the step is the only sign of life, and after the
      // last one it is again: three more passes follow — the parts no standard
      // covers, the suggested improvements, the technology dates — and on a
      // large design with a slow model they take minutes. Without this the
      // panel sat on "Assessing clause by clause" with the bar pinned at "14 of
      // 14", which reads as a finished run that hung, and reviewers stopped
      // runs that were nearly done. In between, the clause count says more.
      if ((!started || pastClauses) && job.step) {
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
          {started && `${live.completedClauses} / ${live.totalClauses} clauses`}
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
          aria-valuemax={live.totalClauses}
          aria-valuenow={live.completedClauses}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas-sunk"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700",
              troubled ? "bg-warn/60" : "bg-royal-mid",
            )}
            style={{
              width: `${Math.max(2, live.totalClauses ? Math.min(100, (live.completedClauses / live.totalClauses) * 100) : 0)}%`,
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
/**
 * What is being assessed.
 *
 * A design, or a whole project — the panel is the same report either way, and
 * only the action behind "Assess" differs. A union rather than two optional ids
 * so a caller cannot pass neither, or both.
 */
export type Scope =
  | { kind: "document"; documentId: string }
  | { kind: "project"; projectId: string };

export function Assessment({
  scope,
  project,
  run,
  counts,
  findings,
  decisionsInForce,
  mayCurate,
}: {
  scope: Scope;
  /**
   * The project this report's findings belong to. A project run always has one;
   * a single design has its own, or none if it sits outside every project.
   * Null means a breach cannot be allowed "for this project", and the offer is
   * not made rather than made and refused on save.
   */
  project: ProjectRef | null;
  run: RunView;
  counts: VerdictCounts;
  findings: FindingView[];
  /** Standing decisions this run will be judged with. */
  decisionsInForce: number;
  /** Whether this person may change the standards. See canManageStandards. */
  mayCurate: boolean;
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
  /**
   * A clause proposal is written by the analyse worker, so the page has to come
   * back for it the way it comes back for a running pipeline. Nothing is
   * scheduled once every proposal has landed — see PipelineWatcher.
   */
  const drafting = findings.some((finding) => finding.draft?.state === "drafting");


  // One way to assess a design, so no mode to choose: every clause is judged on
  // the passages a search finds, and whatever comes back absent is re-read
  // against the whole document before it is reported. See Workers/aidp/stages.
  const begin = () =>
    startTransition(async () => {
      const result =
        scope.kind === "project"
          ? await startProjectAssessment(scope.projectId)
          : await startAssessment(scope.documentId);
      setMessage(result.message);
      router.refresh();
    });

  // Offered whenever a run has not finished. Waiting for a worker that is busy
  // with somebody else's design can take a while, and the person watching is the
  // one who knows it is no longer worth waiting for.
  const stop = () =>
    startTransition(async () => {
      if (!run) return;
      const result = await cancelAssessment(run.id);
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

          {inFlight && (
            <button
              type="button"
              onClick={() => stop()}
              disabled={pending}
              title="Stop this assessment. Whatever it has already found is kept, and you can run it again."
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-opacity",
                "border-warn-line bg-warn-tint text-warn hover:opacity-85",
                "disabled:cursor-not-allowed disabled:opacity-55",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
              )}
            >
              <Square size={11} aria-hidden="true" />
              Stop
            </button>
          )}
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
              <PipelineWatcher active={drafting} />
              {shown.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  project={project}
                  mayCurate={mayCurate}
                />
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
      {/* Shown once the run is no longer live, not only when it completed.
          These three passes run after the last clause, so a run stopped at
          "14 of 14" has them worked out and stored — and gating on the run's
          own state hid finished, complete suggestions and technology dates
          behind a verdict about the clause loop. Each section reads its own
          payload's state and says so itself, including when it failed. */}
      {run && !inFlight && <Lifecycle lifecycle={run.lifecycle} />}
      {run && !inFlight && <Improvements advice={run.advice} runId={run.id} />}
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

/**
 * A proposed sharpening of one clause, and the decision to take it or not.
 *
 * Shown beside the finding that prompted it rather than in a queue of its own,
 * because the case for the change *is* the finding: the clause could not be
 * judged, and here is what it was missing. Read anywhere else it would be three
 * sentences with nothing behind them.
 *
 * The lines are editable. What the approver settles on is what binds, and a
 * model's wording that is nearly right is faster to fix here than to reject and
 * ask for again.
 */
function StandardProposal({
  draft,
  clauseRef,
}: {
  draft: StandardDraft;
  clauseRef: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lines, setLines] = useState<string[]>(draft.requirements);
  const [message, setMessage] = useState<string | null>(null);

  const keep = lines.filter((line) => line.trim().length > 0);

  const approve = () =>
    startTransition(async () => {
      const result = await applyStandard(draft.id, keep);
      setMessage(result.message);
      if (result.ok) router.refresh();
    });

  const discard = () =>
    startTransition(async () => {
      const result = await discardStandard(draft.id);
      setMessage(result.message);
      if (result.ok) router.refresh();
    });

  if (draft.state === "drafting") {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-canvas-sunk px-3 py-2.5 text-[12.5px] text-ink/68">
        <Loader2 size={12} className="animate-spin text-ink/45" />
        Working out the requirement lines {clauseRef} was missing…
      </div>
    );
  }

  if (draft.state === "failed") {
    return (
      <div className="mb-3 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5">
        <p className="text-[12.5px] text-warn">
          The requirement lines could not be worked out. {draft.error}
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={discard}
          className="mt-2 text-[11.5px] text-ink/62 underline decoration-ink/25 underline-offset-2 hover:text-ink/78 disabled:opacity-50"
        >
          dismiss
        </button>
        {message && <p className="mt-1.5 text-[11.5px] text-ink/68">{message}</p>}
      </div>
    );
  }

  if (draft.state !== "ready") return null;

  return (
    <div className="mb-3 rounded-lg border border-royal-mid/30 bg-royal/[0.06] px-3 py-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-royal">
        <Scale size={11} />
        Proposed for {clauseRef || "this clause"}
      </p>

      {draft.note && (
        <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink/78">{draft.note}</p>
      )}

      {/* What the clause requires today, so the proposal is read against it
          rather than in isolation — the commonest reason to reject a line is
          that something above already says it. */}
      {draft.existing.length > 0 && (
        <div className="mb-2.5">
          <p className="mb-1 text-[11.5px] text-ink/62">It already requires:</p>
          <ul className="space-y-0.5">
            {draft.existing.map((line, index) => (
              <li key={index} className="text-[12px] leading-relaxed text-ink/62">
                · {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lines.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11.5px] text-ink/62">
            Add{lines.length === 1 ? "" : " these"}, editing the wording if you want to:
          </p>
          {lines.map((line, index) => (
            <textarea
              key={index}
              value={line}
              disabled={pending}
              onChange={(event) =>
                setLines((current) =>
                  current.map((old, at) => (at === index ? event.target.value : old)),
                )
              }
              rows={2}
              className="w-full resize-y rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px] leading-relaxed text-ink/88 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid disabled:opacity-60"
            />
          ))}
        </div>
      ) : (
        /* The honest answer, and a real one: a clause that was already specific
           enough needs nothing added. Said rather than shown as an empty box. */
        <p className="text-[12.5px] leading-relaxed text-ink/72">
          Nothing to add — this clause is already specific enough to judge against. The
          partial is about the design, not the wording.
        </p>
      )}

      {/* The hole this closes: the worker matches decisions on the clause
          reference, so a ruling made against the vaguer wording carries over
          and would excuse the line being added. */}
      {draft.decisionsInTheWay.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-warn-line bg-warn-tint px-2.5 py-2">
          <p className="text-[12px] leading-relaxed text-warn">
            {draft.decisionsInTheWay.length === 1
              ? "One standing decision on this clause accepts an arrangement that satisfies it"
              : `${draft.decisionsInTheWay.length} standing decisions on this clause accept arrangements that satisfy it`}
            , and they will carry over to the sharper wording — so they may excuse the
            line you are adding. Review{" "}
            <a
              href="/dashboard/decisions"
              className="underline decoration-warn/40 underline-offset-2"
            >
              the register
            </a>{" "}
            after this:{" "}
            {draft.decisionsInTheWay.map((decision) => decision.title).join("; ")}.
          </p>
        </div>
      )}

      {draft.setAside.length > 0 && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[11.5px] text-ink/58 hover:text-ink/72">
            {draft.setAside.length} line{draft.setAside.length === 1 ? "" : "s"} refused by the
            checks
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {draft.setAside.map((line, index) => (
              <li key={index} className="text-[12px] leading-relaxed text-ink/62">
                “{line.text}” — {line.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || keep.length === 0}
          onClick={approve}
          className="rounded-full bg-royal px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {keep.length === 1 ? "Add this requirement" : `Add ${keep.length} requirements`}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={discard}
          className="text-[12px] text-ink/62 hover:text-ink/78 disabled:opacity-50"
        >
          discard
        </button>
        {/* Said before the press, not after: a reader deciding whether to click
            needs to know the old wording survives. */}
        <span className="text-[11px] text-ink/54">
          Kept as a new version. The earlier wording stays on the record.
        </span>
      </div>

      {message && <p className="mt-2 text-[11.5px] text-ink/72">{message}</p>}
    </div>
  );
}

function FindingRow({
  finding,
  project,
  mayCurate,
}: {
  finding: FindingView;
  project: ProjectRef | null;
  /** Whether this person may change the standards. See canManageStandards. */
  mayCurate: boolean;
}) {
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
  /**
   * "allow" is the third intent, and it is an override with its answers
   * already filled in: the design stands, the clause is satisfied for this
   * piece of work, and nothing else inherits that. A board allows a breach for
   * one migration far more often than it rewrites the standard, and before
   * this the only way to record it was a decision that bound every future
   * assessment the customer ever ran.
   */
  const [mode, setMode] = useState<"confirm" | "override" | "allow" | null>(null);

  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<DecisionScope>("organisation");

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const severity = severityOf(finding.verdict, finding.confidence);
  const decided = finding.reviewerState !== "pending";

  /**
   * Offered on a breach, and only with a project to confine it to.
   *
   * Not on "partial" or "needs_review": those are arguments about what the
   * design says, and the answer to them is a verdict, not a dispensation.
   * Allowing is for the case everyone already agrees on — the clause is broken,
   * and broken here is acceptable.
   */
  const allowable = finding.verdict === "contradicts" && project !== null && !decided;

  /**
   * Offered on a confirmed `partial`, and nothing else.
   *
   * A partial that somebody has agreed with is the system saying it could not
   * judge the clause as written — the one verdict whose cause may be the
   * wording rather than the design. An override says the verdict was wrong, and
   * sharpening from one would write the model's mistake into the library; the
   * server refuses that too.
   */
  const sharpenable =
    mayCurate &&
    finding.verdict === "partial" &&
    finding.reviewerState === "confirmed" &&
    finding.draft === null;

  const draft = finding.draft;

  const decide = (confirm: boolean, verdict?: string) =>
    startTransition(async () => {
      await reviewFinding(finding.id, {
        confirm,
        verdict,
        note: note.trim() || undefined,
        remember,
        scope,
      });
      setMode(null);
      setChosen(null);
      setNote("");
      setRemember(false);
      setScope("organisation");
      router.refresh();
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
            <span className="mt-1 line-clamp-2 block text-[12.5px] leading-relaxed text-ink/66">
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
          {/* A kept ruling and a kept ruling that only reaches this project are
              different things, and a row that said neither left the reviewer to
              remember which they had chosen. */}
          {finding.promotedScope === "project" && (
            <span className="rounded bg-royal/10 px-1.5 py-0.5 text-royal">this project</span>
          )}
          {/* The row has to say a proposal is waiting inside it. A reviewer
              working a queue of eighty findings does not open the ones that
              look settled. */}
          {draft?.state === "ready" && (
            <span className="rounded bg-royal/10 px-1.5 py-0.5 text-royal">
              {draft.requirements.length > 0 ? "clause proposal" : "clause checked"}
            </span>
          )}
          {draft?.state === "drafting" && (
            <Loader2 size={11} className="animate-spin text-ink/45" />
          )}
          {/* Where the model's confidence percentage used to be. That number
              was the model's opinion of itself, and sitting beside
              "Contradicts" it invited a reader to treat a breach as 13% fine.
              This answers the question a reviewer actually has, which is which
              rows to open first. The confidence is inside, for anyone doubting
              a verdict rather than triaging one. */}
          {severity && <SeverityTag severity={severity} />}
          <ChevronDown
            size={14}
            className={cn("transition-transform duration-200", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3.5">
          {finding.rationale.length > RATIONALE_CLAMP && (
            <p className="mb-3 text-[13px] leading-relaxed text-ink/78">
              {finding.rationale}
            </p>
          )}
          {finding.clauseStatement && (
            <p className="mb-3 text-[13px] leading-relaxed text-ink/72">
              <span className="text-ink/62">Requires: </span>
              {finding.clauseStatement}
            </p>
          )}

          {/* Kept, and kept here. Somebody who thinks a verdict is wrong wants
              to know how sure the engine was; somebody working down the list
              does not, and it was taking up the one place on the row where the
              priority belongs. */}
          <p className="mb-3 text-[12px] text-ink/58">
            {severity ? `${SEVERITY_META[severity].blurb} ` : ""}
            The model was {Math.round(finding.confidence * 100)}% sure of this verdict.
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

          {draft && <StandardProposal draft={draft} clauseRef={finding.clauseRef} />}

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

                {/* The breach is not being denied, and the wording says so: the
                    clause is still broken, and this is the dispensation for it.
                    "Looks fine to me" is the Override path and means something
                    else. */}
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
                    Allow for this project…
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
      )}
    </li>
  );
}
