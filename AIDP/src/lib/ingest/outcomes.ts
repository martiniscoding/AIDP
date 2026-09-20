import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { VERDICTS } from "./verdicts";
import {
  OUTCOME_META,
  isOutcome,
  type Outcome,
  type OutcomeSnapshot,
} from "./outcomes-vocabulary";

/**
 * What was decided about a submission.
 *
 * The assessment says whether a design meets the standard. This says what
 * happens next — and it is the row a governance audit actually asks for: who
 * accepted this design, when, and on what basis.
 *
 * Append-only, for the same reason decisions are never edited in place. An
 * escalation is followed by the board's own ruling, a revised design comes back
 * as a new run, and a report that said "approved" in March has to keep saying
 * so. The newest row for a run is the current position; the older ones are the
 * history, and both are shown.
 */

export type OutcomeView = {
  id: string;
  decision: Outcome;
  note: string;
  decidedByName: string;
  createdAt: Date;
  snapshot: OutcomeSnapshot | null;
};

const SELECT = {
  id: true,
  decision: true,
  note: true,
  decidedByName: true,
  createdAt: true,
  snapshot: true,
} as const;

type Row = {
  id: string;
  decision: string;
  note: string;
  decidedByName: string;
  createdAt: Date;
  snapshot: unknown;
};

function toView(row: Row): OutcomeView | null {
  // A decision word we no longer recognise is dropped rather than coerced: the
  // alternative is showing a governance record that says something nobody chose.
  if (!isOutcome(row.decision)) return null;
  const snapshot = row.snapshot;
  return {
    id: row.id,
    decision: row.decision,
    note: row.note,
    decidedByName: row.decidedByName,
    createdAt: row.createdAt,
    snapshot:
      snapshot && typeof snapshot === "object"
        ? (snapshot as OutcomeSnapshot)
        : null,
  };
}

/** Every decision taken on this run, newest first. */
export async function historyForRun(runId: string): Promise<OutcomeView[]> {
  const rows = await prisma.submissionOutcome.findMany({
    where: { runId },
    select: SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView).filter((row): row is OutcomeView => row !== null);
}

/**
 * The report as it stands right now, frozen into the decision.
 *
 * Findings stay editable after a decision is taken, so without this the record
 * would drift: a run approved with three contradictions outstanding would later
 * read as though it had been clean. `unreviewed` is captured for the same
 * reason — approving a report nobody has worked through is a legitimate choice,
 * and one an audit should be able to see was made.
 */
async function snapshotOf(runId: string): Promise<OutcomeSnapshot> {
  // What the report showed, which no longer includes a clause the design is
  // silent on — see the "Absent" section in ../../app/dashboard/documents/[id].
  const findings = await prisma.finding.findMany({
    where: { runId, verdict: { not: "absent" } },
    select: { verdict: true, reviewerState: true },
  });

  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v as string, 0])) as Record<
    string,
    number
  >;
  let unreviewed = 0;
  for (const finding of findings) {
    if (finding.verdict in verdicts) verdicts[finding.verdict] += 1;
    if (finding.reviewerState === "pending") unreviewed += 1;
  }
  return { verdicts, unreviewed, total: findings.length };
}

export class OutcomeRefused extends Error {}

/**
 * Record a decision on a completed run.
 *
 * Deliberately does *not* block an approval that leaves findings unreviewed or
 * contradictions outstanding. Every guard elsewhere in this system constrains
 * the machine, because a model has no standing to overrule evidence. This is
 * the opposite case: the architect is the authority on their own governance,
 * and a tool that refuses their decision would simply be worked around. What it
 * does instead is record exactly what was outstanding at the moment they
 * decided, so the choice is visible rather than prevented.
 */
export async function record(
  userId: string,
  runId: string,
  decision: Outcome,
  note: string,
  decidedByName: string,
): Promise<OutcomeView> {
  const run = await prisma.assessmentRun.findUnique({
    where: { id: runId },
    select: { id: true, organisationId: true, documentId: true, state: true },
  });
  if (!run) throw new OutcomeRefused("That assessment no longer exists.");
  await requireMembership(userId, run.organisationId);

  if (run.state !== "complete") {
    throw new OutcomeRefused(
      "This assessment has not finished. Wait for it to complete before deciding on it.",
    );
  }

  const trimmed = note.trim();
  if (OUTCOME_META[decision].requiresNote && !trimmed) {
    throw new OutcomeRefused(
      decision === "revise"
        ? "Say what has to change. A revision request with no stated basis is not an instruction."
        : "Say why this is going to the board. A board asked to rule needs the question.",
    );
  }

  const created = await prisma.submissionOutcome.create({
    data: {
      organisationId: run.organisationId,
      runId: run.id,
      documentId: run.documentId,
      decision,
      note: trimmed,
      snapshot: await snapshotOf(run.id),
      decidedById: userId,
      decidedByName,
    },
    select: SELECT,
  });

  const view = toView(created);
  if (!view) throw new OutcomeRefused("Could not record that decision.");
  return view;
}
