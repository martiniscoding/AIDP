import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink, ScrollText } from "lucide-react";
import { auth } from "@/lib/auth";
import { getDocument, isTerminal, STATUS_LABEL } from "@/lib/ingest/documents";
import { formatDuration } from "@/lib/ingest/pipeline";
import { readCoverage } from "@/lib/ingest/coverage";
import { readAdvice } from "@/lib/ingest/advice";
import { readLifecycle } from "@/lib/ingest/lifecycle";
import { latestRun, listFindings, verdictCounts } from "@/lib/ingest/assessment";
import { emptyCounts, readEvidence, type VerdictCounts } from "@/lib/ingest/verdicts";
import { readAppliedDecisions } from "@/lib/ingest/decision-effects";
import { countActive, promotedFrom } from "@/lib/ingest/decisions";
import { historyForRun } from "@/lib/ingest/outcomes";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { canManageStandards } from "@/lib/access/roles";
import { currentUser } from "@/lib/access/gate";
import { Assessment, type FindingView, type RunView } from "./Assessment";
import { Comparison } from "./Comparison";
import { compareModes } from "@/lib/ingest/comparison";
import { Understanding } from "./Understanding";
import { Decide, type OutcomeView } from "./Decide";
import { DocumentActions } from "../DocumentActions";
import { PipelineStatus } from "../PipelineStatus";
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

  // What the parse made of the document — its sections, tables, figures and the
  // notes the pipeline raised — is a page of its own; see ./parsed. The count of
  // things needing a look is worth carrying here, because a reader with no
  // reason to open that page still has to know there is one.
  const toReview = document.issues.filter((i) => i.severity === "high").length;

  // Only a submitted design gets assessed; a reference standard is what it is
  // assessed against.
  const assessed = document.role === "assessed";
  const run = assessed ? await latestRun(session.user.id, document.id) : null;
  // A clause the design says nothing about is no longer reported. The report's
  // "Absent" section is the reverse question — the parts of the design no clause
  // governs (run.coverage) — so these stay on record and out of the report.
  const findings = run
    ? (await listFindings(session.user.id, run.id)).filter((f) => f.verdict !== "absent")
    : [];
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
        mode: run.mode,
        note: run.note,
        orphaned: run.orphaned,
        job: run.job,
        coverage: readCoverage(run.coverage),
        advice: readAdvice(run.advice),
        lifecycle: readLifecycle(run.lifecycle),
      }
    : null;

  // Search and whole-document verdicts side by side. A design is assessed one
  // way now — searched, with anything that looks absent re-read against the whole
  // document — so this is a diagnostic for whoever tunes the system, kept for the
  // runs that were made both ways, and shown to the operator alone.
  const operator = await currentUser();
  const comparison =
    assessed && operator?.isPlatformAdmin
      ? await compareModes(session.user.id, document.id)
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
  const openFindings = findings.filter((f) => f.verdict === "contradicts").length;
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
          // A ready document can be working again: a corrected figure re-embeds.
          (document.pipeline.state !== "ready" && document.pipeline.state !== "failed") ||
          (!run?.orphaned && (run?.state === "queued" || run?.state === "running")) ||
          // A new set of suggestions asked for on a finished report.
          runView?.advice?.refreshing === true
        }
      />

      <Link
        href="/dashboard/documents"
        className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-ink/66 transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        Standards library
      </Link>

      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            {document.title}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-ink/64">
            <span className="text-ink/72">{STATUS_LABEL[document.status] ?? document.status}</span>
            {document.pipeline.state === "ready" && document.pipeline.tookMs !== null && (
              <span>Processed in {formatDuration(document.pipeline.tookMs)}</span>
            )}
            {document.docCode && <span>{document.docCode}</span>}
            {document.version && <span>{document.version}</span>}
            {document.pageCount != null && <span>{document.pageCount} pages</span>}
            {document.profile && <span>{document.profile}</span>}
            {document.sensitivity && (
              <span className="rounded border border-line px-1.5 py-0.5 text-ink/70">
                {document.sensitivity}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* A new tab, not this one: it is looked at beside a finding, to see
              what the finding was drawn from, and coming back to the report
              should not mean loading it again. */}
          <Link
            href={`/dashboard/documents/${document.id}/parsed`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-ink/78 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
          >
            <ScrollText size={13} aria-hidden="true" />
            Parsed content
            {toReview > 0 && (
              <span className="rounded-full border border-warn-line bg-warn-tint px-1.5 text-[11px] text-warn">
                {toReview}
              </span>
            )}
            <ExternalLink size={11} aria-hidden="true" className="text-ink/50" />
          </Link>

          {mayChange && (
            <DocumentActions documentId={document.id} title={document.title} redirectAfterDelete />
          )}
        </div>
      </header>

      {/* Until the document is in, where it has got to is the whole story. */}
      {document.pipeline.state !== "ready" && (
        <PipelineStatus view={document.pipeline} canRerun={mayChange} />
      )}

      {document.failureReason && document.pipeline.state !== "failed" && (
        <p className="mb-6 rounded-xl border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn">
          {document.failureReason}
        </p>
      )}

      {/* Before everything, because it is the premise the rest rests on: a
          reader who has not seen what the system took this document to be
          cannot tell whether its findings are answering the right question. */}
      <Understanding
        documentId={document.id}
        summary={document.summary}
        editable={mayChange}
        assessed={assessed}
      />

      {assessed && (
        <Assessment
          documentId={document.id}
          run={runView}
          counts={counts}
          findings={findingViews}
          decisionsInForce={decisionsInForce}
        />
      )}

      {comparison && <Comparison view={comparison} />}

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
    </>
  );
}
