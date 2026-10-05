/**
 * What the progress banner reads while a run is live.
 *
 * The banner used to move only because the page re-rendered on a four-second
 * timer, and that could not keep up with itself: the whole report was re-queried
 * to carry one number, so on a real run the clause count stuck on its first
 * clause until somebody reloaded. It now polls `readRunProgress` through
 * /api/runs/[id]/progress instead, so this is the half that has to be right —
 * that the reading moves as the worker does, that it finds the job for a project
 * run and for a design run, that it says so when nothing is working on the run
 * any more, and that it is not readable by someone outside the organisation.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-run-progress.mts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { OWNER } from "../src/lib/access/roles";
import type { Access } from "../src/lib/access/gate";
import { NotAMember } from "../src/lib/ingest/org";
import { readRunProgress } from "../src/lib/ingest/run-progress";
import { createProject, startProjectRun } from "../src/lib/ingest/projects";

const TAG = `zz-progress-${Date.now()}`;

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

const org = await prisma.organisation.create({
  data: { name: "ZZ Progress", slug: TAG },
});
const user = await prisma.user.create({
  // Better Auth owns this table and supplies its ids, so one is given here.
  data: {
    id: `${TAG}-user`,
    name: "ZZ",
    email: `${TAG}@test.invalid`,
    company: "ZZ",
    country: "CA",
    phone: "+10000000000",
  },
  select: { id: true, name: true, email: true, company: true, isPlatformAdmin: true },
});
// `readRunProgress` is reached by URL, so it checks membership itself rather
// than trusting a caller's `Access`. Without this row it would refuse its own
// organisation's run.
await prisma.membership.create({
  data: { organisationId: org.id, userId: user.id, role: OWNER },
});
const access: Access = {
  user,
  organisation: { id: org.id, name: org.name, slug: TAG, role: OWNER },
  role: OWNER,
  isOwner: true,
};

async function design(projectId: string, title: string) {
  const document = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId,
      role: "assessed",
      title,
      storageKey: `${TAG}/${title}`,
      byteSize: 10,
      sha256: randomUUID(),
      status: "ready",
    },
    select: { id: true },
  });
  await prisma.chunk.create({
    data: {
      organisationId: org.id,
      documentId: document.id,
      sourceKind: "section",
      ordinal: 1,
      headingPath: "A section",
      text: "Orders are stored in PostgreSQL.",
      tokenCount: 6,
      contentHash: randomUUID(),
    },
  });
  return document.id;
}

try {
  const project = await createProject(access, { name: "Customer Portal" });
  const standard = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "reference",
      title: "Data Standards",
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
      title: "9 Data",
      headingPath: "9 Data",
      pageStart: 1,
      pageEnd: 1,
    },
    select: { id: true },
  });
  await prisma.clause.create({
    data: {
      sectionId: section.id,
      ordinal: 1,
      title: "9.3 Retention",
      statement: "Records are kept for a stated period.",
    },
  });
  const docA = await design(project.id, "Proposal");
  await design(project.id, "Architecture");

  console.log("\nA project run, waiting for a worker");
  const started = await startProjectRun(access, project.id);
  const queued = await readRunProgress(user.id, started.runId);
  ok("it is queued", queued?.state === "queued", queued);
  ok(
    "its job is found by the run on the payload, not by a document it has not got",
    queued?.job?.state === "queued",
    queued?.job,
  );
  ok("so it is not reported as abandoned", queued?.orphaned === false, queued);

  console.log("\nThe worker gets to work");
  // What `_start` and `_progress` in Workers/aidp/stages/analyse.py write: the
  // run turns running with a total, then one UPDATE per clause. This is the
  // reading the banner exists to show, and the one that used to stand still.
  await prisma.job.updateMany({
    where: { stage: "analyse", payload: { path: ["runId"], equals: started.runId } },
    data: { state: "leased", leaseUntil: new Date(Date.now() + 900_000) },
  });
  await prisma.assessmentRun.update({
    where: { id: started.runId },
    data: { state: "running", totalClauses: 14, completedClauses: 1 },
  });
  const first = await readRunProgress(user.id, started.runId);
  ok("the first clause shows", first?.completedClauses === 1 && first?.totalClauses === 14, first);
  ok("and a leased job still counts as being worked on", first?.orphaned === false, first);

  await prisma.assessmentRun.update({
    where: { id: started.runId },
    data: { completedClauses: 2 },
  });
  const second = await readRunProgress(user.id, started.runId);
  ok("the second clause shows without anything else changing", second?.completedClauses === 2, second);

  console.log("\nNothing is working on it any more");
  await prisma.job.deleteMany({
    where: { stage: "analyse", payload: { path: ["runId"], equals: started.runId } },
  });
  const abandoned = await readRunProgress(user.id, started.runId);
  ok("a live run with no job reads as abandoned", abandoned?.orphaned === true, abandoned);
  ok("and offers no job to describe", abandoned?.job === null, abandoned);
  // The banner refreshes the page on this, so the run's own panel can offer
  // another — which is why it has to be reported rather than left looking busy.

  console.log("\nFinished");
  await prisma.assessmentRun.update({
    where: { id: started.runId },
    data: { state: "complete", completedClauses: 14, completedAt: new Date() },
  });
  const done = await readRunProgress(user.id, started.runId);
  ok("it reads complete", done?.state === "complete" && done?.completedClauses === 14, done);
  ok(
    "with no job looked for and nothing called abandoned",
    done?.job === null && done?.orphaned === false,
    done,
  );

  console.log("\nA design run, whose job is its document's");
  const framework = await prisma.framework.findFirstOrThrow({
    where: { organisationId: org.id },
    select: { id: true },
  });
  const designRun = await prisma.assessmentRun.create({
    data: {
      id: `${TAG}-design`,
      organisationId: org.id,
      documentId: docA,
      frameworkId: framework.id,
      state: "running",
      totalClauses: 14,
      completedClauses: 3,
    },
    select: { id: true },
  });
  await prisma.job.create({
    data: {
      organisationId: org.id,
      documentId: docA,
      stage: "analyse",
      correlationId: randomUUID(),
      state: "leased",
      leaseUntil: new Date(Date.now() + 900_000),
      payload: {},
    },
  });
  const byDocument = await readRunProgress(user.id, designRun.id);
  ok("its progress reads", byDocument?.completedClauses === 3, byDocument);
  ok(
    "and its job is found by the document, with no run id on the payload",
    byDocument?.job?.state === "running" && byDocument?.orphaned === false,
    byDocument,
  );

  console.log("\nNot readable from outside the organisation");
  const outsider = await prisma.user.create({
    data: {
      id: `${TAG}-outsider`,
      name: "ZZ Outsider",
      email: `${TAG}-outsider@test.invalid`,
      company: "ZZ",
      country: "CA",
      phone: "+10000000001",
    },
    select: { id: true },
  });
  const refused = await readRunProgress(outsider.id, designRun.id).then(
    () => null,
    (error: unknown) => error,
  );
  ok("a non-member is refused", refused instanceof NotAMember, refused);
  // The route turns that into a 404, not a 403: a run in someone else's
  // organisation is indistinguishable from one that does not exist.

  ok("and a run that does not exist reads as nothing", (await readRunProgress(user.id, `${TAG}-nope`)) === null);
} finally {
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.assessmentRun.deleteMany({ where: { id: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
