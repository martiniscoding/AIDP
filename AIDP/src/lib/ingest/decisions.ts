import { prisma } from "@/lib/prisma";
import { requireMembership } from "./org";
import { embeddingModel, embedText, toVectorLiteral } from "./retrieval";
import {
  DECISION_EFFECTS,
  readScope,
  type DecisionEffect,
  type DecisionScope,
} from "./decision-effects";

/**
 * The organisation's standing decisions.
 *
 * A decision is what this customer concluded when a standard met a real design.
 * The analyse stage retrieves them per clause and puts them in front of the
 * model, so a question settled once stops being re-litigated on every
 * subsequent submission — see Workers/aidp/decisions.py.
 *
 * Two invariants everything here maintains:
 *
 *  1. **Nothing is edited in place.** A revision writes a new row and points the
 *     old one at it. A finding that says "accepted under decision D" has to keep
 *     meaning that a year later, which it cannot if D has since been rewritten.
 *  2. **The vector is optional.** Embedding needs a live API key and a quota,
 *     and neither is guaranteed at the moment someone records a ruling. A
 *     decision with no vector still matches on its clause reference; losing the
 *     ruling because an embedding call failed would be far worse.
 */

export type DecisionView = {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  effect: DecisionEffect;
  clauseRef: string;
  clauseTitle: string;
  /** "organisation", or "project" for a ruling that reaches one project only. */
  scope: DecisionScope;
  projectId: string | null;
  /** Null when organisation-wide, and when the project has since been removed. */
  projectName: string | null;
  status: string;
  effectiveFrom: Date;
  expiresAt: Date | null;
  decidedByName: string;
  sourceDocumentId: string | null;
  supersededById: string | null;
  hasVector: boolean;
  createdAt: Date;
};

const SELECT = {
  id: true,
  title: true,
  statement: true,
  rationale: true,
  effect: true,
  clauseRef: true,
  clauseTitle: true,
  scope: true,
  projectId: true,
  project: { select: { name: true } },
  status: true,
  effectiveFrom: true,
  expiresAt: true,
  decidedByName: true,
  sourceDocumentId: true,
  supersededById: true,
  embeddingModel: true,
  createdAt: true,
} as const;

type Row = {
  effect: string;
  scope: string;
  project: { name: string } | null;
  embeddingModel: string | null;
} & Omit<DecisionView, "effect" | "scope" | "projectName" | "hasVector">;

function toView(row: Row): DecisionView {
  const { embeddingModel, effect, scope, project, ...rest } = row;
  return {
    ...rest,
    effect: (DECISION_EFFECTS as readonly string[]).includes(effect)
      ? (effect as DecisionEffect)
      : "context",
    scope: readScope(scope),
    // Null when the ruling is organisation-wide, and also when its project has
    // been removed — the register distinguishes the two by `scope`.
    projectName: project?.name ?? null,
    hasVector: embeddingModel !== null,
  };
}

/**
 * Expiry is applied on read rather than by a scheduled sweep.
 *
 * There is no cron in this system, and a decision that is past its date but
 * still marked active would be handed to the model as though it were in force.
 * Reading is the only moment we can guarantee happens before that.
 */
async function retireExpired(organisationId: string): Promise<number> {
  const { count } = await prisma.decision.updateMany({
    where: { organisationId, status: "active", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
  return count;
}

export async function listDecisions(
  userId: string,
  organisationId: string,
): Promise<DecisionView[]> {
  await requireMembership(userId, organisationId);
  await retireExpired(organisationId);

  const rows = await prisma.decision.findMany({
    where: { organisationId },
    select: SELECT,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

/**
 * How many decisions a run in this scope would be judged with.
 *
 * `projectId` is the project whose report is asking. Organisation-wide rulings
 * always count; a project's own count only on that project's assessments. Left
 * out, this is the whole register's active count, which is right for the
 * register itself and wrong for a report — the report would promise the model
 * rulings granted to somebody else's project.
 */
export async function countActive(
  organisationId: string,
  projectId?: string | null,
): Promise<number> {
  await retireExpired(organisationId);
  return prisma.decision.count({
    where: {
      organisationId,
      status: "active",
      ...(projectId === undefined
        ? {}
        : { OR: [{ scope: "organisation" }, ...(projectId ? [{ projectId }] : [])] }),
    },
  });
}

/**
 * Attach the vector.
 *
 * Deliberately not part of the creating transaction: it is a network call to a
 * third party, and holding a Postgres transaction open across one is how a
 * connection pool dies. The row is already durable by the time this runs.
 */
async function attachVector(decisionId: string, text: string): Promise<boolean> {
  try {
    const model = embeddingModel();
    // "passage": clause queries go looking for these, so they sit on the
    // document side of the query/passage asymmetry.
    const vector = toVectorLiteral(await embedText(text, "passage"));
    await prisma.$executeRaw`
      UPDATE "decision"
         SET "vector" = ${vector}::vector, "embeddingModel" = ${model}
       WHERE "id" = ${decisionId}
    `;
    return true;
  } catch {
    // Left unembedded on purpose — see the note at the top of this file. The
    // register shows which rows these are so they can be retried.
    return false;
  }
}

/** The text a clause query searches against. */
function searchableText(input: {
  title: string;
  statement: string;
  clauseTitle?: string;
  rationale?: string;
}): string {
  return [input.clauseTitle, input.title, input.statement, input.rationale]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

export type DecisionInput = {
  title: string;
  statement: string;
  rationale?: string;
  effect: DecisionEffect;
  /**
   * Defaults to organisation-wide, which is what every decision was before
   * scopes existed. "project" requires `projectId`, and is refused without one
   * rather than quietly widened — a ruling meant for one project that lands in
   * the register as policy is the failure this scope exists to prevent.
   */
  scope?: DecisionScope;
  projectId?: string | null;
  clauseId?: string | null;
  clauseRef?: string;
  clauseTitle?: string;
  expiresAt?: Date | null;
  sourceFindingId?: string | null;
  sourceRunId?: string | null;
  sourceDocumentId?: string | null;
};

export async function createDecision(
  userId: string,
  organisationId: string,
  input: DecisionInput,
  decidedByName: string,
): Promise<{ id: string; embedded: boolean }> {
  await requireMembership(userId, organisationId);

  const scope = input.scope ?? "organisation";
  const projectId = scope === "project" ? (input.projectId ?? null) : null;
  if (scope === "project" && !projectId) {
    throw new Error("A decision scoped to one project has to say which project.");
  }
  if (projectId) {
    // Checked against this organisation, so a project id from another customer
    // cannot be used to plant a ruling inside theirs.
    const project = await prisma.project.findFirst({
      where: { id: projectId, organisationId },
      select: { id: true },
    });
    if (!project) throw new Error("That project is not one of this organisation's.");
  }

  const decision = await prisma.decision.create({
    data: {
      organisationId,
      scope,
      projectId,
      title: input.title.trim(),
      statement: input.statement.trim(),
      rationale: input.rationale?.trim() ?? "",
      effect: input.effect,
      clauseId: input.clauseId ?? null,
      clauseRef: input.clauseRef?.trim() ?? "",
      clauseTitle: input.clauseTitle?.trim() ?? "",
      expiresAt: input.expiresAt ?? null,
      sourceFindingId: input.sourceFindingId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      decidedById: userId,
      decidedByName,
    },
    select: { id: true },
  });

  const embedded = await attachVector(decision.id, searchableText(input));
  return { id: decision.id, embedded };
}

/**
 * Revise a decision by replacing it.
 *
 * The old row stays exactly as it was and gains a pointer to its replacement,
 * so every finding that cites it still resolves and the register can show the
 * chain. This is the same reasoning that makes Framework versioned.
 */
export async function superseded(
  userId: string,
  organisationId: string,
  decisionId: string,
  input: DecisionInput,
  decidedByName: string,
): Promise<{ id: string; embedded: boolean }> {
  await requireMembership(userId, organisationId);

  const previous = await prisma.decision.findFirst({
    where: { id: decisionId, organisationId },
    select: { id: true, status: true, scope: true, projectId: true },
  });
  if (!previous) throw new Error("That decision no longer exists.");

  // A revision keeps the reach it was granted unless it is asked to change it.
  // Inheriting is the safe default in both directions: an editor who only
  // fixed a typo must not widen a project's exemption into policy, and a form
  // that does not know about scopes must not narrow one either.
  const replacement = await createDecision(
    userId,
    organisationId,
    {
      ...input,
      scope: input.scope ?? readScope(previous.scope),
      projectId: input.projectId ?? previous.projectId,
    },
    decidedByName,
  );

  await prisma.decision.update({
    where: { id: previous.id },
    data: { status: "superseded", supersededById: replacement.id },
  });

  return replacement;
}

/** Take a decision out of force without replacing it. */
export async function retire(
  userId: string,
  organisationId: string,
  decisionId: string,
): Promise<void> {
  await requireMembership(userId, organisationId);
  await prisma.decision.updateMany({
    where: { id: decisionId, organisationId },
    data: { status: "expired", expiresAt: new Date() },
  });
}

/** Put an expired or superseded decision back in force. */
export async function reinstate(
  userId: string,
  organisationId: string,
  decisionId: string,
): Promise<void> {
  await requireMembership(userId, organisationId);
  await prisma.decision.updateMany({
    where: { id: decisionId, organisationId },
    data: { status: "active", expiresAt: null, supersededById: null },
  });
}

/**
 * Re-embed the rows whose embedding call failed when they were written.
 *
 * Almost always a quota or a missing key at the moment of the ruling. Without
 * this they would match on clause reference alone forever.
 */
export async function embedPending(
  userId: string,
  organisationId: string,
): Promise<{ done: number; failed: number }> {
  await requireMembership(userId, organisationId);

  const rows = await prisma.decision.findMany({
    where: { organisationId, status: "active", embeddingModel: null },
    select: { id: true, title: true, statement: true, rationale: true, clauseTitle: true },
    take: 50,
  });

  let done = 0;
  for (const row of rows) {
    // Sequential: these are rate-limited third-party calls, and a burst of 50
    // is the fastest way to get the whole batch throttled.
    const ok = await attachVector(row.id, searchableText(row));
    if (ok) done += 1;
  }
  return { done, failed: rows.length - done };
}

/**
 * The project an assessment was about, however it was started.
 *
 * A project run names it; a single-design run does not, and the design's own
 * project is the answer — the same two cases `designs.for_run` resolves in the
 * worker. Null when the design belongs to no project at all.
 */
function projectOf(run: {
  projectId: string | null;
  document: { projectId: string | null } | null;
}): string | null {
  return run.projectId ?? run.document?.projectId ?? null;
}

/**
 * Turn a reviewed finding into a standing decision.
 *
 * This is the cheap path and the one that will carry most of the register: the
 * reviewer has already made the call and written down why, so promoting it is
 * one checkbox rather than a second act of authoring.
 */
export async function promoteFinding(
  userId: string,
  findingId: string,
  overrides: {
    title?: string;
    statement?: string;
    effect?: DecisionEffect;
    expiresAt?: Date | null;
    /**
     * "project" keeps the ruling inside the work it came from. The project is
     * the one the finding's run was about, never one the caller names: a
     * reviewer allowing a breach is allowing it here, and letting a request
     * choose the project would let a report grant exemptions to another.
     */
    scope?: DecisionScope;
  },
  decidedByName: string,
): Promise<{ id: string; embedded: boolean }> {
  const finding = await prisma.finding.findUnique({
    where: { id: findingId },
    select: {
      clauseId: true,
      clauseRef: true,
      clauseTitle: true,
      clauseStatement: true,
      verdict: true,
      reviewerVerdict: true,
      reviewerNote: true,
      run: {
        select: {
          id: true,
          organisationId: true,
          documentId: true,
          // Set on a project run. A single-design run has none, and the design's
          // own project is the one it belongs to — see `projectOf`.
          projectId: true,
          document: { select: { projectId: true } },
        },
      },
    },
  });
  if (!finding) throw new Error("That finding no longer exists.");

  const organisationId = finding.run.organisationId;
  await requireMembership(userId, organisationId);

  const scope = overrides.scope ?? "organisation";
  const projectId = scope === "project" ? projectOf(finding.run) : null;
  if (scope === "project" && !projectId) {
    // A design uploaded before projects existed, or one sitting outside any.
    // Refused rather than widened to the whole organisation, which is the
    // opposite of what the reviewer asked for.
    throw new Error(
      "This design is not in a project, so a ruling cannot be limited to one. " +
        "Move it into a project first, or record the decision for the whole organisation.",
    );
  }

  // Idempotent. A reviewer who ticks the box, changes their mind about the
  // verdict and saves again should not end up with the register holding the
  // same ruling twice — and duplicates would both reach the model, where they
  // read as two independent precedents agreeing.
  const already = await prisma.decision.findFirst({
    where: { organisationId, sourceFindingId: findingId, status: "active" },
    select: { id: true, embeddingModel: true },
  });
  if (already) return { id: already.id, embedded: already.embeddingModel !== null };

  const settled = finding.reviewerVerdict ?? finding.verdict;

  return createDecision(
    userId,
    organisationId,
    {
      title: overrides.title?.trim() || `${finding.clauseRef} — ${finding.clauseTitle}`.trim(),
      statement: overrides.statement?.trim() || finding.reviewerNote || finding.clauseStatement,
      rationale: finding.reviewerNote ?? "",
      // A reviewer who overrode to "covered" is saying this arrangement
      // satisfies the clause; one who overrode to "contradicts" is saying the
      // opposite. Anything else is context rather than a ruling.
      effect:
        overrides.effect ??
        (settled === "covered" ? "accepts" : settled === "contradicts" ? "rejects" : "context"),
      scope,
      projectId,
      clauseId: finding.clauseId,
      clauseRef: finding.clauseRef,
      clauseTitle: finding.clauseTitle,
      expiresAt: overrides.expiresAt ?? null,
      sourceFindingId: findingId,
      sourceRunId: finding.run.id,
      sourceDocumentId: finding.run.documentId,
    },
    decidedByName,
  );
}

/**
 * Which of these findings have already been promoted, keyed by finding id.
 *
 * Lets the report show that a ruling was kept, so a reviewer working through a
 * re-run does not record the same decision a second time.
 */
export async function promotedFrom(
  organisationId: string,
  findingIds: string[],
): Promise<Map<string, { id: string; scope: DecisionScope }>> {
  if (findingIds.length === 0) return new Map();
  const rows = await prisma.decision.findMany({
    where: { organisationId, sourceFindingId: { in: findingIds } },
    // The scope comes back with it so a reviewed finding can say which reach it
    // was kept with. "Remembered" alone reads as policy, and an allowance
    // granted to one project must not look like one.
    select: { id: true, sourceFindingId: true, scope: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.sourceFindingId
        ? [[row.sourceFindingId, { id: row.id, scope: readScope(row.scope) }] as const]
        : [],
    ),
  );
}
