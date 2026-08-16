"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { resolveFramework, unconfirmedStructure } from "@/lib/ingest/assessment";
import { promoteFinding } from "@/lib/ingest/decisions";
import { OutcomeRefused, record as recordRunOutcome } from "@/lib/ingest/outcomes";
import { isOutcome } from "@/lib/ingest/outcomes-vocabulary";
import { remove } from "@/lib/ingest/storage";

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
        storageKey: true,
        title: true,
        sections: { select: { figures: { select: { storageKey: true } } } },
      },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };

    await requireMembership(user.id, document.organisationId);

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
      select: { organisationId: true, title: true },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };

    await requireMembership(user.id, document.organisationId);

    await prisma.$transaction(async (tx) => {
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
export async function startAssessment(documentId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();

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

    // A model-read standard is a proposal until a person confirms it. Blocking
    // here rather than warning: a report citing clauses nobody has checked is
    // worse than no report, and this is the last point at which it can be
    // stopped.
    const unconfirmed = await unconfirmedStructure(document.organisationId);
    if (unconfirmed.length > 0) {
      const names = unconfirmed.map((d) => d.title).join(", ");
      return {
        ok: false,
        message:
          unconfirmed.length === 1
            ? `The structure of "${names}" was read by a model and has not been confirmed. Open it and confirm the rules before assessing against them.`
            : `${unconfirmed.length} reference standards had their structure read by a model and are not yet confirmed: ${names}. Confirm them before assessing.`,
      };
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
      const run = await tx.assessmentRun.create({
        data: {
          organisationId: document.organisationId,
          documentId,
          frameworkId: framework.id,
          totalClauses: framework.clauseCount,
        },
        select: { id: true },
      });
      await tx.job.create({
        data: {
          organisationId: document.organisationId,
          documentId,
          stage: "analyse",
          correlationId: randomUUID(),
          payload: { runId: run.id },
        },
      });
      return run.id;
    });

    revalidatePath(`/dashboard/documents/${documentId}`);
    return {
      ok: true,
      message: `Assessing against ${framework.clauseCount} clauses from ${framework.name} v${framework.version}.`,
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
export async function confirmStructure(documentId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { organisationId: true, title: true, structureInferred: true },
    });
    if (!document) return { ok: false, message: "That document no longer exists." };
    await requireMembership(user.id, document.organisationId);

    if (!document.structureInferred) {
      return { ok: false, message: "That document's structure was parsed, not inferred." };
    }

    await prisma.document.update({
      where: { id: documentId },
      data: {
        structureConfirmedAt: new Date(),
        structureConfirmedBy: user.name || user.email,
      },
    });

    revalidatePath(`/dashboard/documents/${documentId}`);
    revalidatePath("/dashboard/documents");
    return { ok: true, message: `Confirmed. "${document.title}" can now be assessed against.` };
  } catch (error) {
    if (error instanceof NotAMember || error instanceof NoAccess) {
      return { ok: false, message: "You do not have access to that document." };
    }
    return { ok: false, message: "Could not confirm that structure." };
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
