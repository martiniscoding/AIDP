import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { describeJob, JOB_SELECT } from "./pipeline";
import { emptyCounts, VERDICTS, type Verdict, type VerdictCounts } from "./verdicts";

// Re-exported so server callers have one import for the whole area; client
// components must import from ./verdicts directly, since this file reaches
// Prisma.
export { VERDICTS, VERDICT_META, readEvidence } from "./verdicts";
export type { Verdict, VerdictCounts, EvidenceItem } from "./verdicts";

/**
 * Frameworks, runs and findings.
 *
 * A framework is the set of reference documents an assessment measures against.
 * Runs pin the version they used, because a finding that says "breaches §3.2"
 * stops meaning anything once §3.2 has been rewritten — and these documents are
 * going to be rewritten, since three of the four the client sent are unfilled
 * templates.
 */

export type FrameworkSummary = {
  id: string;
  name: string;
  version: number;
  documentCount: number;
  clauseCount: number;
};

/**
 * The framework to assess against, creating or versioning it as needed.
 *
 * A new version is cut whenever the set of indexed reference documents changes,
 * rather than mutating the existing one. That keeps every past run
 * interpretable: its findings still refer to the framework as it stood when it
 * ran.
 */
export async function resolveFramework(organisationId: string): Promise<FrameworkSummary> {
  const ready = await prisma.document.findMany({
    where: { organisationId, role: "reference", status: "ready" },
    select: { id: true, title: true },
    orderBy: { title: "asc" },
  });

  const latest = await prisma.framework.findFirst({
    where: { organisationId, isBaseline: false },
    orderBy: { version: "desc" },
    include: { documents: { select: { documentId: true } } },
  });

  const wanted = ready.map((d) => d.id).sort();
  const current = (latest?.documents ?? []).map((d) => d.documentId).sort();
  const unchanged =
    latest && wanted.length === current.length && wanted.every((id, i) => id === current[i]);

  const framework =
    unchanged && latest
      ? latest
      : await prisma.framework.create({
          data: {
            organisationId,
            name: "Standards",
            version: (latest?.version ?? 0) + 1,
            documents: {
              create: ready.map((doc, index) => ({ documentId: doc.id, sortOrder: index })),
            },
          },
          include: { documents: { select: { documentId: true } } },
        });

  const clauseCount = await countClauses(framework.id);
  return {
    id: framework.id,
    name: framework.name,
    version: framework.version,
    documentCount: framework.documents.length,
    clauseCount,
  };
}

export async function countClauses(frameworkId: string): Promise<number> {
  return prisma.clause.count({
    where: {
      section: {
        document: { frameworks: { some: { frameworkId } } },
      },
    },
  });
}

export async function latestRun(userId: string, documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { organisationId: true },
  });
  if (!document) return null;
  await requireMembership(userId, document.organisationId);

  const run = await prisma.assessmentRun.findFirst({
    where: { documentId },
    orderBy: { startedAt: "desc" },
    include: {
      framework: { select: { name: true, version: true } },
      _count: { select: { findings: true } },
    },
  });
  if (!run) return null;

  const live = run.state === "queued" || run.state === "running";
  // The job says what the run row cannot: whether a worker has picked it up,
  // what it is doing before the first clause, and whether it is waiting to retry
  // or was dropped by a worker that died. A run's job is created with it, and
  // "Compare both" carries the next run on the same job, so a live run's job is
  // the document's newest analyse job.
  const row = live
    ? await prisma.job.findFirst({
        where: { documentId, stage: "analyse" },
        orderBy: { createdAt: "desc" },
        select: JOB_SELECT,
      })
    : null;

  // A run that says it is waiting, with no job for a worker to take, is not
  // waiting for anything. Its job was removed — re-processing a document used to
  // clear every job, analyse included — and nothing will ever start it, while
  // the page disabled every way of starting another.
  const orphaned = live && !(row && (row.state === "queued" || row.state === "leased"));
  return { ...run, orphaned, job: row && !orphaned ? describeJob(row) : null };
}

export async function verdictCounts(runId: string): Promise<VerdictCounts> {
  const rows = await prisma.finding.groupBy({
    by: ["verdict"],
    where: { runId },
    _count: { _all: true },
  });
  const counts = emptyCounts();
  for (const row of rows) {
    if ((VERDICTS as readonly string[]).includes(row.verdict)) {
      counts[row.verdict as Verdict] = row._count._all;
    }
  }
  return counts;
}

/**
 * Findings for a run, worst first.
 *
 * Ordered by verdict severity rather than by clause number: someone opening
 * this wants the contradictions and gaps, not §1.1 Purpose. Within a verdict,
 * the model's own confidence breaks the tie.
 */
export async function listFindings(userId: string, runId: string) {
  const run = await prisma.assessmentRun.findUnique({
    where: { id: runId },
    select: { organisationId: true },
  });
  if (!run) return [];
  await requireMembership(userId, run.organisationId);

  const findings = await prisma.finding.findMany({ where: { runId } });
  const rank = new Map(VERDICTS.map((v, i) => [v as string, i]));
  return findings.sort(
    (a, b) =>
      (rank.get(a.verdict) ?? 99) - (rank.get(b.verdict) ?? 99) ||
      b.confidence - a.confidence,
  );
}

