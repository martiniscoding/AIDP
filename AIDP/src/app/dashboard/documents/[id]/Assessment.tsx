"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  CircleHelp,
  CircleSlash,
  Loader2,
  Play,
  Scale,
  ShieldAlert,
  Square,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  VERDICTS,
  VERDICT_META,
  applyLens,
  severityOf,
  type EvidenceItem,
  type Lens,
  type Obligation,
  type Verdict,
  type VerdictCounts,
} from "@/lib/ingest/verdicts";
import {
  type AppliedDecision,
  type DecisionScope,
} from "@/lib/ingest/decision-effects";
import type { EvidenceView } from "@/lib/ingest/evidence-tables";
import type { TableView } from "@/lib/ingest/documents";
import type { CoverageView } from "@/lib/ingest/coverage";
import type { AdviceView } from "@/lib/ingest/advice";
import type { LifecycleView } from "@/lib/ingest/lifecycle";
import { SLOW_PICKUP_MS, type JobView } from "@/lib/ingest/pipeline";
import {
  applyStandard,
  cancelAssessment,
  discardStandard,
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
import { FindingModal } from "./FindingModal";

export type FindingView = {
  id: string;
  clauseRef: string;
  clauseTitle: string;
  clauseStatement: string;
  verdict: string;
  confidence: number;
  rationale: string;
  /** How strongly the clause bound, and how that was established. Severity rests on it. */
  obligation: Obligation;
  obligationSource: string;
  evidence: EvidenceView[];
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
  /**
   * The tables behind a gap's quote, by section ordinal, where the quote turned
   * out to be made of them. A gap over a table section quoted sixteen "Category:"
   * labels in one run-on line; this is the same table, shown as one.
   */
  coverageTables: Record<number, TableView[]>;
  /** Improvements to the design itself, suggested after the assessment. Advice, not a verdict. */
  advice: AdviceView | null;
  /** Whether the products the design names are still supported, from endoflife.date. Facts, not a verdict. */
  lifecycle: LifecycleView | null;
} | null;

/** The three parts of a rationale, in the order the engine writes them. */
export const RATIONALE_PARTS = ["Gap", "Impact", "Fix"] as const;

/**
 * A rationale split into gap, impact and fix.
 *
 * The judge is now told to write exactly those three, in that order, for any
 * verdict that is not "covered" (rules 8 and 11 in Workers/aidp/ai/llm.py). Run
 * together as one paragraph they read as the wall of text the whole change was
 * meant to remove — the three facts are there but the reader has to find the
 * boundaries, which is most of the work of skimming eighty findings.
 *
 * Split on sentence ends rather than on a delimiter the model was asked to
 * emit: a format token is one more instruction to disobey, and the sentences
 * are what the prompt actually constrains. Exactly three sentences is the
 * shape being labelled, so anything else — a one-line "covered", an older
 * finding written before the rule, a model that ignored it — is returned
 * unsplit and rendered as the paragraph it is. That is the honest fallback:
 * labelling two sentences "Gap" and "Impact" would promise a fix that was
 * never written.
 */
export function rationaleParts(rationale: string): string[] | null {
  const trimmed = rationale.trim();
  // A decimal or an abbreviation would split a sentence in the wrong place, so
  // require a space and a capital after the stop.
  const sentences = trimmed
    // A stop ends a sentence only when a space and a capital follow, which
    // keeps "TLS 1.2", "1.0" and "section 4.2" intact.
    //
    // The lookbehind then excludes the abbreviations that *do* take a capital
    // after them — "e.g. Kafka", "i.e. Apigee", "Acme Inc. Payments" — because
    // the budget is now 600 characters rather than 280, and a sentence with
    // room for an aside will contain one. Each is listed with its trailing dot,
    // since the split point sits after that dot and that is what the lookbehind
    // sees. A rationale that splits wrongly loses its labels and renders as a
    // paragraph, so this is worth being exact about.
    //
    // "etc." is deliberately absent: it ends a sentence at least as often as it
    // sits inside one, and guarding it broke the commoner case.
    .split(
      /(?<!\be\.g\.|\bi\.e\.|\bvs\.|\bcf\.|\bapprox\.|\bno\.|\bfig\.|\bincl\.|\bInc\.|\bLtd\.|\bDept\.)(?<=[.!?])\s+(?=[A-Z0-9"“'])/,
    )
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.length === RATIONALE_PARTS.length ? sentences : null;
}

export const TONE: Record<string, string> = {
  bad: "border-danger-line bg-danger-tint text-danger",
  warn: "border-warn-line bg-warn-tint text-warn",
  unknown: "border-line bg-card text-ink/72",
  // Deliberately the quietest chip on the screen. A clause that does not govern
  // this design is not a result, and giving it any colour would put it in the
  // same visual class as the findings that need a decision.
  neutral: "border-line bg-canvas-sunk text-ink/50",
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

/**
 * The report's four parts, and the order they are offered in.
 *
 * "compliance" is first and is what the page opens on: it is the only one of
 * the four that answers "does this design meet the standards we wrote?", and
 * every other tab holds something that is explicitly not a verdict. Keeping
 * them in one column let a suggestion sit a screen below a breach, which is
 * the clutter this split exists to remove.
 */
const TABS = ["compliance", "uncovered", "improvements", "technology"] as const;

type Tab = (typeof TABS)[number];

const TAB_META: Record<Tab, { label: string; blurb: string }> = {
  compliance: {
    label: "Compliance",
    blurb: "Verdicts against the organisation's own standards, clause by clause.",
  },
  uncovered: {
    label: "Not covered",
    blurb: "Parts of this design that no clause in the framework governs.",
  },
  improvements: {
    label: "Improvements",
    blurb: "What a reviewer would still ask of the design. Advice, not verdicts.",
  },
  technology: {
    label: "Technology support",
    blurb: "Whether the products this design builds on are still supported.",
  },
};

/**
 * The tab bar, with a count on anything that has one.
 *
 * A count is what makes a tab worth clicking: "Improvements" says nothing about
 * whether there are any, and a reviewer who opens an empty tab twice stops
 * opening it. A tab with nothing in it is still shown and still reachable —
 * each panel explains its own emptiness, including when a check could not run,
 * and hiding it would leave a reader unable to tell "none" from "not asked".
 */
function Tabs({
  tab,
  setTab,
  counts,
}: {
  tab: Tab;
  setTab: (next: Tab) => void;
  counts: Partial<Record<Tab, number>>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Report sections"
      className="mb-4 flex flex-wrap gap-1 border-b border-line"
    >
      {TABS.map((name) => {
        const active = tab === name;
        const count = counts[name];
        return (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={active}
            title={TAB_META[name].blurb}
            onClick={() => setTab(name)}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
              active
                ? "border-royal text-ink"
                : "border-transparent text-ink/64 hover:border-line-strong hover:text-ink/82",
            )}
          >
            {TAB_META[name].label}
            {count !== undefined && count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[11px]",
                  active ? "bg-royal/12 text-royal" : "bg-canvas-sunk text-ink/62",
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

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
   * Which part of the report is on screen.
   *
   * Everything used to be one column: the clause findings, then what no
   * standard covers, then the technology dates, then the suggested
   * improvements. Three of those four are not verdicts against the customer's
   * standards, and stacking them under the findings put general advice a model
   * proposed in the same scroll as a breach of a rule the customer wrote. A
   * reviewer answering "what fails our standards?" had to scroll past it, and
   * the report read as longer and vaguer than it is.
   *
   * So compliance is the tab you land on and the others are a click away. The
   * split is by what a thing *is*, not by how long it is: "Compliance" holds
   * the verdicts, and the rest hold facts and advice that are explicitly not
   * verdicts. Each section already said as much in its own words — see
   * Improvements.tsx and Lifecycle.tsx — and this stops the layout implying
   * otherwise.
   *
   * Not router state. A tab is a view of a report already fetched, and putting
   * it in the URL would make the back button walk through tabs instead of
   * leaving the report.
   */
  const [tab, setTab] = useState<Tab>("compliance");

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
  /**
   * Every clause the run judged, including the ones this view never lists.
   *
   * `findings` has already had "absent" removed server-side — those are the
   * reverse question, answered on the Not covered tab — and the default lens
   * then folds "covered" and "not_applicable" away. So on a framework where
   * most clauses pass or are unaddressed, the list can legitimately hold one
   * row out of a hundred, and nothing on screen said the other ninety-nine
   * existed. That reads as a broken engine, and it is the report quietly
   * agreeing. `counts` is the honest total: it comes from verdictCounts over
   * the run, not from the filtered array.
   */
  const judged = VERDICTS.reduce((total, verdict) => total + counts[verdict], 0);
  const hidden = judged - shown.length;
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

      {run && !inFlight && (
        <Tabs
          tab={tab}
          setTab={setTab}
          counts={{
            compliance: counts.contradicts + counts.partial + counts.needs_review,
            uncovered: run.coverage?.gaps.length ?? 0,
            improvements: run.advice?.suggestions.length ?? 0,
            technology: run.lifecycle?.technologies.filter(
              (t) => t.status === "ended" || t.status === "ending",
            ).length ?? 0,
          }}
        />
      )}

      {/* Parts of the design no clause governs. Its own tab rather than a
          verdict filter: these are passages of the design, not clauses, and
          listing them through the same control as a verdict was what made
          "Absent" look like a fifth verdict. */}
      {run && !inFlight && tab === "uncovered" && (
        <CoverageGaps
          coverage={run.coverage}
          frameworkName={run.frameworkName}
          gapTables={run.coverageTables}
        />
      )}

      {run && tab === "compliance" && (findings.length > 0 || run.coverage !== null) && (
        <>
          {/* Coverage across the framework. Also the filter.

              Verdicts only now. The "Absent" chip here counted coverage gaps —
              parts of the design, not clauses — so it sat in a row of verdicts
              while meaning something else entirely, and clicking it replaced
              the findings list with a different kind of thing. It is the "Not
              covered" tab above. */}
          <div className="mb-4 flex flex-wrap gap-2">
            {VERDICTS.filter((verdict) => verdict !== "absent").map((verdict) => {
              const meta = VERDICT_META[verdict];
              const count = counts[verdict];
              const active = lens === verdict;
              return (
                <button
                  key={verdict}
                  type="button"
                  title={meta.blurb}
                  onClick={() => setLens(active ? "attention" : verdict)}
                  disabled={count === 0}
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

          <>
          <p className="mb-3 text-[12px] text-ink/62">
            Showing {shown.length} of {judged} clause{judged === 1 ? "" : "s"} judged
            {hidden > 0 && (
              <>
                {" · "}
                {hidden} not listed here
                {" · "}
                <button
                  type="button"
                  onClick={() => setLens("all")}
                  className="text-royal hover:text-ink"
                >
                  show every verdict
                </button>
              </>
            )}
            {" · "}
            {reviewed} reviewed
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
        </>
      )}

      {run && tab === "compliance" && findings.length === 0 && !inFlight && run.coverage === null && (
        <p className="rounded-xl border border-line bg-card px-5 py-8 text-center text-[13.5px] text-ink/64">
          No findings recorded. The run may have failed before it reached a clause.
        </p>
      )}

      {/* Each on its own tab, never under the findings: these are facts about
          the products and advice about the design, not verdicts against a
          clause, and a reader must not take one for the other. Both sections
          already say so in their own words; stacking them below a breach said
          otherwise with the layout.

          Shown once the run is no longer live, not only when it completed.
          These passes run after the last clause, so a run stopped at "14 of 14"
          has them worked out and stored — and gating on the run's own state hid
          finished suggestions and technology dates behind a verdict about the
          clause loop. Each reads its own payload's state and says so itself,
          including when it failed, which is why an empty tab is still offered. */}
      {run && !inFlight && tab === "technology" && <Lifecycle lifecycle={run.lifecycle} />}
      {run && !inFlight && tab === "improvements" && (
        <Improvements advice={run.advice} runId={run.id} />
      )}
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
export function Excerpt({ item }: { item: EvidenceItem }) {
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
export function StandardProposal({
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

/**
 * One finding in the queue: a strip, and the detail over the top.
 *
 * Deliberately thin. A reviewer opening a hundred-clause report is triaging,
 * and the three things that decide which row to open are how serious it is,
 * which clause it is, and what the gap actually is. Everything else — the
 * impact, the fix, the quotes, the decision controls — used to expand inside
 * the row, which pushed the rest of the queue off the screen and made the page
 * a wall of text whichever row was open. It is in `FindingModal` now.
 *
 * So the strip carries the badge, the clause, one line of gap, and whatever a
 * reviewer needs in order to skip it: what was decided, whether a clause
 * proposal is waiting, and the severity. A settled row is dimmed and ticked
 * rather than removed, because the evidence that a clause was reviewed is the
 * thing an audit asks for.
 */
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
  const [open, setOpen] = useState(false);

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const severity = severityOf(finding.verdict, finding.confidence, finding.obligation);
  const decided = finding.reviewerState !== "pending";
  const draft = finding.draft;

  /**
   * The gap alone, which is the first of the three sentences the judge writes.
   *
   * On a strip this is the whole job: it says what is wrong, and the impact and
   * the fix are what the reviewer opens the finding to read. Where the
   * rationale is not three sentences — a one-line "covered", a finding written
   * before the rule — the whole of it is shown and clamped, which is what the
   * row did before. See `rationaleParts`.
   */
  const parts = rationaleParts(finding.rationale);
  const gap = parts ? parts[0] : finding.rationale;

  /**
   * An accepted risk: the breach stands, allowed for this project alone.
   *
   * Read back from what the act leaves behind rather than stored as a fourth
   * reviewer state — an override of a breach to "covered" kept at project
   * scope is precisely this shape and nothing else produces it. Worth its own
   * mark because it is the one outcome where the design ships against a
   * standard, and a reviewer scanning a settled report should not have to open
   * a card to find that out.
   */
  const allowed =
    finding.verdict === "contradicts" &&
    finding.reviewerState === "overridden" &&
    finding.promotedScope === "project";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          decided
            ? "border-line bg-canvas-sunk/60 hover:bg-canvas-sunk"
            : "border-line bg-card hover:border-line-strong",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
            TONE[meta.tone],
            decided && "opacity-70",
          )}
        >
          {meta.tone === "bad" ? (
            <ShieldAlert size={11} />
          ) : meta.tone === "warn" ? (
            <TriangleAlert size={11} />
          ) : meta.tone === "good" ? (
            <Check size={11} />
          ) : meta.tone === "neutral" ? (
            <CircleSlash size={11} />
          ) : (
            <CircleHelp size={11} />
          )}
          {meta.label}
        </span>

        {/* The clause and its gap, on one line each at most. min-w-0 is what
            lets the gap truncate rather than widening the row. */}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[11.5px] text-ink/58">{finding.clauseRef}</span>
            <span
              className={cn(
                "truncate text-[13.5px]",
                decided ? "text-ink/62" : "text-ink/88",
              )}
            >
              {finding.clauseTitle}
            </span>
          </span>
          {gap && (
            <span
              className={cn(
                "mt-0.5 block truncate text-[12.5px] leading-relaxed",
                decided ? "text-ink/50" : "text-ink/66",
              )}
            >
              {gap}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink/62">
          {/* What was decided, and about what. Three different acts end up
              here — agreeing with the finding, correcting a verdict the engine
              got wrong, and letting a breach stand anyway — and a reviewer
              coming back to eighty rows has to tell them apart without opening
              each one. */}
          {decided && (
            <span
              className={cn(
                "hidden items-center gap-1 rounded px-1.5 py-0.5 sm:inline-flex",
                finding.reviewerState === "overridden"
                  ? "bg-warn-tint text-warn"
                  : allowed
                    ? "bg-danger-tint text-danger"
                    : "bg-canvas-sunk text-ink/68",
              )}
            >
              <Check size={10} aria-hidden="true" />
              {finding.reviewerState === "overridden"
                ? `Verdict corrected → ${VERDICT_META[finding.reviewerVerdict as Verdict]?.label ?? finding.reviewerVerdict ?? "changed"}`
                : allowed
                  ? "Risk accepted"
                  : `Issue confirmed · ${meta.label}`}
            </span>
          )}
          {/* The strip has to say a proposal is waiting inside it. A reviewer
              working a queue does not open the rows that look settled. */}
          {draft?.state === "ready" && (
            <span className="hidden rounded bg-royal/10 px-1.5 py-0.5 text-royal sm:inline">
              {draft.requirements.length > 0 ? "clause proposal" : "clause checked"}
            </span>
          )}
          {draft?.state === "drafting" && (
            <Loader2 size={11} className="animate-spin text-ink/45" />
          )}
          {severity && <SeverityTag severity={severity} />}
          <ChevronRight size={14} className="text-ink/40" aria-hidden="true" />
        </span>
      </button>

      {open && (
        <FindingModal
          finding={finding}
          project={project}
          mayCurate={mayCurate}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  );
}
