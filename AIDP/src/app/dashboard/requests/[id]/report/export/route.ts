import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/access/gate";
import { requireMembership, NotAMember } from "@/lib/ingest/org";
import { getRequestDraft } from "@/lib/ingest/requests";
import { resultsFor } from "@/lib/significance/record";
import { listFindings } from "@/lib/ingest/assessment";
import { readAdvice } from "@/lib/ingest/advice";
import { readLifecycle } from "@/lib/ingest/lifecycle";
import { buildRisk } from "@/lib/ingest/risk";
import { nextStep } from "@/lib/ingest/next-step";
import {
  BRIEF_SEVERITY_LABEL,
  OBLIGATION_META,
  VERDICT_META,
  briefSeverityOf,
  readObligation,
  type BriefSeverity,
} from "@/lib/ingest/verdicts";

/**
 * The review report as a file, for a board pack or an email.
 *
 * The brief attaches the report to its notifications and to the ARB invitation,
 * so it has to leave the screen. A workbook rather than a PDF because the thing
 * people actually do with a finding list is sort and filter it, and because
 * `exceljs` is already here.
 *
 * Four sheets, each answering one of the questions the report answers:
 * what was decided, what was breached, where it is weak, and why it was
 * classified as it was. Nothing is recomputed — every number is read from the
 * same functions the page reads, so the file and the screen cannot disagree.
 *
 * Access is checked here in full. A route handler takes a direct GET and the
 * dashboard layout's guard does not run in front of one, so this repeats the
 * membership check rather than assuming it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEVERITY_ORDER: Record<BriefSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** A filename a person would recognise in their downloads, and that a mail
 *  client will not mangle. */
function fileName(reference: string, title: string): string {
  const clean = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${reference}${clean ? ` ${clean}` : ""} review report.xlsx`;
}

function header(sheet: ExcelJS.Worksheet, columns: [string, number][]): void {
  sheet.columns = columns.map(([name, width]) => ({ header: name, key: name, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const row = await prisma.architectureRequest.findUnique({
    where: { id },
    select: { organisationId: true },
  });
  // Not found rather than forbidden: a request in another customer is
  // indistinguishable from one that does not exist.
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await requireMembership(user.id, row.organisationId);
  } catch (error) {
    if (error instanceof NotAMember) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw error;
  }

  const request = await getRequestDraft(row.organisationId, id);
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!request.runId) {
    return NextResponse.json(
      { error: "this request has no report yet" },
      { status: 409 },
    );
  }

  const [run, findings, criteria] = await Promise.all([
    prisma.assessmentRun.findFirst({
      where: { id: request.runId, organisationId: row.organisationId },
    }),
    listFindings(user.id, request.runId),
    request.significance ? resultsFor(request.id) : Promise.resolve([]),
  ]);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

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
  const unreviewed = findings.filter((f) => f.reviewerState === "pending").length;

  const risk = buildRisk(
    findings.map((f) => ({
      clauseRef: f.clauseRef,
      verdict: f.verdict,
      obligation: f.obligation,
    })),
    readAdvice(run.advice),
    readLifecycle(run.lifecycle),
  );
  const step = nextStep({ significance: request.significance, counts, unsettled, unreviewed });

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  // --- 1. What was decided -------------------------------------------------
  const summary = workbook.addWorksheet("Summary");
  header(summary, [["Field", 34], ["Value", 90]]);
  const triggered = criteria.filter((result) => result.triggered);
  for (const [field, value] of [
    ["Reference", request.reference],
    ["Title", request.title],
    ["Raised by", request.requestedByName || "—"],
    ["Submitted", request.submittedAt ? request.submittedAt.toISOString().slice(0, 10) : "—"],
    ["Significance", request.significance
      ? request.significance === "significant"
        ? "Architecturally significant"
        : "Not architecturally significant"
      : "Not determined — no intake answers to check against"],
    ["Categories triggered", request.significance ? `${triggered.length} of ${criteria.length}` : "—"],
    ["Critical findings", String(counts.critical)],
    ["High findings", String(counts.high)],
    ["Medium findings", String(counts.medium)],
    ["Low findings", String(counts.low)],
    // Said in the file as on the screen: an unsettled grade is the engine
    // saying a person has to look, not that the impact is small.
    ["Could not be graded", String(unsettled)],
    ["Not yet reviewed", String(unreviewed)],
    ["Assessed against", `${run.model ?? "—"}, ${run.mode} mode`],
    ["What happens next", step.headline],
    ["Because", step.because],
  ] as [string, string][]) {
    summary.addRow({ Field: field, Value: value });
  }

  // --- 2. What was breached ------------------------------------------------
  const sheet = workbook.addWorksheet("Findings");
  header(sheet, [
    ["Clause", 18], ["Title", 40], ["Verdict", 16], ["Severity", 12],
    ["Settled", 10], ["Obligation", 14], ["Reviewed", 14], ["Rationale", 90],
  ]);
  const ordered = [...graded].sort((a, b) => {
    const left = a.grade ? SEVERITY_ORDER[a.grade.tier] : 9;
    const right = b.grade ? SEVERITY_ORDER[b.grade.tier] : 9;
    return left - right || a.finding.clauseRef.localeCompare(b.finding.clauseRef);
  });
  for (const { finding, grade } of ordered) {
    sheet.addRow({
      Clause: finding.clauseRef,
      Title: finding.clauseTitle,
      Verdict: VERDICT_META[finding.verdict as keyof typeof VERDICT_META]?.label ?? finding.verdict,
      Severity: grade ? BRIEF_SEVERITY_LABEL[grade.tier] : "—",
      // The column exists so "Low" is never read as "small" without the
      // qualifier the engine attached to it.
      Settled: grade ? (grade.settled ? "yes" : "no") : "—",
      Obligation:
        OBLIGATION_META[readObligation(finding.obligation)]?.label ??
        String(finding.obligation),
      Reviewed: finding.reviewerState,
      Rationale: finding.rationale,
    });
  }

  // --- 3. Where it is weak -------------------------------------------------
  const riskSheet = workbook.addWorksheet("Risk");
  header(riskSheet, [["Dimension", 28], ["Grade", 16], ["Suggestions", 14], ["Clauses", 50], ["Notes", 70]]);
  for (const dimension of risk.rows) {
    riskSheet.addRow({
      Dimension: dimension.label,
      // "Not assessed" and "Nothing raised" are different answers and the file
      // has to keep them apart, exactly as the screen does.
      Grade: !dimension.assessed
        ? "Not assessed"
        : dimension.severity
          ? BRIEF_SEVERITY_LABEL[dimension.severity]
          : "Nothing raised",
      Suggestions: dimension.suggestions,
      Clauses: dimension.clauses.map((clause) => clause.ref).join(", "),
      Notes: dimension.notes.join(" "),
    });
  }

  // --- 4. Why it was classified as it was ----------------------------------
  const criteriaSheet = workbook.addWorksheet("Significance");
  header(criteriaSheet, [["Category", 34], ["Triggered", 12], ["Rule as it stood", 70], ["Because", 70]]);
  if (criteria.length === 0) {
    criteriaSheet.addRow({
      Category: "Not checked",
      Triggered: "—",
      "Rule as it stood": "",
      Because: "This was not filed as an architecture request, so there are no intake answers to check the criteria against.",
    });
  }
  for (const result of criteria) {
    const why = (result.triggeredBy as { text?: string; actual?: string }[]) ?? [];
    criteriaSheet.addRow({
      Category: result.categoryLabel,
      Triggered: result.triggered ? "yes" : "no",
      // Denormalised on the row, so the file states the rule the classification
      // was actually reached under rather than whatever it says today.
      "Rule as it stood": result.conditionText,
      Because: why
        .map((entry) => (entry.actual ? `${entry.text} The request says ${entry.actual}.` : entry.text))
        .join(" "),
    });
  }

  const body = await workbook.xlsx.writeBuffer();
  return new NextResponse(body as ArrayBuffer, {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fileName(request.reference, request.title)}"`,
      // A report is a snapshot of rows that stay editable; a cached copy would
      // be a different report with the same name.
      "cache-control": "no-store",
    },
  });
}
