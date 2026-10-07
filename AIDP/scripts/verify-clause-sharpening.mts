/**
 * Sharpening a clause from a confirmed `partial`, from the app's side.
 *
 * The checks on the model's words are Workers/tests/test_clause_sharpening.py,
 * which needs neither a database nor a model. This is the half the app owns,
 * and it is the half that fails silently: that only a confirmed partial and
 * only an administrator can start one, that approving a proposal *replaces* the
 * clause rather than rewriting it — so last year's report still says what it
 * was measured against — that from then on only the live version is judged, and
 * that the partial unique index behind all of it is really there, since Prisma
 * cannot see it and nothing else would notice if it were not.
 *
 * Needs a live analyse worker and a model key: the requirement lines are
 * written by one real call, which is also the only way to see what the prompt
 * actually produces. Against a throwaway organisation, removed at the end.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-clause-sharpening.mts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { MEMBER, OWNER } from "../src/lib/access/roles";
import { countClauses } from "../src/lib/ingest/assessment";
import { applyDraft, draftsForRun, requestDraft } from "../src/lib/ingest/standards";

const TAG = `zz-sharpen-${Date.now()}`;
/** How long to wait for a worker to claim the job and answer. */
const PATIENCE_MS = 180_000;

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra);
  }
};

/** The message a rejected call came back with, or null if it did not reject. */
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error) => error.message,
  );

const org = await prisma.organisation.create({
  data: { name: "ZZ Clause Sharpening", slug: TAG },
});
const user = await prisma.user.create({
  // Better Auth owns this table and supplies its ids, so one is given here.
  data: {
    id: `${TAG}-user`,
    name: "ZZ Approver",
    email: `${TAG}@test.invalid`,
    company: "ZZ",
    country: "CA",
    phone: "+10000000000",
  },
  select: { id: true },
});
const membership = { userId: user.id, organisationId: org.id };
await prisma.membership.create({ data: { ...membership, role: OWNER } });

const asRole = (role: string) =>
  prisma.membership.update({
    where: { userId_organisationId: membership },
    data: { role },
  });

try {
  // A standard with the shape this whole feature exists for: a statement that
  // sounds binding and requirements too thin to judge anything against.
  const standard = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "reference",
      title: "ZZ Data Standards",
      storageKey: `${TAG}/std`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
  const section = await prisma.documentSection.create({
    data: {
      documentId: standard.id,
      ordinal: 1,
      numberText: "9.3",
      title: "Resilience and idempotency",
      headingPath: "ZZ Data Standards › 9 Integration › 9.3 Resilience and idempotency",
      depth: 3,
      pageStart: 9,
    },
    select: { id: true },
  });
  const clause = await prisma.clause.create({
    data: {
      sectionId: section.id,
      ordinal: 1,
      title: "Resilience and idempotency",
      statement: "Integrations must handle failure without losing data.",
      rationale: "A dropped message is an invisible outage.",
      requirements: ["Retries must be bounded and use exponential backoff."],
      pageStart: 9,
    },
  });
  const framework = await prisma.framework.create({
    data: {
      organisationId: org.id,
      name: "Standards",
      version: 1,
      documents: { create: [{ documentId: standard.id, sortOrder: 0 }] },
    },
    select: { id: true },
  });

  const design = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "assessed",
      title: "ZZ Field Telemetry Ingestion SAD",
      storageKey: `${TAG}/design`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
  const run = await prisma.assessmentRun.create({
    data: {
      organisationId: org.id,
      documentId: design.id,
      frameworkId: framework.id,
      state: "complete",
      totalClauses: 1,
      completedClauses: 1,
      model: "zz",
      completedAt: new Date(),
    },
    select: { id: true },
  });
  const finding = await prisma.finding.create({
    data: {
      runId: run.id,
      clauseId: clause.id,
      clauseRef: "9.3",
      clauseTitle: "Resilience and idempotency",
      clauseStatement: clause.statement,
      verdict: "partial",
      confidence: 0.82,
      rationale:
        "The design bounds its retries, but says nothing about where a message goes " +
        "once its retries are exhausted — they are dropped.",
      evidence: [
        {
          chunkId: `${TAG}-chunk`,
          headingPath: "ZZ Field Telemetry Ingestion SAD › 4.2 Message Handling",
          page: 4,
          excerpt:
            "The ingestion service retries failed messages three times with exponential " +
            "backoff, after which they are dropped.",
        },
      ],
      retrievalScore: 0.71,
      reviewerState: "confirmed",
      reviewedAt: new Date(),
    },
    select: { id: true },
  });

  console.log("\nWhat is refused before a model is paid for anything");

  // The feature rests entirely on a person having agreed with the verdict.
  await prisma.finding.update({
    where: { id: finding.id },
    data: { reviewerState: "pending", reviewedAt: null },
  });
  ok(
    "an unconfirmed partial is refused",
    (await refusal(requestDraft(user.id, finding.id, "ZZ")))?.includes("Confirm this verdict") ===
      true,
  );

  // An override says the verdict was wrong; sharpening from one would write the
  // model's mistake into the library.
  await prisma.finding.update({
    where: { id: finding.id },
    data: { reviewerState: "overridden", reviewerVerdict: "covered", reviewedAt: new Date() },
  });
  ok(
    "an overridden one is refused too",
    (await refusal(requestDraft(user.id, finding.id, "ZZ")))?.includes("Confirm this verdict") ===
      true,
  );
  await prisma.finding.update({
    where: { id: finding.id },
    data: { reviewerState: "confirmed", reviewerVerdict: null },
  });

  await asRole(MEMBER);
  ok(
    "a member cannot change the standards",
    (await refusal(requestDraft(user.id, finding.id, "ZZ")))?.includes("Only an administrator") ===
      true,
  );
  await asRole(OWNER);

  console.log("\nThe worker writes the lines");

  const asked = await requestDraft(user.id, finding.id, "ZZ Approver");
  ok("a draft is queued", asked.state === "drafting", asked);
  ok("asking twice does not queue a second model call", (await requestDraft(user.id, finding.id, "ZZ Approver")).id === asked.id);
  ok(
    "exactly one job was enqueued",
    (await prisma.job.count({ where: { organisationId: org.id, stage: "analyse" } })) === 1,
  );

  // A worker polls for its work, so this is a wait rather than a call.
  let state = "drafting";
  const deadline = Date.now() + PATIENCE_MS;
  while (state === "drafting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    state =
      (await prisma.clauseDraft.findUnique({ where: { id: asked.id }, select: { state: true } }))
        ?.state ?? "gone";
  }

  const draft = (await draftsForRun(run.id)).get(finding.id);
  ok("the worker finished it", state === "ready", { state, error: draft?.error });
  if (!draft || draft.state !== "ready") {
    throw new Error(
      `the draft never became ready (${state}). A live analyse worker and a model key are needed: ${draft?.error ?? ""}`,
    );
  }
  console.log(`       model: ${draft.model}`);
  console.log(`       note:  ${draft.note}`);
  for (const line of draft.requirements) console.log(`       + ${line}`);
  for (const line of draft.setAside) console.log(`       - ${line.text} [${line.reason}]`);

  ok("it proposed at least one requirement", draft.requirements.length > 0);
  ok(
    "every line is written as a requirement",
    draft.requirements.every((line) => /\b(must|shall)\b/i.test(line)),
    draft.requirements,
  );
  ok(
    "and none of them names the design",
    draft.requirements.every((line) => !/Field Telemetry/i.test(line)),
    draft.requirements,
  );
  ok("the clause's existing line came back to read it against", draft.existing.length === 1);

  console.log("\nApproving it replaces the clause rather than rewriting it");

  const approved = draft.requirements;
  const { clauseId: sharper, added } = await applyDraft(user.id, draft.id, approved, "ZZ Approver");
  ok("the approval reports what it added", added === approved.length, added);

  const before = await prisma.clause.findUnique({ where: { id: clause.id } });
  const after = await prisma.clause.findUnique({ where: { id: sharper } });

  // The reason this is a new row and not an UPDATE: `finding` denormalises a
  // clause's statement but not its requirements, so an in-place rewrite would
  // leave this report standing against requirements that exist nowhere.
  ok("the old clause still exists", before !== null);
  ok("with the requirements it was judged against", before?.requirements.length === 1, before?.requirements);
  ok("it keeps its ordinal", before?.ordinal === 1, before?.ordinal);
  ok("and points at its replacement", before?.supersededById === sharper);

  ok("the new one carries the old lines and the new", after?.requirements.length === 1 + approved.length, after?.requirements);
  ok("the statement is untouched", after?.statement === clause.statement);
  ok("the rationale is untouched", after?.rationale === clause.rationale);
  ok("it is marked as authored", after?.origin === "authored", after?.origin);
  ok("it says who approved it", after?.authoredByName === "ZZ Approver");
  ok("and which finding it came from", after?.sourceFindingId === finding.id);
  ok("it is the live one", after?.supersededById === null);
  ok("appended in reading order, as a restored rule is", after?.ordinal === 2, after?.ordinal);
  ok(
    "its provenance names the clause it sharpened",
    (after?.sourceRefs as Record<string, unknown> | null)?.sharpenedFrom === clause.id,
    after?.sourceRefs,
  );

  const closed = await prisma.clauseDraft.findUnique({ where: { id: draft.id } });
  ok("the draft is closed", closed?.state === "applied", closed?.state);
  ok("and points at the clause it made", closed?.appliedClauseId === sharper);

  console.log("\nFrom now on only the live clause is judged");

  ok("the framework counts one clause, not two", (await countClauses(framework.id)) === 1);

  // The worker's own query, so a drift between the two would show up here.
  const judged = await prisma.$queryRawUnsafe<{ id: string; requirements: string[] }[]>(
    `SELECT cl."id", cl."requirements"
       FROM "framework_document" fd
       JOIN "document" d ON d."id" = fd."documentId"
       JOIN "document_section" s ON s."documentId" = d."id"
       JOIN "clause" cl ON cl."sectionId" = s."id"
      WHERE fd."frameworkId" = $1 AND cl."supersededById" IS NULL`,
    framework.id,
  );
  ok("the framework's clause list returns only it", judged.length === 1 && judged[0]?.id === sharper, judged.map((row) => row.id));
  ok("with the sharper requirements", judged[0]?.requirements.length === 1 + approved.length);
  ok(
    "and the report stops offering the proposal",
    (await draftsForRun(run.id)).get(finding.id)?.state === "applied",
  );

  console.log("\nThe constraints hold");

  ok(
    "approving twice is refused",
    (await refusal(applyDraft(user.id, draft.id, approved, "ZZ")))?.includes("already been added") === true,
  );
  ok(
    "and a superseded clause cannot be sharpened again",
    (await refusal(requestDraft(user.id, finding.id, "ZZ")))?.includes("already been replaced") === true,
  );

  // The partial unique index. Prisma cannot express it, so this is the only
  // thing that proves it exists at all.
  const collided = await prisma.clause
    .create({ data: { sectionId: section.id, ordinal: 2, statement: "a second live clause" } })
    .then(
      () => null,
      (error: { code?: string }) => error.code ?? "threw",
    );
  ok("one live clause per ordinal, enforced by Postgres", collided === "23505" || collided === "P2002", collided);

  // And the half that makes it partial rather than plain: the ordinal a retired
  // clause sits on is free for a live one again, so a re-parse can reuse it.
  const reused = await prisma.clause
    .create({ data: { sectionId: section.id, ordinal: 1, statement: "reuses a retired ordinal" } })
    .then((row) => row.id, () => null);
  ok("but a retired clause's ordinal is free again", reused !== null);
  if (reused) await prisma.clause.delete({ where: { id: reused } });
} finally {
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: `${TAG}@test.invalid` } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
