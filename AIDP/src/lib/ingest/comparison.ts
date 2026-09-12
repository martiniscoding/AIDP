import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { VERDICTS, readEvidence, type EvidenceItem } from "./verdicts";

/**
 * The same design assessed two ways, clause by clause.
 *
 * A search-mode run judges each clause on the passages a search found; a
 * document-mode run judges it on the whole document, quoted. Where the two
 * reach the same verdict there is little to learn. Where they differ, one of
 * them missed something, and that is the list worth reading — so it comes
 * first.
 */

export type ComparedFinding = {
  verdict: string;
  confidence: number;
  rationale: string;
  evidence: EvidenceItem[];
};

export type ComparisonRow = {
  clauseId: string;
  clauseRef: string;
  clauseTitle: string;
  search: ComparedFinding | null;
  whole: ComparedFinding | null;
  agree: boolean;
};

export type ComparedRun = {
  id: string;
  model: string | null;
  completedAt: string | null;
};

export type ComparisonView = {
  search: ComparedRun;
  whole: ComparedRun;
  rows: ComparisonRow[];
  agreed: number;
};

/**
 * The latest complete whole-document run beside the search run it is compared
 * with: the run it was started alongside when there is one, otherwise the
 * latest complete search run against the same framework. Null until both exist.
 */
export async function compareModes(
  userId: string,
  documentId: string,
): Promise<ComparisonView | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { organisationId: true },
  });
  if (!document) return null;
  await requireMembership(userId, document.organisationId);

  const whole = await prisma.assessmentRun.findFirst({
    where: { documentId, mode: "document", state: "complete" },
    orderBy: { startedAt: "desc" },
  });
  if (!whole) return null;

  const paired = whole.comparedWithId
    ? await prisma.assessmentRun.findFirst({
        where: { id: whole.comparedWithId, documentId, mode: "retrieval", state: "complete" },
      })
    : null;
  const search =
    paired ??
    (await prisma.assessmentRun.findFirst({
      where: {
        documentId,
        frameworkId: whole.frameworkId,
        mode: "retrieval",
        state: "complete",
      },
      orderBy: { startedAt: "desc" },
    }));
  if (!search) return null;

  const [searchFindings, wholeFindings] = await Promise.all([
    prisma.finding.findMany({ where: { runId: search.id } }),
    prisma.finding.findMany({ where: { runId: whole.id } }),
  ]);

  const view = (finding: (typeof searchFindings)[number]): ComparedFinding => ({
    verdict: finding.verdict,
    confidence: finding.confidence,
    rationale: finding.rationale,
    evidence: readEvidence(finding.evidence),
  });

  const rows = new Map<string, ComparisonRow>();
  for (const finding of searchFindings) {
    rows.set(finding.clauseId, {
      clauseId: finding.clauseId,
      clauseRef: finding.clauseRef,
      clauseTitle: finding.clauseTitle,
      search: view(finding),
      whole: null,
      agree: false,
    });
  }
  for (const finding of wholeFindings) {
    const row = rows.get(finding.clauseId) ?? {
      clauseId: finding.clauseId,
      clauseRef: finding.clauseRef,
      clauseTitle: finding.clauseTitle,
      search: null,
      whole: null,
      agree: false,
    };
    row.whole = view(finding);
    rows.set(finding.clauseId, row);
  }

  const rank = new Map(VERDICTS.map((verdict, index) => [verdict as string, index]));
  const ordered = [...rows.values()]
    .map((row) => ({
      ...row,
      agree: Boolean(row.search && row.whole && row.search.verdict === row.whole.verdict),
    }))
    .sort(
      (a, b) =>
        Number(a.agree) - Number(b.agree) ||
        (rank.get(a.whole?.verdict ?? "") ?? 99) - (rank.get(b.whole?.verdict ?? "") ?? 99) ||
        a.clauseRef.localeCompare(b.clauseRef),
    );

  const summary = (run: typeof whole): ComparedRun => ({
    id: run.id,
    model: run.model,
    completedAt: run.completedAt?.toISOString() ?? null,
  });

  return {
    search: summary(search),
    whole: summary(whole),
    rows: ordered,
    agreed: ordered.filter((row) => row.agree).length,
  };
}
