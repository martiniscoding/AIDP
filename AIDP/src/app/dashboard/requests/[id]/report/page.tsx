import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  Download,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/access/gate";
import { getRequestDraft } from "@/lib/ingest/requests";
import { resultsFor } from "@/lib/significance/record";
import { listFindings } from "@/lib/ingest/assessment";
import { CATEGORY_LABEL, readAdvice } from "@/lib/ingest/advice";
import { readLifecycle } from "@/lib/ingest/lifecycle";
import { buildRisk } from "@/lib/ingest/risk";
import { nextStep } from "@/lib/ingest/next-step";
import {
  BRIEF_SEVERITY_LABEL,
  briefSeverityOf,
  readObligation,
  type BriefSeverity,
} from "@/lib/ingest/verdicts";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/PageHeader";
import { RiskPanel } from "./RiskPanel";

export const dynamic = "force-dynamic";

/**
 * One report: how big this change is, what it breaks, and what happens next.
 *
 * The brief's Step 4 — "assembles the significance classification, compliance
 * scorecard, severity-ranked issues, risk matrix, and recommendations into one
 * report". Until this existed the first two lived on different screens and a
 * reviewer did the joining in their head.
 *
 * Nothing here is new analysis. Every number was worked out during the run or
 * by the criteria check and is read back; the only thing this page computes is
 * the sentence saying which of the brief's routes the submission takes, and it
 * states that rule rather than acting on it. Recording an outcome is still a
 * person pressing a button.
 */
const TONE: Record<BriefSeverity, string> = {
  critical: "border-danger-line bg-danger-tint text-danger",
  high: "border-warn-line bg-warn-tint text-warn",
  medium: "border-warn-line bg-warn-tint text-warn",
  low: "border-line bg-canvas-sunk text-ink/70",
};

const ROUTE_TONE = {
  auto_approve: "border-ok-line bg-ok-tint",
  architect: "border-warn-line bg-warn-tint",
  board: "border-danger-line bg-danger-tint",
} as const;

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, organisation } = await requireWorkspace();

  const request = await getRequestDraft(organisation.id, id);
  if (!request) notFound();

  // No run yet means no report. Said plainly rather than drawn as an empty one.
  if (!request.runId) {
    return (
      <>
        <Back id={id} />
        <PageHeader eyebrow={request.reference} title="Review report" />
        <p className="rounded-xl border border-line bg-card px-4 py-4 text-[13px] text-ink/75">
          {request.state === "draft"
            ? "This request has not been submitted yet."
            : "The review has not started yet. The report appears as soon as the submission has been read."}
        </p>
      </>
    );
  }

  // `listFindings` takes the *user*, not the organisation: it checks membership
  // itself before it reads a finding. Nothing is caught around it — a failure
  // here means the caller is not entitled to these findings, and the page
  // should fail rather than quietly draw a report with none, which reads as a
  // clean submission.
  const [run, findings, criteria] = await Promise.all([
    prisma.assessmentRun.findFirst({
      where: { id: request.runId, organisationId: organisation.id },
    }),
    listFindings(user.id, request.runId),
    request.significance ? resultsFor(request.id) : Promise.resolve([]),
  ]);
  if (!run) notFound();

  // Graded once, here, and read from this everywhere below — so the scorecard,
  // the risk view and the route cannot disagree about what a finding is worth.
  const graded = findings.map((finding) => ({
    finding,
    grade: briefSeverityOf(finding.verdict, readObligation(finding.obligation)),
  }));

  const counts: Record<BriefSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let unsettled = 0;
  for (const { grade } of graded) {
    if (!grade) continue;
    counts[grade.tier] += 1;
    if (!grade.settled) unsettled += 1;
  }
  const settledCovered = findings.length - graded.filter(({ grade }) => grade).length;
  const unreviewed = findings.filter((f) => f.reviewerState === "pending").length;

  const advice = readAdvice(run.advice);

  // The handful an experienced reviewer would raise first. The full set lives
  // on the findings screen, where each one sits beside the passage it quotes;
  // what the report needs is the shape of them, so somebody reading it in a
  // board pack knows what they are being asked to weigh.
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
  const recommendations = [...(advice?.suggestions ?? [])]
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3),
    )
    .slice(0, 5);

  const risk = buildRisk(
    findings.map((f) => ({
      clauseRef: f.clauseRef,
      verdict: f.verdict,
      obligation: f.obligation,
    })),
    advice,
    readLifecycle(run.lifecycle),
  );

  const step = nextStep({
    significance: request.significance,
    counts,
    unsettled,
    unreviewed,
  });

  const triggered = criteria.filter((result) => result.triggered);
  const worst = graded
    .filter(({ grade }) => grade?.tier === "critical" || grade?.tier === "high")
    .slice(0, 1)[0];

  const RouteIcon =
    step.route === "auto_approve" ? CircleCheck : step.route === "board" ? ArrowUpRight : UserCheck;

  return (
    <>
      <Back id={id} />
      <PageHeader
        eyebrow={`${request.reference} · Review report`}
        title={request.title || "Untitled request"}
        lede="The significance check and the standards review, together, and what the brief says happens next."
      />

      {/* The two answers, side by side. This pairing is the whole point of the
          page: neither half decides anything on its own. */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <section
          className={`rounded-xl border px-4 py-3 ${
            request.significance === "significant"
              ? "border-warn-line bg-warn-tint"
              : request.significance
                ? "border-ok-line bg-ok-tint"
                : "border-line bg-card"
          }`}
        >
          <div className="flex items-center gap-1.5">
            {request.significance === "significant" ? (
              <ShieldAlert size={14} className="text-warn" aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} className={request.significance ? "text-ok" : "text-ink/40"} aria-hidden="true" />
            )}
            <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink/70">
              Significance
            </h2>
          </div>
          <p className="mt-1 text-[14px] font-medium text-ink">
            {request.significance === "significant"
              ? "Architecturally significant"
              : request.significance
                ? "Not architecturally significant"
                : "Not determined"}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink/70">
            {request.significance
              ? `${triggered.length} of ${criteria.length} categories triggered.`
              : "This was not filed as an architecture request, so there are no intake answers to check the criteria against."}
          </p>
          {triggered.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {triggered.map((result) => (
                <li key={result.id} className="text-[12px] text-ink/75">
                  {result.categoryLabel}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-line bg-card px-4 py-3">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink/70">
            Compliance
          </h2>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {(["critical", "high", "medium", "low"] as const).map((tier) =>
              counts[tier] > 0 ? (
                <li
                  key={tier}
                  className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${TONE[tier]}`}
                >
                  {counts[tier]} {BRIEF_SEVERITY_LABEL[tier]}
                </li>
              ) : null,
            )}
            {settledCovered > 0 && (
              <li className="rounded-full border border-ok-line bg-ok-tint px-2.5 py-0.5 text-[11.5px] text-ok">
                {settledCovered} covered
              </li>
            )}
          </ul>
          {worst?.grade && (
            <p className="mt-2 text-[12.5px] text-ink/75">
              Highest: <span className="font-medium">{worst.finding.clauseRef}</span> —{" "}
              {worst.finding.clauseTitle}
            </p>
          )}
          {unsettled > 0 && (
            <p className="mt-1 text-[12px] text-ink/60">
              {unsettled} could not be graded from the document.
            </p>
          )}
        </section>
      </div>

      {/* What the brief says happens now. Stated, not done — recording an
          outcome is still somebody's decision. */}
      <section className={`mb-4 rounded-xl border px-4 py-3 ${ROUTE_TONE[step.route]}`}>
        <div className="flex gap-2">
          <RouteIcon size={15} className="mt-0.5 shrink-0 text-ink/70" aria-hidden="true" />
          <div>
            <p className="text-[13.5px] font-medium text-ink">{step.headline}</p>
            <p className="mt-0.5 text-[12.5px] text-ink/75">{step.because}</p>
          </div>
        </div>
      </section>

      <div className="mb-4">
        <RiskPanel risk={risk} />
      </div>

      {recommendations.length > 0 && (
        <section className="mb-4 rounded-xl border border-line bg-card">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[13.5px] font-medium text-ink">Recommendations</h2>
            <p className="mt-0.5 text-[12px] text-ink/60">
              What a reviewer would still ask of the design, beyond the standards. Advice,
              never a verdict
              {(advice?.suggestions.length ?? 0) > recommendations.length &&
                ` — ${recommendations.length} of ${advice?.suggestions.length} shown`}
              .
            </p>
          </div>
          <ul className="divide-y divide-line">
            {recommendations.map((suggestion, index) => (
              <li key={index} className="px-4 py-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px]",
                      suggestion.priority === "high"
                        ? "border-warn-line bg-warn-tint text-warn"
                        : "border-line text-ink/60",
                    )}
                  >
                    {CATEGORY_LABEL[suggestion.category]}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink">{suggestion.title}</p>
                    {suggestion.component && (
                      <p className="mt-0.5 text-[12px] text-ink/55">{suggestion.component}</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/dashboard/projects/${request.projectId}/assessment`}
          className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[13px] font-medium text-white"
        >
          Work the findings
        </Link>
        <a
          href={`/dashboard/requests/${request.id}/report/export`}
          className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[13px] text-ink/80 hover:text-ink"
        >
          <Download size={14} aria-hidden="true" />
          Download the report
        </a>
        {request.documentId && (
          <Link
            href={`/dashboard/documents/${request.documentId}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[13px] text-ink/80 hover:text-ink"
          >
            What was submitted
          </Link>
        )}
      </div>
    </>
  );
}

function Back({ id }: { id: string }) {
  return (
    <Link
      href={`/dashboard/requests/${id}`}
      className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink/60 hover:text-ink"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      Back to the request
    </Link>
  );
}
