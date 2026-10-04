import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileStack } from "lucide-react";
import { auth } from "@/lib/auth";
import { readCoverage } from "@/lib/ingest/coverage";
import { readAdvice } from "@/lib/ingest/advice";
import { readLifecycle } from "@/lib/ingest/lifecycle";
import { listFindings, verdictCounts } from "@/lib/ingest/assessment";
import { emptyCounts, readEvidence, type VerdictCounts } from "@/lib/ingest/verdicts";
import { readAppliedDecisions } from "@/lib/ingest/decision-effects";
import { countActive, promotedFrom } from "@/lib/ingest/decisions";
import { historyForRun } from "@/lib/ingest/outcomes";
import { requireWorkspace } from "@/lib/access/gate";
import { assessableDesigns, getProject, latestProjectRun } from "@/lib/ingest/projects";
import { Assessment, type FindingView, type RunView } from "../../../documents/[id]/Assessment";
import { Decide, type OutcomeView } from "../../../documents/[id]/Decide";
import { PipelineWatcher } from "../../../documents/PipelineWatcher";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const access = await requireWorkspace();
  const project = await getProject(access.organisation.id, (await params).id);
  return { title: project ? `${project.name} — assessment` : "Assessment" };
}

/**
 * The project, assessed as one piece of work.
 *
 * A solution is described across several documents, and judged one at a time
 * the answers in the second were reported as gaps in the first. This is the
 * same report a design gets, over every design in the project at once: one
 * verdict per clause, and every quote naming the design it came from.
 */
export default async function ProjectAssessmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const access = await requireWorkspace();
  const { id } = await params;

  const project = await getProject(access.organisation.id, id);
  if (!project) notFound();

  const run = await latestProjectRun(access.organisation.id, id);
  const designs = await assessableDesigns(access.organisation.id, id);
  const ready = designs.filter((design) => design.status === "ready");

  // A clause the designs say nothing about is not reported as a finding; the
  // reverse question — the parts no clause governs — is run.coverage.
  const findings = run
    ? (await listFindings(session.user.id, run.id)).filter((f) => f.verdict !== "absent")
    : [];
  const counts: VerdictCounts = run ? await verdictCounts(run.id) : emptyCounts();
  const promoted = await promotedFrom(
    access.organisation.id,
    findings.map((f) => f.id),
  );

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

  const decisionsInForce = await countActive(access.organisation.id);
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

  const live = run?.state === "queued" || run?.state === "running";

  return (
    <>
      {/* Keeps the page current while a worker is on it; without it the progress
          bar sat where it was until somebody reloaded. */}
      <PipelineWatcher active={live === true && !run?.orphaned} />

      <Link
        href={`/dashboard/projects/${project.id}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink/58 transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} />
        {project.name}
      </Link>

      <div className="mb-7">
        <h1 className="font-display text-[25px] font-semibold tracking-[-0.02em] text-ink">
          {project.name}
        </h1>
        <p className="mt-2 text-[13px] text-ink/64">
          Every design in this project, measured against the standards together.
        </p>

        {ready.length > 0 && (
          <ul className="mt-3.5 flex flex-wrap gap-2">
            {ready.map((design) => (
              <li key={design.id}>
                <Link
                  href={`/dashboard/documents/${design.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12px] text-ink/78 transition-colors hover:border-royal/40 hover:text-ink"
                >
                  <FileStack size={12} className="text-ink/45" />
                  {design.title}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Said here as well as in the run's own note: somebody opening the
            report before the run finishes has no note to read yet. */}
        {designs.length > ready.length && (
          <p className="mt-3 text-[12px] text-warn">
            {designs.length - ready.length} design
            {designs.length - ready.length === 1 ? " is" : "s are"} still being processed and will
            not be included until you assess the project again.
          </p>
        )}
      </div>

      <Assessment
        scope={{ kind: "project", projectId: project.id }}
        run={runView}
        counts={counts}
        findings={findingViews}
        decisionsInForce={decisionsInForce}
      />

      {/* After the findings: the decision is the conclusion drawn from them, and
          offering it above the evidence invites one taken without reading any. */}
      {run && run.state === "complete" && (
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
