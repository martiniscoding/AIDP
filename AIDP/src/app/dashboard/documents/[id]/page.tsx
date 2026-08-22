import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, ImageIcon, Info, Table2 } from "lucide-react";
import { auth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { getDocument, isTerminal, STATUS_LABEL } from "@/lib/ingest/documents";
import { latestRun, listFindings, verdictCounts } from "@/lib/ingest/assessment";
import { emptyCounts, readEvidence, type VerdictCounts } from "@/lib/ingest/verdicts";
import { readAppliedDecisions } from "@/lib/ingest/decision-effects";
import { countActive, promotedFrom } from "@/lib/ingest/decisions";
import { historyForRun } from "@/lib/ingest/outcomes";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { canManageStandards } from "@/lib/access/roles";
import { Assessment, type FindingView, type RunView } from "./Assessment";
import { Figures, type FigureView } from "./Figures";
import { ConfirmStructure } from "./ConfirmStructure";
import { Decide, type OutcomeView } from "./Decide";
import { DocumentActions } from "../DocumentActions";
import { PipelineWatcher } from "../PipelineWatcher";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const { id } = await params;

  let document;
  try {
    document = await getDocument(session.user.id, id);
  } catch (error) {
    // A document in someone else's organisation is indistinguishable from one
    // that does not exist. Saying "forbidden" would confirm it is real.
    if (error instanceof NotAMember) notFound();
    throw error;
  }
  if (!document) notFound();

  // Reference standards are the administrator's to curate, so the controls that
  // change one are only offered to them. `guardStandards` in ../actions.ts
  // refuses regardless — this keeps the page from showing a button that would
  // be turned down, which reads as a rule rather than as a fault. The role is
  // read against the *document's* organisation, since a consultant can
  // administer one customer and merely belong to another.
  const membership = await requireMembership(session.user.id, document.organisationId);
  const mayChange =
    document.role === "assessed" || canManageStandards(membership.role);

  const clauses = document.sections.reduce((n, s) => n + s.clauses.length, 0);
  const tables = document.sections.reduce((n, s) => n + s.tables.length, 0);
  const figureViews: FigureView[] = document.sections
    .flatMap((s) =>
      s.figures.map((f) => ({
        id: f.id,
        page: f.page,
        caption: f.caption,
        description: f.description,
        correctedDescription: f.correctedDescription,
        reviewState: f.reviewState,
        complexity: f.complexity,
        headingPath: s.headingPath,
      })),
    )
    .sort(
      (a, b) =>
        Number(a.reviewState !== "pending") - Number(b.reviewState !== "pending") ||
        b.complexity - a.complexity,
    );
  const high = document.issues.filter((i) => i.severity === "high");
  const other = document.issues.filter((i) => i.severity !== "high");

  // Only a submitted design gets assessed; a reference standard is what it is
  // assessed against.
  const assessed = document.role === "assessed";
  const run = assessed ? await latestRun(session.user.id, document.id) : null;
  const findings = run ? await listFindings(session.user.id, run.id) : [];
  const counts: VerdictCounts = run ? await verdictCounts(run.id) : emptyCounts();

  const runView: RunView = run
    ? {
        id: run.id,
        state: run.state,
        totalClauses: run.totalClauses,
        completedClauses: run.completedClauses,
        frameworkName: run.framework.name,
        frameworkVersion: run.framework.version,
        model: run.model,
        failureReason: run.failureReason,
      }
    : null;

  // Which of these reviews were already kept as decisions, so the report can
  // say so rather than inviting the same ruling to be recorded twice.
  const decisionsInForce = await countActive(document.organisationId);

  // A decision can only be taken on a finished run, so the history is only
  // fetched for one.
  const outcomes: OutcomeView[] =
    run && run.state === "complete"
      ? (await historyForRun(run.id)).map((o) => ({
          id: o.id,
          decision: o.decision,
          note: o.note,
          decidedByName: o.decidedByName,
          createdAt: o.createdAt.toISOString(),
          snapshot: o.snapshot,
        }))
      : [];
  const unreviewed = findings.filter((f) => f.reviewerState === "pending").length;
  const openFindings = findings.filter(
    (f) => f.verdict === "contradicts" || f.verdict === "absent",
  ).length;
  const promoted = await promotedFrom(
    document.organisationId,
    findings.map((f) => f.id),
  );

  const findingViews: FindingView[] = findings.map((f) => ({
    id: f.id,
    clauseRef: f.clauseRef,
    clauseTitle: f.clauseTitle,
    clauseStatement: f.clauseStatement,
    verdict: f.verdict,
    confidence: f.confidence,
    rationale: f.rationale,
    evidence: readEvidence(f.evidence),
    reviewerState: f.reviewerState,
    reviewerVerdict: f.reviewerVerdict,
    reviewerNote: f.reviewerNote,
    appliedDecisions: readAppliedDecisions(f.appliedDecisions),
    promotedDecisionId: promoted.get(f.id) ?? null,
  }));

  return (
    <>
      <PipelineWatcher
        active={
          !isTerminal(document.status) ||
          run?.state === "queued" ||
          run?.state === "running"
        }
      />

      <Link
        href="/dashboard/documents"
        className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-white/45 transition-colors hover:text-white"
      >
        <ArrowLeft size={14} />
        Standards library
      </Link>

      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.02em] text-white">
            {document.title}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-white/40">
            <span className="text-white/60">{STATUS_LABEL[document.status] ?? document.status}</span>
            {document.docCode && <span>{document.docCode}</span>}
            {document.version && <span>{document.version}</span>}
            {document.pageCount != null && <span>{document.pageCount} pages</span>}
            {document.profile && <span>{document.profile}</span>}
            {document.sensitivity && (
              <span className="rounded border border-white/12 px-1.5 py-0.5 text-white/55">
                {document.sensitivity}
              </span>
            )}
          </p>
        </div>

        {mayChange && (
          <DocumentActions documentId={document.id} title={document.title} redirectAfterDelete />
        )}
      </header>

      {document.failureReason && (
        <p className="mb-6 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[13px] text-amber-200/90">
          {document.failureReason}
        </p>
      )}

      {/* Above the statistics on purpose: the counts below are meaningless
          until someone has agreed the reading that produced them. */}
      {document.structureInferred && mayChange && (
        <ConfirmStructure
          documentId={document.id}
          clauseCount={clauses}
          confirmedAt={document.structureConfirmedAt?.toISOString() ?? null}
          confirmedBy={document.structureConfirmedBy}
        />
      )}

      <dl className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sections" value={document.sections.length} />
        <Stat label="Clauses" value={clauses} />
        <Stat label="Tables" value={tables} />
        <Stat label="Chunks" value={document._count.chunks} />
      </dl>

      {assessed && (
        <Assessment
          documentId={document.id}
          run={runView}
          counts={counts}
          findings={findingViews}
          decisionsInForce={decisionsInForce}
        />
      )}

      {/* The decision comes after the findings: it is the conclusion drawn from
          them, and offering it above the evidence invites a decision taken
          without reading any. */}
      {assessed && run && run.state === "complete" && (
        <Decide
          runId={run.id}
          history={outcomes}
          unreviewed={unreviewed}
          open={openFindings}
        />
      )}

      {/*
        Issues come before content on purpose. An empty section or a table that
        extracted at low confidence is the single most useful thing this page
        can tell a reviewer, and burying it under an outline is how a document
        with a hole in it gets treated as complete.
      */}
      {document.issues.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-3 font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
            Review
          </h2>
          <ul className="space-y-2">
            {[...high, ...other].map((issue) => (
              <li
                key={issue.id}
                className={cn(
                  "flex gap-3 rounded-xl border px-4 py-3",
                  issue.severity === "high"
                    ? "border-amber-400/25 bg-amber-400/[0.05]"
                    : "border-white/[0.09] bg-white/[0.02]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 shrink-0",
                    issue.severity === "high" ? "text-amber-300/85" : "text-white/30",
                  )}
                >
                  {issue.severity === "high" ? <AlertTriangle size={15} /> : <Info size={15} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] leading-relaxed text-white/80">
                    {issue.detail}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-white/30">
                    {issue.kind.replace(/_/g, " ")}
                    {issue.page != null && ` · page ${issue.page}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Figures figures={figureViews} />

      <section>
        <h2 className="mb-3 font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
          Structure
        </h2>

        {document.sections.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/[0.015] px-5 py-8 text-center text-[13.5px] text-white/40">
            {isTerminal(document.status)
              ? "No sections were detected in this document."
              : "Still reading the document…"}
          </p>
        ) : (
          /*
            A tree, not a stack of cards. Thirty sections rendered as identical
            full-width bars gives no sense of depth and no way to skim — the
            hierarchy is the most useful thing this outline carries, so it is
            drawn: parents sit at the margin with weight, children hang off a
            rule, and only the counts that exist are shown.
          */
          <ol className="border-t border-white/[0.07]">
            {document.sections.map((section) => {
              const child = section.depth > 1;
              return (
                <li key={section.id}>
                  <div
                    style={{ paddingLeft: `${Math.min(section.depth - 1, 3) * 22}px` }}
                    className={cn(
                      "border-b border-white/[0.05]",
                      section.isEmpty && "bg-amber-400/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-baseline gap-3 py-2",
                        child && "border-l border-white/[0.09] pl-3",
                      )}
                    >
                      {section.numberText && (
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[11px] tabular-nums",
                            child ? "text-white/25" : "text-white/40",
                          )}
                        >
                          {section.numberText}
                        </span>
                      )}
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          child
                            ? "text-[13px] text-white/65"
                            : "text-[13.5px] font-medium text-white/90",
                        )}
                      >
                        {section.title}
                      </span>

                      <span className="flex shrink-0 items-center gap-3 text-[11.5px] text-white/30">
                        {section.clauses.length > 0 && (
                          <span className="text-white/45">
                            {section.clauses.length}{" "}
                            {section.clauses.length === 1 ? "clause" : "clauses"}
                          </span>
                        )}
                        {section.tables.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Table2 size={11} />
                            {section.tables.length}
                          </span>
                        )}
                        {section.figures.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <ImageIcon size={11} />
                            {section.figures.length}
                          </span>
                        )}
                        {section.isEmpty && (
                          <span className="text-amber-300/80">empty in source</span>
                        )}
                        {section.pageStart != null && (
                          <span className="w-7 text-right tabular-nums text-white/20">
                            p{section.pageStart}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>


    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/[0.09] bg-white/[0.02] px-4 py-3">
      <dt className="text-[11.5px] uppercase tracking-[0.1em] text-white/35">{label}</dt>
      <dd className="mt-1 font-display text-[22px] font-semibold tracking-[-0.02em] text-white">
        {value}
      </dd>
    </div>
  );
}
