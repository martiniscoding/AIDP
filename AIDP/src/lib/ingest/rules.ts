import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { LABEL_ORDER, OBLIGATION } from "./rules-vocabulary";

/**
 * What a model set aside when it read a standard's rules.
 *
 * The worker has the model account for every line of a standard: a line is
 * either inside a rule or in a labelled range with a reason. The rules are on
 * the page already, as clauses. This is the other half — everything the model
 * decided was not a rule — because a rule wrongly set aside is never assessed
 * against anything, and the only place that mistake can be caught is here.
 */

export type SetAsideLine = { ref: string; text: string; page: number | null };

export type SetAsideRange = {
  id: string;
  label: string;
  reason: string;
  lines: SetAsideLine[];
  /** Some line in the range reads like an obligation. These are shown first. */
  obligation: boolean;
  restoredAt: string | null;
  restoredBy: string | null;
};

export type SetAsideView = {
  model: string;
  readAt: string;
  ranges: SetAsideRange[];
};

export async function setAside(
  userId: string,
  documentId: string,
): Promise<SetAsideView | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { organisationId: true, role: true },
  });
  if (!document || document.role !== "reference") return null;
  await requireMembership(userId, document.organisationId);

  const extraction = await prisma.ruleExtraction.findFirst({
    where: { documentId, adopted: true },
    orderBy: { attempt: "asc" },
    select: { id: true, model: true, createdAt: true },
  });
  if (!extraction) return null;

  const [labels, lines, clauses] = await Promise.all([
    prisma.lineLabel.findMany({
      where: { extractionId: extraction.id },
      orderBy: { fromOrdinal: "asc" },
    }),
    prisma.sourceLine.findMany({
      where: { documentId },
      orderBy: { ordinal: "asc" },
      select: { ordinal: true, ref: true, text: true, page: true },
    }),
    prisma.clause.findMany({
      where: { section: { documentId }, origin: "model" },
      select: { sourceRefs: true },
    }),
  ]);

  // A line inside a rule is never shown as set aside, even when a label's
  // range overlaps it. The worker resolves overlaps the same way.
  const ordinalOf = new Map(lines.map((line) => [line.ref, line.ordinal]));
  const ruled = new Set<number>();
  for (const clause of clauses) {
    const span = (clause.sourceRefs as { span?: unknown } | null)?.span;
    if (!Array.isArray(span) || span.length !== 2) continue;
    const from = ordinalOf.get(String(span[0]));
    const to = ordinalOf.get(String(span[1]));
    if (from === undefined || to === undefined) continue;
    for (let n = from; n <= to; n++) ruled.add(n);
  }

  const ranges: SetAsideRange[] = labels
    .map((label) => {
      const within = lines.filter(
        (line) =>
          line.ordinal >= label.fromOrdinal &&
          line.ordinal <= label.toOrdinal &&
          !ruled.has(line.ordinal),
      );
      return {
        id: label.id,
        label: label.label,
        reason: label.reason,
        lines: within.map(({ ref, text, page }) => ({ ref, text, page })),
        obligation: within.some((line) => OBLIGATION.test(line.text)),
        restoredAt: label.restoredAt?.toISOString() ?? null,
        restoredBy: label.restoredBy,
      };
    })
    .filter((range) => range.lines.length > 0)
    // Labels arrive in document order and the sort is stable, so ranges of one
    // kind stay in the order they appear in the standard.
    .sort(
      (a, b) =>
        Number(b.obligation) - Number(a.obligation) || rank(a.label) - rank(b.label),
    );

  return { model: extraction.model, readAt: extraction.createdAt.toISOString(), ranges };
}

function rank(label: string): number {
  const index = (LABEL_ORDER as readonly string[]).indexOf(label);
  return index === -1 ? LABEL_ORDER.length : index;
}
