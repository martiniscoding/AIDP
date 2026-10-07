import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { canManageStandards } from "@/lib/access/roles";

/**
 * Sharpening a clause from a confirmed `partial`.
 *
 * The third way into the standards library, beside the parser and
 * `restoreRule`. A `partial` verdict means the clause could not be judged:
 * "ensure resilience" against a design that retries without a dead-letter path
 * is partial for ever, because the clause never said what the rest was. The
 * reviewer who confirmed that verdict knows what it meant; this is the path
 * from knowing it to the library saying it.
 *
 * Three rules everything here keeps:
 *
 *  1. **A clause is never edited in place.** The old row stays, gains a pointer
 *     to its replacement, and stops being judged — the same reasoning as
 *     `Decision` and `Framework`. A `Finding` denormalises a clause's statement
 *     but not its requirements, so an in-place rewrite would leave last year's
 *     "covered" standing against requirements that exist nowhere.
 *  2. **A model drafts, a person decides.** The worker writes candidate
 *     requirement lines and checks them (Workers/aidp/standards.py); nothing
 *     reaches a clause that a person has not read and approved.
 *  3. **Only additions.** The statement, the rationale and the existing
 *     requirements are carried over untouched. A model permitted to reword the
 *     rule would change what the customer requires, and an approver would have
 *     no way to see that it had.
 */

/** Verdicts a sharpening may be asked for. */
export const SHARPENABLE = ["partial"] as const;

export type DraftState = "drafting" | "ready" | "failed" | "applied" | "discarded";

/** A line the checks threw away, with the reason, as the worker recorded it. */
export type SetAsideLine = { text: string; reason: string };

export type DraftView = {
  id: string;
  clauseId: string;
  clauseRef: string;
  clauseTitle: string;
  sourceFindingId: string;
  state: DraftState;
  /** The lines proposed, in the words a standard would use. */
  requirements: string[];
  /** The model's one line on what the clause left unsaid. */
  note: string;
  model: string | null;
  error: string | null;
  setAside: SetAsideLine[];
  appliedClauseId: string | null;
  requestedByName: string;
  createdAt: Date;
  /** The requirements the clause has today, to show the proposal beside them. */
  existing: string[];
  /**
   * Active decisions anchored to this clause's reference.
   *
   * The hole this closes: the worker matches decisions on `clauseRef`, not on a
   * clause id, so every ruling on §9.3 carries straight over to a sharpened
   * §9.3 — including one recorded against the *vaguer* wording. Sharpen the
   * clause and an older "this satisfies it" would quietly excuse the new
   * requirement. Named here so the approver sees what they are about to leave
   * standing.
   */
  decisionsInTheWay: { id: string; title: string; effect: string }[];
};

const SELECT = {
  id: true,
  clauseId: true,
  clauseRef: true,
  clauseTitle: true,
  sourceFindingId: true,
  state: true,
  requirements: true,
  note: true,
  model: true,
  error: true,
  setAside: true,
  appliedClauseId: true,
  requestedByName: true,
  createdAt: true,
} as const;

const STATES: DraftState[] = ["drafting", "ready", "failed", "applied", "discarded"];

function readState(value: string): DraftState {
  return (STATES as string[]).includes(value) ? (value as DraftState) : "failed";
}

/** Read defensively: a malformed entry is dropped, never guessed at. */
export function readSetAside(value: unknown): SetAsideLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || typeof row.reason !== "string") return [];
    return [{ text: row.text, reason: row.reason }];
  });
}

/** The clause reference, which comes from the section rather than the clause. */
function refOf(section: { numberText: string | null; headingPath: string }): string {
  return section.numberText || section.headingPath || "";
}

export class NotSharpenable extends Error {}

/**
 * Sharpening a clause is curating the standards, so it is the administrator's.
 *
 * The same policy `guardStandards` applies to uploading, deleting and
 * re-parsing a reference document, and for the same reason: whoever decides
 * what the library requires decides every verdict the product will produce for
 * this customer. A member submitting a design must not be able to add a
 * requirement to the standard they are about to be judged by — or, worse, to
 * the one they have just been judged by.
 *
 * Checked here rather than only in the action, because a Server Action accepts
 * a direct POST and this module is the thing that writes.
 */
const REFUSED =
  "Only an administrator can change the standards. You can confirm the finding without it.";

function guard(membership: { role: string }): void {
  if (!canManageStandards(membership.role)) throw new NotSharpenable(REFUSED);
}

/**
 * Ask for the requirement lines a clause was missing.
 *
 * Refuses more than it accepts, on purpose. A sharpening rests entirely on one
 * reviewer having agreed with one verdict, so every part of that has to be true
 * before a model is paid to write anything.
 */
export async function requestDraft(
  userId: string,
  findingId: string,
  requestedByName: string,
): Promise<{ id: string; state: DraftState }> {
  const finding = await prisma.finding.findUnique({
    where: { id: findingId },
    select: {
      id: true,
      clauseId: true,
      clauseRef: true,
      clauseTitle: true,
      verdict: true,
      reviewerState: true,
      evidence: true,
      run: { select: { id: true, organisationId: true, documentId: true } },
    },
  });
  if (!finding) throw new NotSharpenable("That finding no longer exists.");

  const organisationId = finding.run.organisationId;
  guard(await requireMembership(userId, organisationId));

  if (!(SHARPENABLE as readonly string[]).includes(finding.verdict)) {
    throw new NotSharpenable(
      "Only a partial verdict can sharpen a clause. A partial means the clause did not " +
        "say what the rest was; any other verdict is an argument about the design.",
    );
  }
  // Confirmed, not merely reviewed. An override says the verdict was wrong, and
  // sharpening a clause on the strength of a verdict the reviewer rejected
  // would write the model's mistake into the library.
  if (finding.reviewerState !== "confirmed") {
    throw new NotSharpenable(
      "Confirm this verdict first. A clause is only sharpened from a partial somebody has agreed with.",
    );
  }

  const clause = await prisma.clause.findUnique({
    where: { id: finding.clauseId },
    select: {
      id: true,
      supersededById: true,
      section: {
        select: { numberText: true, headingPath: true, document: { select: { organisationId: true } } },
      },
    },
  });
  if (!clause) {
    throw new NotSharpenable(
      "The clause behind this finding is no longer in the library — the standard was re-read since this assessment.",
    );
  }
  // The clause is reached through the finding, which is reached through the run,
  // whose organisation we checked. This closes the remaining gap: a clause that
  // belongs to another customer's document must not be editable from here.
  if (clause.section.document.organisationId !== organisationId) {
    throw new NotSharpenable("That clause belongs to another organisation.");
  }
  if (clause.supersededById) {
    throw new NotSharpenable(
      "That clause has already been replaced by a sharper version. Assess again and start from the new one.",
    );
  }

  // Said here as well as in the worker: paying for a model call that rule 6
  // would refuse every line of is worse than saying so now.
  const cited = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
  if (cited === 0) {
    throw new NotSharpenable(
      "This finding cites no passage of the design, so there is nothing to write a requirement from.",
    );
  }

  const live = await prisma.clauseDraft.findFirst({
    where: { sourceFindingId: findingId, state: { in: ["drafting", "ready"] } },
    select: { id: true, state: true },
  });
  if (live) return { id: live.id, state: readState(live.state) };

  const draftId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.clauseDraft.create({
      data: {
        id: draftId,
        organisationId,
        clauseId: finding.clauseId,
        clauseRef: finding.clauseRef || refOf(clause.section),
        clauseTitle: finding.clauseTitle,
        sourceFindingId: findingId,
        sourceRunId: finding.run.id,
        state: "drafting",
        requestedById: userId,
        requestedByName,
      },
    });
    await tx.job.create({
      data: {
        organisationId,
        documentId: finding.run.documentId,
        stage: "analyse",
        correlationId: randomUUID(),
        // `runId` so the job reads like every other analyse job in the activity
        // log; `draftId` is what the stage dispatches on.
        payload: { runId: finding.run.id, draftId },
      },
    });
  });

  return { id: draftId, state: "drafting" };
}

async function decisionsOn(
  organisationId: string,
  clauseRef: string,
): Promise<{ id: string; title: string; effect: string }[]> {
  if (!clauseRef) return [];
  return prisma.decision.findMany({
    where: {
      organisationId,
      clauseRef,
      status: "active",
      // Only the ones that would excuse the new requirement. A "rejects" or a
      // "context" ruling does not blunt a sharpening, and naming it would be
      // noise in front of the one that does.
      effect: "accepts",
    },
    select: { id: true, title: true, effect: true },
  });
}

/** The drafts for a run's findings, by finding id, for the report to show. */
export async function draftsForRun(runId: string): Promise<Map<string, DraftView>> {
  const rows = await prisma.clauseDraft.findMany({
    where: { sourceRunId: runId },
    select: {
      ...SELECT,
      organisationId: true,
      clause: { select: { requirements: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const out = new Map<string, DraftView>();
  for (const row of rows) {
    // Newest first, so the first one seen for a finding is the live one and a
    // discarded predecessor does not overwrite it.
    if (out.has(row.sourceFindingId)) continue;
    const { organisationId, clause, setAside, state, ...rest } = row;
    out.set(row.sourceFindingId, {
      ...rest,
      state: readState(state),
      setAside: readSetAside(setAside),
      existing: clause?.requirements ?? [],
      decisionsInTheWay:
        readState(state) === "ready" ? await decisionsOn(organisationId, row.clauseRef) : [],
    });
  }
  return out;
}

/**
 * A draft as a client component may receive it.
 *
 * `DraftView` carries a Date and a clause id a report has no use for; a Server
 * Component cannot hand either across the boundary, so the report maps through
 * this. Kept beside the view it narrows rather than in the page, because both
 * reports need the same shape.
 */
export type ClientDraft = {
  id: string;
  state: DraftState;
  requirements: string[];
  note: string;
  error: string | null;
  setAside: SetAsideLine[];
  existing: string[];
  decisionsInTheWay: { id: string; title: string; effect: string }[];
};

/**
 * Only a draft still in play reaches the report.
 *
 * `applied` and `discarded` are history: the clause itself says what was added
 * — see `Clause.authoredByName` — and a panel offering to approve something
 * already approved is a bug waiting to be clicked.
 */
export function draftView(draft: DraftView | undefined): ClientDraft | null {
  if (!draft) return null;
  if (draft.state === "applied" || draft.state === "discarded") return null;
  return {
    id: draft.id,
    state: draft.state,
    requirements: draft.requirements,
    note: draft.note,
    error: draft.error,
    setAside: draft.setAside,
    existing: draft.existing,
    decisionsInTheWay: draft.decisionsInTheWay,
  };
}

export class NotApplicable extends Error {}

/**
 * Approve a draft: the clause gains the lines, as a new version of itself.
 *
 * `requirements` is what the reviewer settled on, not what the model wrote —
 * they may have edited the wording or dropped a line, and what they approved is
 * what binds.
 */
export async function applyDraft(
  userId: string,
  draftId: string,
  requirements: string[],
  authoredByName: string,
): Promise<{ clauseId: string; added: number }> {
  const draft = await prisma.clauseDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      organisationId: true,
      clauseId: true,
      state: true,
      sourceFindingId: true,
      sourceRunId: true,
    },
  });
  if (!draft) throw new NotApplicable("That proposal no longer exists.");
  const membership = await requireMembership(userId, draft.organisationId);
  if (!canManageStandards(membership.role)) throw new NotApplicable(REFUSED);

  if (draft.state !== "ready") {
    throw new NotApplicable(
      draft.state === "applied"
        ? "That proposal has already been added to the standard."
        : "That proposal is not ready to be added.",
    );
  }

  const added = requirements
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (added.length === 0) {
    throw new NotApplicable("Keep at least one requirement, or discard the proposal.");
  }

  const clause = await prisma.clause.findUnique({
    where: { id: draft.clauseId },
    select: {
      id: true,
      sectionId: true,
      title: true,
      statement: true,
      rationale: true,
      requirements: true,
      guidance: true,
      pageStart: true,
      pageEnd: true,
      origin: true,
      sourceRefs: true,
      supersededById: true,
    },
  });
  if (!clause) throw new NotApplicable("That clause is no longer in the library.");
  if (clause.supersededById) {
    throw new NotApplicable(
      "Somebody has already replaced that clause. Reload the report and start from the new one.",
    );
  }

  const newId = randomUUID();
  await prisma.$transaction(async (tx) => {
    // Appended rather than inserted at the old ordinal, exactly as a restored
    // rule is. The clause reference comes from the section, so the sharper
    // version keeps it either way, and appending means the partial unique index
    // never sees two live clauses at one ordinal mid-transaction.
    const last = await tx.clause.findFirst({
      where: { sectionId: clause.sectionId },
      orderBy: { ordinal: "desc" },
      select: { ordinal: true },
    });

    await tx.clause.create({
      data: {
        id: newId,
        sectionId: clause.sectionId,
        ordinal: (last?.ordinal ?? 0) + 1,
        title: clause.title,
        // Untouched, all three. Only requirements grow — see rule 3 at the top.
        statement: clause.statement,
        rationale: clause.rationale,
        requirements: [...clause.requirements, ...added],
        guidance: clause.guidance,
        pageStart: clause.pageStart,
        pageEnd: clause.pageEnd,
        origin: "authored",
        sourceRefs: {
          // The parse's own refs for the parts that came from the document, so
          // the inherited text can still be traced to its lines.
          inherited: (clause.sourceRefs ?? null) as Prisma.InputJsonValue,
          sharpenedFrom: clause.id,
          draftId: draft.id,
          addedRequirements: added,
        } as Prisma.InputJsonValue,
        sourceFindingId: draft.sourceFindingId,
        sourceRunId: draft.sourceRunId,
        authoredByName,
        authoredAt: new Date(),
      },
    });

    // Conditional, so two approvals racing make one new version, not two. The
    // loser's update matches nothing and the transaction is rolled back.
    const marked = await tx.clause.updateMany({
      where: { id: clause.id, supersededById: null },
      data: { supersededById: newId },
    });
    if (marked.count !== 1) throw new NotApplicable("Somebody has already replaced that clause.");

    const closed = await tx.clauseDraft.updateMany({
      where: { id: draft.id, state: "ready" },
      data: { state: "applied", appliedClauseId: newId },
    });
    if (closed.count !== 1) throw new NotApplicable("That proposal has already been dealt with.");
  });

  return { clauseId: newId, added: added.length };
}

/** Say no to a draft. Kept, not deleted: what was refused is worth knowing. */
export async function discardDraft(userId: string, draftId: string): Promise<void> {
  const draft = await prisma.clauseDraft.findUnique({
    where: { id: draftId },
    select: { id: true, organisationId: true, state: true },
  });
  if (!draft) throw new NotApplicable("That proposal no longer exists.");
  const membership = await requireMembership(userId, draft.organisationId);
  if (!canManageStandards(membership.role)) throw new NotApplicable(REFUSED);
  if (draft.state === "applied") {
    throw new NotApplicable("That proposal is already part of the standard.");
  }
  await prisma.clauseDraft.updateMany({
    where: { id: draftId, state: { in: ["drafting", "ready", "failed"] } },
    data: { state: "discarded" },
  });
}
