"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import { canManageStandards } from "@/lib/access/roles";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { resolveFramework } from "@/lib/ingest/assessment";
import { promoteFinding } from "@/lib/ingest/decisions";
import { OutcomeRefused, record as recordRunOutcome } from "@/lib/ingest/outcomes";
import { isOutcome } from "@/lib/ingest/outcomes-vocabulary";
import { remove } from "@/lib/ingest/storage";
import type { Prisma } from "../../../../generated/prisma/client";

export type ActionResult = { ok: boolean; message: string; runId?: string };

/**
 * Server Actions accept direct POSTs, so the check in each of these is the
 * access control — not a duplicate of the page's redirect.
 *
 * `requireAccess` asks whether the caller is still admitted to their workspace,
 * which a session lookup does not: a revoked employee's password is still
 * correct, and their cookie is still well-formed.
 */
async function requireUser() {
  return (await requireAccess()).user;
}

const STANDARDS_REFUSED =
  "Only an administrator can change the standards. You can submit a design for assessment instead.";

/**
 * Refuse a member who is reaching for a reference document.
 *
 * Uploading a standard, deleting one, re-parsing one, and confirming the rules
 * a model read out of one are the same act in different clothes: they decide
 * what every future assessment is measured against. All four belong to the
 * administrator.
 *
 * Takes the role from `requireMembership`'s return value rather than from the
 * caller's active workspace, because a consultant can be an administrator of
 * one customer and a member of another — the role that matters is the one they
 * hold in the organisation that owns *this* document.
 */
function guardStandards(
  membership: { role: string },
  document: { role: string },
): ActionResult | null {
  if (document.role === "assessed") return null;
  if (canManageStandards(membership.role)) return null;
  return { ok: false, message: STANDARDS_REFUSED };
}

/**
 * Delete a document and everything derived from it.
 *
 * Data Standards §10.4 requires disposal to be "auditable, authorized, and
 * verifiable", and that "all copies and dependent systems must be identified
 * and addressed before destruction". Sections, clauses, tables, figures, chunks
 * and vectors go with the row through database cascades; the blobs are the part
 * Postgres cannot reach, so they are collected first and removed explicitly.
 *
 * The blob keys are read before the delete because afterwards there is nothing
 * left to read them from.
 */
export async function deleteDocument(documentId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        organisationId: true,
        role: true,
        storageKey: true,
        title: true,
        sections: { select: { figures: { select: { storageKey: true } } } },
      },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };

    const membership = await requireMembership(user.id, document.organisationId);
    const refused = guardStandards(membership, document);
    if (refused) return refused;

    const keys = [
      document.storageKey,
      ...document.sections.flatMap((s) => s.figures.map((f) => f.storageKey)),
    ].filter(Boolean);

    await prisma.document.delete({ where: { id: documentId } });
    const removed = await remove(keys);

    revalidatePath("/dashboard/documents");
    return {
      ok: true,
      message: `Deleted "${document.title}" and ${removed} stored file${removed === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    return { ok: false, message: "Could not delete that document." };
  }
}

/**
 * Re-run the pipeline from parse.
 *
 * Useful after a parser change, and the way out of a dead-lettered document.
 * Old jobs for this document are cleared first: the partial unique index only
 * permits one live job per stage, so a `dead` row left behind would not block
 * the insert but would clutter the history, and a `queued` one would.
 */
export async function reprocessDocument(documentId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { organisationId: true, role: true, title: true },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };

    const membership = await requireMembership(user.id, document.organisationId);
    const refused = guardStandards(membership, document);
    if (refused) return refused;

    await prisma.$transaction(async (tx) => {
      // Deleting the jobs deletes a waiting analyse job too, and a run left
      // "queued" without one is never picked up — while still holding the
      // document's one live-run slot, so every later assessment is refused.
      // The run was of the old reading anyway: stop it, and say why.
      await tx.assessmentRun.updateMany({
        where: { documentId, state: { in: ["queued", "running"] } },
        data: {
          state: "failed",
          failureReason:
            "Stopped because the document was re-processed. Assess it again once it has been read.",
          completedAt: new Date(),
        },
      });
      await tx.job.deleteMany({ where: { documentId } });
      await tx.document.update({
        where: { id: documentId },
        data: { status: "pending", failureReason: null },
      });
      await tx.job.create({
        data: {
          organisationId: document.organisationId,
          documentId,
          stage: "parse",
          correlationId: randomUUID(),
        },
      });
    });

    revalidatePath("/dashboard/documents");
    revalidatePath(`/dashboard/documents/${documentId}`);
    return { ok: true, message: `Re-queued "${document.title}".` };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    return { ok: false, message: "Could not re-queue that document." };
  }
}

/**
 * Start assessing a submitted design against the organisation's standards.
 *
 * The run row and its job commit together, so there is never a run with nothing
 * queued to advance it. A partial unique index on `assessment_run` allows only
 * one live run per document, which is what makes a double-click harmless — the
 * insert fails and this reports the run already under way rather than starting
 * a second one that would double the model spend.
 */
/**
 * Start an assessment.
 *
 * `mode` is how the judge sees the design: "retrieval" shows it the passages a
 * search found for each clause; "document" has it read the whole document and
 * quote it, every quote checked; "both" runs one and then the other, so their
 * verdicts can be compared clause by clause.
 */
export async function startAssessment(
  documentId: string,
  mode: "retrieval" | "document" | "both" = "retrieval",
): Promise<ActionResult> {
  try {
    const user = await requireUser();

    // A Server Action is reachable by direct POST, so the mode is untrusted input.
    if (!["retrieval", "document", "both"].includes(mode)) {
      return { ok: false, message: "That is not a way this document can be assessed." };
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        organisationId: true,
        title: true,
        role: true,
        status: true,
        _count: { select: { chunks: true } },
      },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };
    await requireMembership(user.id, document.organisationId);

    if (document.role !== "assessed") {
      return {
        ok: false,
        message:
          "Only a design submitted for assessment can be assessed. This is a reference standard.",
      };
    }
    if (document.status !== "ready" || document._count.chunks === 0) {
      return {
        ok: false,
        message: "Wait for this document to finish indexing before assessing it.",
      };
    }

    // Reading a design whole needs the page text the parse stage stores. A
    // document processed before that has none and would only fall back to
    // search, so say so before anything is queued.
    if (mode !== "retrieval") {
      const pages = await prisma.sourceLine.count({ where: { documentId } });
      if (pages === 0) {
        return {
          ok: false,
          message:
            "This document was processed before its pages were stored, so it cannot be read whole yet. Reprocess it, then try again.",
        };
      }
    }

    const framework = await resolveFramework(document.organisationId);
    if (framework.clauseCount === 0) {
      return {
        ok: false,
        message:
          "There are no reference standards indexed yet, so there is nothing to measure against.",
      };
    }

    const runId = await prisma.$transaction(async (tx) => {
      // A live run with no live analyse job will never move: its job was
      // removed before a worker took it. It still holds the one live-run slot,
      // so it is cleared here rather than refusing this attempt too. Only runs
      // older than a minute, so a double-click cannot clear the run the first
      // click has just committed.
      const liveJobs = await tx.job.count({
        where: { documentId, stage: "analyse", state: { in: ["queued", "leased"] } },
      });
      if (liveJobs === 0) {
        await tx.assessmentRun.updateMany({
          where: {
            documentId,
            state: { in: ["queued", "running"] },
            startedAt: { lt: new Date(Date.now() - 60_000) },
          },
          data: {
            state: "failed",
            failureReason:
              "This assessment never started: its job was lost before a worker picked it up. It was replaced by a new one.",
            completedAt: new Date(),
          },
        });
      }

      const run = await tx.assessmentRun.create({
        data: {
          organisationId: document.organisationId,
          documentId,
          frameworkId: framework.id,
          totalClauses: framework.clauseCount,
          // "both" starts with search; the worker opens the whole-document run
          // when this one completes, since a document can have one live run.
          mode: mode === "document" ? "document" : "retrieval",
        },
        select: { id: true },
      });
      await tx.job.create({
        data: {
          organisationId: document.organisationId,
          documentId,
          stage: "analyse",
          correlationId: randomUUID(),
          payload: mode === "both" ? { runId: run.id, then: "document" } : { runId: run.id },
        },
      });
      return run.id;
    });

    const scope = `${framework.clauseCount} clauses from ${framework.name} v${framework.version}`;
    revalidatePath(`/dashboard/documents/${documentId}`);
    return {
      ok: true,
      message:
        mode === "document"
          ? `Reading the whole document against ${scope}.`
          : mode === "both"
            ? `Assessing against ${scope} twice — by search, then by reading the whole document — so the two can be compared.`
            : `Assessing against ${scope}.`,
      runId,
    };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    // Both the live-run index and the live-job index surface as a unique
    // violation; either way the honest answer is the same.
    if (isUniqueViolation(error)) {
      return { ok: false, message: "An assessment is already running for this document." };
    }
    return { ok: false, message: "Could not start the assessment." };
  }
}

/**
 * Work out a finished assessment's suggested improvements again.
 *
 * Suggestions are reused while the design and the standards stay the same (see
 * Workers/aidp/advice.py), so assessing again would hand back the same set. This
 * queues a job that skips the stored set, asks the model afresh, and keeps the
 * answer as the set reused from then on. Only the suggestions are redone: the
 * findings belong to the assessment, and new advice is not a new assessment.
 *
 * The suggestions already on the report stay while the new set is worked out —
 * `refreshing` tells the page to say so and to keep checking — and stay if the
 * attempt fails.
 */
/**
 * Stop an assessment that has not finished.
 *
 * A run waits for a worker, and a worker can be busy with somebody else's
 * hundred-clause design — the person watching is the one who knows it is no
 * longer worth waiting for. Stopping marks the run with who stopped it and
 * deletes its job, so a queued one is never picked up and a worker already part
 * way through notices at its next clause: its progress write no longer matches a
 * running run, and it abandons the rest. See `_progress` in analyse.py.
 *
 * Findings already written are kept. They are what the run found before it was
 * stopped, and throwing them away would cost the model spend twice.
 */
export async function cancelAssessment(runId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (typeof runId !== "string" || !runId) {
      return { ok: false, message: "That assessment no longer exists." };
    }

    const run = await prisma.assessmentRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        documentId: true,
        organisationId: true,
        state: true,
        completedClauses: true,
        totalClauses: true,
      },
    });
    if (!run) return { ok: false, message: "That assessment no longer exists." };
    await requireMembership(user.id, run.organisationId);

    if (run.state !== "queued" && run.state !== "running") {
      return { ok: false, message: "That assessment has already finished." };
    }

    const stopped = await prisma.$transaction(async (tx) => {
      // Conditional, so a run that finished between the read above and here is
      // left as it finished rather than being marked stopped after the fact.
      const changed = await tx.assessmentRun.updateMany({
        where: { id: run.id, state: { in: ["queued", "running"] } },
        data: {
          state: "failed",
          failureReason:
            `Stopped by ${user.name || user.email} after ${run.completedClauses} of ` +
            `${run.totalClauses} clauses. Run it again whenever you are ready.`,
          completedAt: new Date(),
        },
      });
      if (changed.count === 0) return false;
      await tx.job.deleteMany({
        where: {
          documentId: run.documentId,
          stage: "analyse",
          state: { in: ["queued", "leased"] },
        },
      });
      return true;
    });
    if (!stopped) return { ok: false, message: "That assessment had already finished." };

    revalidatePath(`/dashboard/documents/${run.documentId}`);
    return { ok: true, message: "Assessment stopped. Its findings so far are kept." };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that assessment." };
    }
    return { ok: false, message: "Could not stop that assessment." };
  }
}

export async function refreshSuggestions(runId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (typeof runId !== "string" || !runId) {
      return { ok: false, message: "That assessment no longer exists." };
    }

    const run = await prisma.assessmentRun.findUnique({
      where: { id: runId },
      select: { id: true, documentId: true, organisationId: true, state: true, advice: true },
    });
    if (!run) return { ok: false, message: "That assessment no longer exists." };
    await requireMembership(user.id, run.organisationId);

    if (run.state !== "complete") {
      return {
        ok: false,
        message: "Suggestions can be worked out again once the assessment has finished.",
      };
    }
    // Only the report on screen: advice for an older run would be advice nobody
    // is looking at, next to findings that have since been superseded.
    const latest = await prisma.assessmentRun.findFirst({
      where: { documentId: run.documentId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (latest?.id !== run.id) {
      return {
        ok: false,
        message: "A newer assessment of this design exists. Reload the page to see it.",
      };
    }

    const previous =
      run.advice && typeof run.advice === "object" && !Array.isArray(run.advice)
        ? (run.advice as Record<string, unknown>)
        : null;
    // A request already on record is only honoured while its job is alive. One
    // whose job was lost would otherwise block every later request for good.
    if (previous?.refreshing === true) {
      const live = await prisma.job.count({
        where: { documentId: run.documentId, stage: "analyse", state: { in: ["queued", "leased"] } },
      });
      if (live > 0) {
        return { ok: false, message: "A new set of suggestions is already being worked out." };
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.job.create({
        data: {
          organisationId: run.organisationId,
          documentId: run.documentId,
          stage: "analyse",
          correlationId: randomUUID(),
          payload: { runId: run.id, adviceOnly: true, freshAdvice: true },
        },
      });
      await tx.assessmentRun.update({
        where: { id: run.id },
        data: {
          advice: {
            ...(previous ?? { version: 1, state: "failed", note: null, suggestions: [] }),
            refreshing: true,
            refreshError: null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    revalidatePath(`/dashboard/documents/${run.documentId}`);
    return { ok: true, message: "Working out a new set of suggestions. It takes about a minute." };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that assessment." };
    }
    // The one-live-analyse-job-per-document index: an assessment is running.
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        message: "Something is already running for this design. Try again when it finishes.",
      };
    }
    return { ok: false, message: "Could not ask for new suggestions." };
  }
}

/**
 * Record a reviewer's decision on a finding.
 *
 * Overrides are the point, not an escape hatch: they are what makes the tool
 * trustworthy enough to use, and they are the only evaluation data that will
 * ever tell us how well the model is actually doing. The machine's verdict is
 * never overwritten — `verdict` stays, `reviewerVerdict` sits beside it, so the
 * disagreement remains visible.
 */
/**
 * Record that a person has checked a model-read structure.
 *
 * Deliberately coarse: one sign-off for the document, not per clause. The
 * reviewer is confirming that the rules we extracted are the rules their
 * standard contains — a judgement about the whole reading, not a hundred
 * separate ones. Anything wrong at that point is fixed by correcting the source
 * document and reprocessing, which clears this again.
 */
/** The longest a useful summary runs to. Four sentences, generously. */
const MAX_SUMMARY = 1200;

/**
 * Correct what the system understood a document to be.
 *
 * The summary is not decoration: it is put in front of the model for every
 * clause of every assessment, so a wrong one reaches every verdict in the run.
 * A reviewer who can see that it is wrong and cannot change it is watching a
 * bad assessment happen.
 *
 * Findings already written used the previous understanding and are not
 * rewritten here — a stored verdict is a record of a judgement that was made,
 * not a cache to be invalidated. Re-running the assessment is what applies a
 * corrected summary, and the page says so.
 */
export async function setDocumentSummary(
  documentId: string,
  summary: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { organisationId: true, role: true, title: true },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };
    const membership = await requireMembership(user.id, document.organisationId);
    const refused = guardStandards(membership, document);
    if (refused) return refused;

    const trimmed = summary.trim().slice(0, MAX_SUMMARY);

    await prisma.document.update({
      where: { id: documentId },
      // Empty clears it rather than storing a blank string, so the judge falls
      // back to going without exactly as it does for a document that never had
      // one — see the note on the column.
      data: { summary: trimmed || null },
    });

    revalidatePath(`/dashboard/documents/${documentId}`);
    return {
      ok: true,
      message: trimmed
        ? "Saved. The next assessment run will use this."
        : "Cleared. The next run will go without a summary.",
    };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    throw error;
  }
}


class AlreadyRestored extends Error {}

type StoredLine = { ref: string; kind: string; text: string; page: number | null };

// Part labels and printed numbering, which are layout rather than the rule's
// words. Mirrors `_PART_LABEL` and the heading patterns in the worker.
const PART_LABEL =
  /^\s*(?:statements?|rationales?|requirements?|implications?|guidance|notes?)\s*:\s*/i;
const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*\.?|Appendix\s+[A-Z]\s*[:.]?)\s+(\S.*)$/i;

/**
 * A rule from stored source lines: the heading names it, the first passage is
 * its statement, and every later passage is a requirement.
 *
 * A passage is one paragraph, bullet or table row. A PDF wraps one sentence
 * over several lines, so a text line that does not end a sentence runs on into
 * the next rather than becoming a requirement of its own.
 */
function draftRule(lines: StoredLine[]) {
  const heading = lines.find((line) => line.kind === "heading");
  const passages: { refs: string[]; text: string; kind: string }[] = [];
  for (const line of lines) {
    if (line.kind === "heading" || line.kind === "table_header") continue;
    const text = (line.kind === "table_row" ? line.text : line.text.replace(PART_LABEL, "")).trim();
    if (!text) continue;
    const previous = passages[passages.length - 1];
    const startsItem = line.kind === "bullet" || line.kind === "table_row";
    if (previous && !startsItem && previous.kind === "text" && !/[.;:!?]$/.test(previous.text)) {
      previous.refs.push(line.ref);
      previous.text = `${previous.text} ${text}`;
    } else {
      passages.push({ refs: [line.ref], text, kind: line.kind });
    }
  }
  if (passages.length === 0) return null;

  const [statement, ...requirements] = passages;
  const pages = lines.map((line) => line.page).filter((page): page is number => page != null);
  const headingText = heading?.text.trim() ?? "";
  return {
    title: headingText ? (NUMBERED_HEADING.exec(headingText)?.[1] ?? headingText) : null,
    headingRef: heading?.ref ?? null,
    statement,
    requirements,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
  };
}

/**
 * Make lines the model set aside into a rule of the standard.
 *
 * The reviewer's answer to the one mistake the rules on the page cannot show: a
 * rule wrongly read as not being one, which no assessment would ever check.
 *
 * The client names the range and nothing else. Every word of the new rule is
 * read back from the stored source lines, so this cannot put text into a
 * standard that the document does not contain — the same guarantee the model
 * reading gives.
 */
export async function restoreRule(labelId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const label = await prisma.lineLabel.findUnique({
      where: { id: labelId },
      select: {
        id: true,
        documentId: true,
        fromOrdinal: true,
        toOrdinal: true,
        restoredAt: true,
        extraction: { select: { adopted: true } },
        document: { select: { organisationId: true, role: true } },
      },
    });
    if (!label) {
      return {
        ok: false,
        message: "Those lines are no longer on record — the document may have been re-parsed.",
      };
    }
    const membership = await requireMembership(user.id, label.document.organisationId);
    const refused = guardStandards(membership, label.document);
    if (refused) return refused;
    if (label.document.role !== "reference") {
      return { ok: false, message: "Only a reference standard has rules." };
    }
    if (label.restoredAt) return { ok: false, message: "Those lines are already a rule." };
    if (!label.extraction.adopted) {
      return { ok: false, message: "Those lines belong to a reading of the rules that was not used." };
    }

    const lines = await prisma.sourceLine.findMany({
      where: {
        documentId: label.documentId,
        ordinal: { gte: label.fromOrdinal, lte: label.toOrdinal },
      },
      orderBy: { ordinal: "asc" },
      select: { ref: true, kind: true, text: true, page: true, sectionOrdinal: true },
    });
    const drafted = draftRule(lines);
    if (!drafted) return { ok: false, message: "Those lines hold no text to make a rule from." };

    const sectionOrdinal = lines.find((line) => line.sectionOrdinal != null)?.sectionOrdinal;
    const section = await prisma.documentSection.findFirst({
      where: {
        documentId: label.documentId,
        ...(sectionOrdinal != null ? { ordinal: sectionOrdinal } : {}),
      },
      orderBy: { ordinal: "asc" },
      select: { id: true, title: true },
    });
    if (!section) return { ok: false, message: "That document has no section to hold a rule." };

    const by = user.name || user.email;
    await prisma.$transaction(async (tx) => {
      const last = await tx.clause.findFirst({
        where: { sectionId: section.id },
        orderBy: { ordinal: "desc" },
        select: { ordinal: true },
      });
      const clause = await tx.clause.create({
        data: {
          sectionId: section.id,
          ordinal: (last?.ordinal ?? 0) + 1,
          title: drafted.title ?? section.title,
          statement: drafted.statement.text,
          requirements: drafted.requirements.map((passage) => passage.text),
          pageStart: drafted.pageStart,
          pageEnd: drafted.pageEnd,
          origin: "restored",
          sourceRefs: {
            span: [lines[0].ref, lines[lines.length - 1].ref],
            heading: drafted.headingRef,
            statement: drafted.statement.refs,
            requirements: drafted.requirements.map((passage) => ({ refs: passage.refs })),
            restoredFrom: label.id,
          },
        },
        select: { id: true },
      });
      // Conditional, so two reviewers pressing at once make one rule, not two.
      const marked = await tx.lineLabel.updateMany({
        where: { id: label.id, restoredAt: null },
        data: { restoredAt: new Date(), restoredBy: by, restoredClauseId: clause.id },
      });
      if (marked.count !== 1) throw new AlreadyRestored();
    });

    revalidatePath(`/dashboard/documents/${label.documentId}`);
    return { ok: true, message: `Added as a rule under “${section.title}”.` };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    if (error instanceof AlreadyRestored) {
      return { ok: false, message: "Those lines are already a rule." };
    }
    return { ok: false, message: "Could not make those lines a rule." };
  }
}

/**
 * Record what was decided about a submission.
 *
 * The end of the loop: the assessment says whether a design meets the standard,
 * this says what happens to it. Append-only, so an escalation followed by the
 * board's ruling reads as a sequence rather than the second overwriting the
 * first.
 */
export async function recordOutcome(
  runId: string,
  decision: string,
  note: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!isOutcome(decision)) {
      return { ok: false, message: "That is not a decision this system records." };
    }

    const outcome = await recordRunOutcome(
      user.id,
      runId,
      decision,
      note,
      user.name || user.email,
    );

    const run = await prisma.assessmentRun.findUnique({
      where: { id: runId },
      select: { documentId: true },
    });
    if (run) revalidatePath(`/dashboard/documents/${run.documentId}`);
    revalidatePath("/dashboard/documents");

    const said = {
      approved: "Approved. The decision and the report behind it are on record.",
      revise: "Sent back for revision.",
      escalated: "Escalated to the architecture review board.",
    } as const;
    return { ok: true, message: said[outcome.decision] };
  } catch (error) {
    if (error instanceof OutcomeRefused) return { ok: false, message: error.message };
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that assessment." };
    }
    return { ok: false, message: "Could not record that decision." };
  }
}

export async function reviewFinding(
  findingId: string,
  decision: {
    confirm: boolean;
    verdict?: string;
    note?: string;
    /**
     * Carry this ruling into every future assessment. The reviewer has already
     * made the call and said why; promoting it is a checkbox rather than a
     * second act of authoring.
     */
    remember?: boolean;
  },
): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const finding = await prisma.finding.findUnique({
      where: { id: findingId },
      select: { run: { select: { organisationId: true, documentId: true } } },
    });
    if (!finding) return { ok: false, message: "That finding no longer exists." };
    await requireMembership(user.id, finding.run.organisationId);

    await prisma.finding.update({
      where: { id: findingId },
      data: {
        reviewerState: decision.confirm ? "confirmed" : "overridden",
        reviewerVerdict: decision.confirm ? null : (decision.verdict ?? null),
        reviewerNote: decision.note?.trim() || null,
        reviewedAt: new Date(),
      },
    });

    // Promotion runs after the review is durable, and its failure is reported
    // rather than thrown: losing the reviewer's verdict because an embedding
    // call timed out would be a bad trade.
    let remembered = false;
    let promotionError: string | null = null;
    if (decision.remember) {
      try {
        await promoteFinding(user.id, findingId, {}, user.name || user.email);
        remembered = true;
      } catch (error) {
        // Swallowed silently once, and it cost a debugging session: the register
        // sat empty, the reviewer was told to "try again from the register", and
        // there was no record anywhere of why it had failed. The promotion still
        // must not take the review down with it — but it has to leave a trace,
        // and tell the reviewer something they can act on.
        promotionError = error instanceof Error ? error.message : String(error);
        console.error("[reviewFinding] could not promote finding to a decision", {
          findingId,
          organisationId: finding.run.organisationId,
          error: promotionError,
        });
      }
    }

    revalidatePath(`/dashboard/documents/${finding.run.documentId}`);
    revalidatePath("/dashboard/decisions");

    const verb = decision.confirm ? "Confirmed" : "Override recorded";
    if (!decision.remember) return { ok: true, message: `${verb}.` };
    return {
      ok: true,
      message: remembered
        ? `${verb}, and added to your decisions.`
        : `${verb}. It could not be added to your decisions: ${
            promotionError ?? "unknown error"
          }. The reason is recorded either way — add it from the register.`,
    };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that finding." };
    }
    return { ok: false, message: "Could not record that decision." };
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  // P2002 is Prisma's; 23505 comes straight from Postgres when the constraint
  // is a partial index Prisma does not know about.
  return code === "P2002" || code === "23505";
}

/**
 * Record a human's verdict on a figure description.
 *
 * Non-blocking by design: the document is already indexed, so this corrects a
 * chunk rather than releasing one. Three outcomes —
 *
 *   confirm  the model read the diagram correctly; nothing changes
 *   correct  the description is replaced, and only that chunk re-embeds
 *   reject   the description is unusable; the chunk is removed entirely
 *
 * Rejecting is deliberately destructive. An unusable description is worse than
 * no chunk at all: it reads like a quotation from the document and would be
 * cited as one.
 *
 * The model's original is never overwritten — `correctedDescription` sits
 * beside it, so the disagreement stays visible and the vision model's accuracy
 * stays measurable.
 */
export async function reviewFigure(
  figureId: string,
  decision: { action: "confirm" | "correct" | "reject"; description?: string; note?: string },
): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const figure = await prisma.figure.findUnique({
      where: { id: figureId },
      select: {
        description: true,
        correctedDescription: true,
        caption: true,
        section: {
          select: {
            headingPath: true,
            document: { select: { id: true, organisationId: true } },
          },
        },
      },
    });
    if (!figure) return { ok: false, message: "That figure no longer exists." };

    const { id: documentId, organisationId } = figure.section.document;
    await requireMembership(user.id, organisationId);

    const corrected =
      decision.action === "correct" ? (decision.description ?? "").trim() : null;
    if (decision.action === "correct" && !corrected) {
      return { ok: false, message: "Write a description, or reject it instead." };
    }

    await prisma.$transaction(async (tx) => {
      await tx.figure.update({
        where: { id: figureId },
        data: {
          reviewState:
            decision.action === "confirm"
              ? "confirmed"
              : decision.action === "correct"
                ? "corrected"
                : "rejected",
          correctedDescription: corrected,
          reviewNote: decision.note?.trim() || null,
          reviewedAt: new Date(),
        },
      });

      // Confirming changes no text, so there is nothing to re-index.
      if (decision.action === "confirm") return;

      const chunk = await tx.chunk.findFirst({
        where: { documentId, sourceKind: "figure", sourceId: figureId },
        select: { id: true },
      });
      if (!chunk) return;

      if (decision.action === "reject") {
        // Embeddings cascade from the chunk.
        await tx.chunk.delete({ where: { id: chunk.id } });
        return;
      }

      const body = `${figure.caption ?? "Figure"}\n\n${corrected}`;
      const text = `${figure.section.headingPath}\n\n${body}`;
      await tx.chunk.update({
        where: { id: chunk.id },
        data: {
          text,
          tokenCount: Math.round(text.length / 3.8),
          contentHash: createHash("sha256").update(text).digest("hex"),
        },
      });
      // Drop the stale vector. The embed stage only embeds chunks missing one
      // for the current model, so the job below re-embeds exactly this chunk
      // and nothing else.
      await tx.embedding.deleteMany({ where: { chunkId: chunk.id } });
      await tx.job.deleteMany({ where: { documentId, stage: "embed" } });
      await tx.job.create({
        data: {
          organisationId,
          documentId,
          stage: "embed",
          correlationId: randomUUID(),
        },
      });
    });

    revalidatePath(`/dashboard/documents/${documentId}`);
    return {
      ok: true,
      message:
        decision.action === "confirm"
          ? "Confirmed."
          : decision.action === "correct"
            ? "Description replaced — re-indexing this figure."
            : "Rejected. This figure is no longer searchable.",
    };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that figure." };
    }
    return { ok: false, message: "Could not record that decision." };
  }
}
