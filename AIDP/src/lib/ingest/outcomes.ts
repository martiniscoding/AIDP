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
 * The design in this run that the person deciding submitted themselves.
 *
 * Separation of duties, and the brief admits no exception to it: a requestor
 * never rules on their own submission, "even if they also hold an architect
 * role elsewhere in the organisation". So this is deliberately *not* a role
 * check and does not belong beside the ones in lib/access/roles.ts — an
 * administrator is as disqualified as anyone else here, because the conflict is
 * with the work rather than with the permission.
 *
 * A project run is judged against every design in it, so having submitted any
 * one of them is enough: the report the decision would rest on is in part a
 * report on their own work.
 *
 * The title is returned rather than a boolean so the refusal can name the
 * conflict, which across a project of nine designs is the only version of the
 * message anyone can act on.
 *
 * A null `uploadedById` cannot match a real user id, so a document from before
 * that column existed — or one whose author's account has since been deleted —
 * disqualifies nobody. That is the right direction to fail: the alternative is
 * a submission that no one in the organisation is permitted to decide.
 */
async function ownSubmission(
  userId: string,
  documentId: string | null,
  designIds: string[],
): Promise<string | null> {
  // Whichever the run was over. A single-design run carries its document; a
  // project run carries the ids it opened with, which is also the set the
  // worker judged — see AssessmentRun.designIds.
  const ids = documentId ? [documentId] : designIds;
  if (ids.length === 0) return null;
  const own = await prisma.document.findFirst({
    where: { id: { in: ids }, uploadedById: userId },
    select: { title: true },
  });
  return own?.title ?? null;
}

/**
 * How many findings in this report a refusal could be hung on.
 *
 * A breach the engine was able to quote: the design contradicting the standard,
 * or meeting it only in part, with evidence attached. `absent` is not one of
 * them, for the same reason it is not in the report at all — a clause the
 * design is silent on is a question for its author rather than a quotable
 * breach — and a verdict carrying an empty evidence array is one the report
 * itself downgrades.
 *
 * Counted rather than listed: the caller only needs to know whether the report
 * gives a rejection anything to stand on.
 */
async function citedBreaches(runId: string): Promise<number> {
  const findings = await prisma.finding.findMany({
    where: { runId, verdict: { in: ["contradicts", "partial"] } },
    select: { evidence: true },
  });
  return findings.filter(
    (finding) => Array.isArray(finding.evidence) && finding.evidence.length > 0,
  ).length;
}

/**
 * Why a missing reason is refused, in the terms of the decision being taken.
 *
 * One message per outcome rather than one generic line, because the thing the
 * reviewer has left out is different each time and a reviewer who is told
 * precisely what is missing writes it.
 */
const WITHOUT_A_REASON: Partial<Record<Outcome, string>> = {
  rejected:
    "Say why this design is refused. A rejection its author cannot answer is a dead end rather than a decision.",
  revise:
    "Say what has to change. A revision request with no stated basis is not an instruction.",
  escalated: "Say why this is going to the board. A board asked to rule needs the question.",
};

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
 *
 * The three things it does refuse are not judgements:
 *
 *   - an unfinished run, which has nothing to decide on yet;
 *   - a decision by the person who submitted the design, which is a question of
 *     *who* may rule rather than of what the ruling should be;
 *   - a rejection with no stated reason or no cited breach, which is a refusal
 *     the author cannot answer and an audit cannot defend.
 *
 * None of them second-guesses the verdict. They keep the record answerable,
 * which is the whole reason the record exists.
 *
 * All of it lives here rather than in the Server Action that calls it: an
 * action is a POST endpoint reachable by anyone who can send the request, so
 * a check that sits in front of a button is not a check at all.
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
    select: {
      id: true,
      organisationId: true,
      documentId: true,
      projectId: true,
      designIds: true,
      state: true,
    },
  });
  if (!run) throw new OutcomeRefused("That assessment no longer exists.");
  await requireMembership(userId, run.organisationId);

  const own = await ownSubmission(userId, run.documentId, run.designIds);
  if (own) {
    throw new OutcomeRefused(
      `You submitted “${own}”, so this decision is not yours to record. ` +
        "A colleague has to take it — nobody rules on their own submission.",
    );
  }

  if (run.state !== "complete") {
    throw new OutcomeRefused(
      "This assessment has not finished. Wait for it to complete before deciding on it.",
    );
  }

  const trimmed = note.trim();
  if (OUTCOME_META[decision].requiresNote && !trimmed) {
    throw new OutcomeRefused(
      WITHOUT_A_REASON[decision] ??
        "Say why. A decision with no stated basis is not one a reader can act on.",
    );
  }

  if (OUTCOME_META[decision].requiresFinding && (await citedBreaches(run.id)) === 0) {
    throw new OutcomeRefused(
      "This report cites no breach to reject the design on. Where the findings do not " +
        "carry the refusal, the case for it belongs to the board — escalate instead, and " +
        "say what you are asking them to rule on.",
    );
  }

  const created = await prisma.submissionOutcome.create({
    data: {
      organisationId: run.organisationId,
      runId: run.id,
      // Whichever the run was over. The constraint on the run guarantees one
      // of the two, so the outcome inherits it rather than deciding anything.
      documentId: run.documentId,
      projectId: run.projectId,
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
