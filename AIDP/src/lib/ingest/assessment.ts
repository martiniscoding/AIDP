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
  /**
   * Standards in the library this framework does NOT measure against, and why.
   *
   * Carried so a screen can say so. A framework silently skipping half the
   * library is the difference between "the engine is broken" and "two of your
   * standards have not finished parsing", and only one of those is actionable.
   */
  excluded: { id: string; title: string; reason: "processing" | "failed" | "no-clauses" }[];
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

  /**
   * The standards in the library that this framework will NOT measure against,
   * and why.
   *
   * A framework is built from reference documents that reached `ready`.
   * Everything else — still parsing, failed, or parsed into no clauses at all —
   * was dropped here silently, and nothing downstream could tell. So somebody
   * who had uploaded four standards and watched one of them fail was assessed
   * against the other three, or against one, and the only clue was a clause
   * count that looked too low. That is indistinguishable from the engine being
   * broken, which is exactly how it was read.
   *
   * Reported rather than fixed: a standard that failed to parse genuinely
   * cannot be assessed against, and blocking the run over it would be worse
   * than running what is ready and saying what is not.
   */
  const excluded = await prisma.document.findMany({
    where: {
      organisationId,
      role: "reference",
      OR: [
        { status: { not: "ready" } },
        // Ready, but contributes nothing: the parse found no rules in it, so
        // the document looks healthy in the library and measures nothing.
        // Clauses hang off sections, so this asks whether any section of it
        // holds one.
        { sections: { none: { clauses: { some: {} } } } },
      ],
    },
    select: { id: true, title: true, status: true },
    orderBy: { title: "asc" },
  });

  // Not a superseded one. A version whose standards have been removed from the
  // library cannot be assessed against again, and its membership rows no longer
  // describe what it covered — see `supersedeFrameworksFor`.
  const latest = await prisma.framework.findFirst({
    where: { organisationId, isBaseline: false, supersededAt: null },
    orderBy: { version: "desc" },
    include: { documents: { select: { documentId: true } } },
  });

  const wanted = ready.map((d) => d.id).sort();
  const current = (latest?.documents ?? []).map((d) => d.documentId).sort();
  const unchanged =
    latest && wanted.length === current.length && wanted.every((id, i) => id === current[i]);

  // Counted over every version ever cut, superseded ones included: they keep
  // their number, the unique constraint still holds them, and a retired v1
  // must not be followed by a second v1.
  const highest = unchanged
    ? null
    : await prisma.framework.findFirst({
        where: { organisationId, isBaseline: false },
        orderBy: { version: "desc" },
        select: { version: true },
      });

  const framework =
    unchanged && latest
      ? latest
      : await prisma.framework.create({
          data: {
            organisationId,
            name: "Standards",
            version: (highest?.version ?? 0) + 1,
            documents: {
              create: ready.map((doc, index) => ({ documentId: doc.id, sortOrder: index })),
            },
          },
          include: { documents: { select: { documentId: true } } },
        });

  const clauseCount = await countClauses(framework.id);
  const readyIds = new Set(ready.map((d) => d.id));
  return {
    id: framework.id,
    name: framework.name,
    version: framework.version,
    documentCount: framework.documents.length,
    clauseCount,
    excluded: excluded.map((doc) => ({
      id: doc.id,
      title: doc.title,
      // A document that is ready and still in this list is one the parse found
      // no rules in — the case that looks healthiest and measures least.
      reason:
        doc.status === "failed"
          ? ("failed" as const)
          : readyIds.has(doc.id)
            ? ("no-clauses" as const)
            : ("processing" as const),
    })),
  };
}

/**
 * Retire every framework version that counted this document as one of its own.
 *
 * Called when a reference document is removed from the library. The membership
 * rows cascade away with it, so a version that covered five standards would
 * silently come to describe four and still carry the same id — the runs pinned
 * to it say they measured against five. Marking it superseded leaves it
 * readable and stops it being reused, and the next assessment cuts a fresh
 * version from what is actually in the library.
 *
 * Returns how many versions were retired, which is zero for a document no
 * assessment ever measured against.
 */
export async function supersedeFrameworksFor(documentId: string): Promise<number> {
  const members = await prisma.frameworkDocument.findMany({
    where: { documentId },
    select: { frameworkId: true },
  });
  if (members.length === 0) return 0;
  const done = await prisma.framework.updateMany({
    where: { id: { in: members.map((m) => m.frameworkId) }, supersededAt: null },
    data: { supersededAt: new Date() },
  });
  return done.count;
}

/**
 * What a run is measuring against, in one phrase.
 *
 * Shared by the design and project paths so they cannot word it differently,
 * and written to make a thin framework obvious rather than grammatical. The
 * screen that prompted this read "Assessing 2 designs against 1 clauses from
 * Standards v3" — a plural that gave the sentence away as generated, and a
 * number nobody could act on because nothing said how many standards those
 * clauses came from. A reviewer seeing "1 clause from 3 standards" knows
 * immediately that something is wrong with the standards, which is the whole
 * job of the line.
 */
export function describeScope(framework: FrameworkSummary): string {
  const clauses = `${framework.clauseCount} clause${framework.clauseCount === 1 ? "" : "s"}`;
  const from =
    framework.documentCount === 1
      ? "1 standard"
      : `${framework.documentCount} standards`;
  const scope = `${clauses} from ${from} (${framework.name} v${framework.version})`;

  // What is missing, named. A reader who uploaded four standards and is being
  // measured against one needs to know which three are not in it, and that the
  // reason is in their library rather than in the engine.
  if (framework.excluded.length === 0) return scope;
  const titles = framework.excluded
    .slice(0, 3)
    .map((doc) => {
      const why =
        doc.reason === "failed"
          ? "failed to parse"
          : doc.reason === "no-clauses"
            ? "no rules found in it"
            : "still processing";
      return `${doc.title} (${why})`;
    })
    .join(", ");
  const more = framework.excluded.length > 3 ? `, and ${framework.excluded.length - 3} more` : "";
  return `${scope}. Not measured against: ${titles}${more}.`;
}

export async function countClauses(frameworkId: string): Promise<number> {
  return prisma.clause.count({
    where: {
      // The live version only, to match what the worker will actually judge —
      // see `_framework_clauses`. Counting superseded clauses here would put a
      // `totalClauses` on the run that the progress bar could never reach.
      supersededById: null,
      section: {
        document: { frameworks: { some: { frameworkId } } },
      },
    },
  });
}

/**
 * Where to find a run's analyse job.
 *
 * A design run's jobs are its document's. A project run's have no document at
 * all — they are about every design in the project — and are identified by the
 * run id on their payload. Scoping one by `documentId: null` would match every
 * project's jobs in the workspace at once, which is why this is a function and
 * not a spread-in object.
 */
export function runJobWhere(run: { id: string; documentId: string | null }) {
  return run.documentId
    ? { documentId: run.documentId, stage: "analyse" }
    : { stage: "analyse", payload: { path: ["runId"], equals: run.id } };
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

  const findings = await prisma.finding.findMany({
    where: { runId },
    include: { document: { select: { title: true } } },
  });
  const rank = new Map(VERDICTS.map((v, i) => [v as string, i]));
  return findings.sort(
    (a, b) =>
      (rank.get(a.verdict) ?? 99) - (rank.get(b.verdict) ?? 99) ||
      b.confidence - a.confidence,
  );
}

