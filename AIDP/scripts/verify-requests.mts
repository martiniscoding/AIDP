/**
 * The bridge: an intake form becomes a document the engine assesses.
 *
 * Checked against the real database and the real upload door, because what is
 * being tested is precisely that the new layer meets the old one correctly —
 * a mock of `record()` would prove only that this file agrees with itself.
 *
 * Everything happens inside a throwaway organisation, and the sweep is scoped to
 * it, so this never reaches a customer's rows.
 *
 * **It also deletes every job it causes, the moment it has checked that the job
 * was created.** A worker is running against this database, and it claims by
 * stage rather than by organisation — it cannot tell a test's document from a
 * customer's. Left in the queue, the parse job would be picked up and the
 * analyse job would start a real assessment: a hundred model calls, billed, on
 * a document written by this file. The queue rows are the assertion; nothing
 * here needs them to survive it.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-requests.mts
 */
import { prisma } from "../src/lib/prisma";
import { remove } from "../src/lib/ingest/storage";
import type { Access } from "../src/lib/access/gate";
import {
  CHECKING,
  DRAFT,
  FAILED,
  RequestRefused,
  SUBMITTED,
  advanceSubmitted,
  createRequest,
  submitRequest,
  whatIsMissing,
} from "../src/lib/ingest/requests";

const TAG = `zz-req-${Date.now()}`;

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const org = await prisma.organisation.create({
  data: { name: "ZZ Requests", slug: TAG },
});
const user = await prisma.user.create({
  data: {
    id: `${TAG}-user`,
    name: "A. Requestor",
    email: `${TAG}@test.invalid`,
    company: "ZZ Requests",
    country: "GB",
    phone: "",
  },
});
const access = {
  user: { id: user.id, name: user.name, email: user.email },
  organisation: { id: org.id },
} as Access;

/** Everything a submission needs, so a test can say what it is *removing*. */
const COMPLETE = {
  plannedStart: new Date("2028-03-01"),
  problemStatement: "The current portal runs on an unsupported framework.",
  solutionOverview:
    "A React application served by a Node API, backed by PostgreSQL. Sessions are held in application memory.",
  technologies: ["React", "PostgreSQL 11"],
  integrationPoints: "The portal calls the billing system over a REST API.",
  authMechanism: "Username and password, with no second factor for administrators.",
  dataStores: "PostgreSQL holds customer profiles.",
  dataClassification: "Confidential",
  hostingEnvironment: "On-premises VMware cluster.",
};


/**
 * A design that is already indexed, built directly rather than by submitting.
 *
 * The sweep is what these checks are about, and the sweep reads two things: the
 * request's `documentId` and whether that document is ready with chunks. Going
 * through `submitRequest` to arrive there would put a real parse job in the
 * queue, and a worker is running against this database — it claims by stage and
 * cannot tell a test's document from a customer's. It would take the job,
 * overwrite the status this test just set, and bill for the chunk stage's model
 * calls on the way. So the sweep's fixtures never enter the queue at all.
 *
 * `submitRequest` is still exercised for real, in "The bridge" above, where
 * what is being checked is the document it creates rather than what a worker
 * does with it.
 */
async function indexedDesign(
  projectId: string,
  reference: string,
): Promise<string> {
  const document = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId,
      role: "assessed",
      uploadedById: user.id,
      title: `${reference} Rendered intake`,
      storageKey: `${TAG}/${reference}.docx`,
      byteSize: 1,
      sha256: `${TAG}-${reference}`,
      status: "ready",
    },
    select: { id: true },
  });
  await prisma.chunk.create({
    data: {
      organisationId: org.id,
      documentId: document.id,
      sourceKind: "section",
      ordinal: 0,
      headingPath: `${reference} › 3 Solution Overview`,
      text: "Sessions are held in application memory.",
      contentHash: `${TAG}-${reference}-chunk`,
    },
  });
  return document.id;
}

try {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });

  // --- references ---------------------------------------------------------
  console.log("\nReferences");

  const first = await createRequest(access, { projectId: project.id, title: "Portal Upgrade" });
  const second = await createRequest(access, { projectId: project.id, title: "Portal Upgrade" });
  ok("the first request is AR-0001", first.reference === "AR-0001", first.reference);
  ok("the second is AR-0002", second.reference === "AR-0002", second.reference);
  ok("two requests may share a title", first.id !== second.id);

  // --- what a submission has to carry -------------------------------------
  console.log("\nWhat a submission has to carry");

  const bare = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: first.id } });
  const renderable = { ...bare, estimatedCost: null };
  const missing = whatIsMissing(renderable);
  ok("a bare draft is not submittable", missing.length > 0);
  ok(
    "and it says the solution overview is missing",
    missing.some((m) => m.includes("solution overview")),
    missing.join("; "),
  );
  ok(
    "and every Group C field, because there is no diagram",
    missing.some((m) => m.includes("authentication")) &&
      missing.some((m) => m.includes("hosting")),
    missing.join("; "),
  );

  // The brief's one piece of conditional logic: a diagram stands in for the
  // whole of Group C.
  const withDiagram = whatIsMissing({
    ...renderable,
    ...COMPLETE,
    technologies: [],
    authMechanism: "",
    dataStores: "",
    dataClassification: "",
    hostingEnvironment: "",
    integrationPoints: "",
    diagramDocumentId: "some-diagram-id",
  });
  ok("a diagram excuses Group C", withDiagram.length === 0, withDiagram.join("; "));

  let refused = "";
  try {
    await submitRequest(access, first.id);
  } catch (error) {
    if (error instanceof RequestRefused) refused = error.message;
  }
  ok("submitting an incomplete request is refused", refused !== "");
  ok("and the refusal names what is missing", refused.includes("solution overview"), refused);

  // --- the bridge ----------------------------------------------------------
  console.log("\nThe bridge");

  await prisma.architectureRequest.update({ where: { id: first.id }, data: COMPLETE });
  const submitted = await submitRequest(access, first.id);

  const document = await prisma.document.findUniqueOrThrow({
    where: { id: submitted.documentId },
    include: { jobs: true },
  });
  ok("a document is created", Boolean(document.id));
  ok("it is a design, not a standard", document.role === "assessed", document.role);
  ok("it is in the request's project", document.projectId === project.id);
  ok("it is attributed to the requestor", document.uploadedById === user.id);
  ok("it is a Word document", document.mimeType.includes("wordprocessingml"));
  // "AR 0001 ...", not "AR-0001 ...": `record()` normalises separators when it
  // derives a title from a filename, and the parse stage replaces this with the
  // document's own Title paragraph later. `findRendered` looks for both forms,
  // which is the whole reason this is pinned down here.
  ok("its title carries the reference", document.title.startsWith("AR 0001 "), document.title);
  ok("and the pipeline has been queued", document.jobs.some((j) => j.stage === "parse"));

  // Checked, and now removed before a worker claims it. See the note at the top.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  const afterSubmit = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: first.id },
  });
  ok("the request is submitted", afterSubmit.state === SUBMITTED, afterSubmit.state);
  ok("and carries the moment it was filed", afterSubmit.submittedAt !== null);

  // --- idempotency ---------------------------------------------------------
  console.log("\nSubmitting twice");

  const again = await submitRequest(access, first.id);
  ok("the same document comes back", again.documentId === submitted.documentId);
  const designs = await prisma.document.count({
    where: { projectId: project.id, role: "assessed" },
  });
  ok("and no second design is created", designs === 1, `got ${designs}`);

  // The crash this is really defending against: the document was recorded and
  // the link was never written. The next attempt must adopt it rather than
  // render a second copy for the assessment to read twice.
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { documentId: null, state: SUBMITTED },
  });
  const recovered = await submitRequest(access, first.id);
  ok("an unlinked earlier document is adopted", recovered.documentId === submitted.documentId);
  const stillOne = await prisma.document.count({
    where: { projectId: project.id, role: "assessed" },
  });
  ok("and still no second design", stillOne === 1, `got ${stillOne}`);

  // --- the sweep -----------------------------------------------------------
  console.log("\nThe sweep, while the document is still indexing");

  const indexing = await advanceSubmitted({ organisationId: org.id });
  ok("nothing is started", indexing.started === 0, JSON.stringify(indexing));
  ok("and the request is left waiting", indexing.waiting === 1, JSON.stringify(indexing));

  console.log("\nThe sweep, with no standards indexed");
  // Ready, with chunks, but the customer's library is empty. The run cannot be
  // opened and no amount of retrying changes that, so the request has to say so
  // rather than sit in "submitted" for ever.
  //
  // The submitted document is swapped for a fixture here, so that nothing in
  // the queue can move underneath these checks. See `indexedDesign`.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });
  const design = await indexedDesign(project.id, "AR-0001");
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { documentId: design },
  });

  const noStandards = await advanceSubmitted({ organisationId: org.id });
  ok("the request is failed", noStandards.failed === 1, JSON.stringify(noStandards));
  const stopped = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: first.id } });
  ok("in the failed state", stopped.state === FAILED, stopped.state);
  ok(
    "with a reason the requestor can act on",
    (stopped.failureReason ?? "").includes("reference standards"),
    String(stopped.failureReason),
  );

  console.log("\nThe sweep, with a standard indexed");
  const standard = await prisma.document.create({
    data: {
      organisationId: org.id,
      role: "reference",
      title: `${TAG} Security Standards`,
      storageKey: `${TAG}/standard`,
      byteSize: 1,
      sha256: `${TAG}-standard`,
      status: "ready",
    },
  });
  const section = await prisma.documentSection.create({
    data: {
      documentId: standard.id,
      ordinal: 0,
      numberText: "2.2",
      title: "Authentication",
      headingPath: "Security Standards › 2.2 Authentication",
    },
  });
  await prisma.clause.create({
    data: {
      sectionId: section.id,
      ordinal: 0,
      title: "Authentication",
      statement: "Administrative access must require multi-factor authentication.",
    },
  });

  // Back to submitted: the standards are there now, and a failed request is
  // allowed to be tried again.
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { state: SUBMITTED, failureReason: null },
  });

  const swept = await advanceSubmitted({ organisationId: org.id });
  ok("the assessment is started", swept.started === 1, JSON.stringify(swept));

  const running = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: first.id } });
  ok("the request is checking", running.state === CHECKING, running.state);
  ok("and carries its run", running.runId !== null);

  const run = await prisma.assessmentRun.findUniqueOrThrow({
    where: { id: running.runId! },
  });
  ok("the run is over the request's project", run.projectId === project.id);
  ok("it counted the clause", run.totalClauses === 1, String(run.totalClauses));
  const analyse = await prisma.job.count({
    where: { organisationId: org.id, stage: "analyse" },
  });
  ok("and an analyse job is queued", analyse === 1, `got ${analyse}`);

  // The expensive one. A worker claiming this would judge every clause of the
  // framework against the rendered document and bill for it.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  console.log("\nThe sweep is not repeated");
  const resweep = await advanceSubmitted({ organisationId: org.id });
  ok("a request already checking is left alone", resweep.started === 0, JSON.stringify(resweep));
  const runs = await prisma.assessmentRun.count({ where: { organisationId: org.id } });
  ok("and no second run is opened", runs === 1, `got ${runs}`);

  console.log("\nThe worker's push, scoped to one document");
  // What Workers/aidp/notify.py sends the moment a document lands ready. The
  // ordinary case is a design nobody filed a request for, and the answer has to
  // be "nothing to do" rather than a sweep of everything that happened to be
  // waiting.
  const strangerProject = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} hand-uploaded` },
  });
  const stranger = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId: strangerProject.id,
      role: "assessed",
      title: "Somebody's own design",
      storageKey: `${TAG}/stranger`,
      byteSize: 1,
      sha256: `${TAG}-stranger`,
      status: "ready",
    },
  });
  const pushed = await advanceSubmitted({ documentId: stranger.id });
  ok(
    "a document belonging to no request does nothing",
    pushed.started === 0 && pushed.waiting === 0 && pushed.failed === 0,
    JSON.stringify(pushed),
  );

  // And a push naming one request must not advance another's. A second request
  // is made ready here, then the push names the first one's document.
  // Its own project, deliberately. A project holds one live run at a time —
  // "assessment_run_live_project_idx" — and the first request's run is still
  // queued, so filing this one alongside it would be testing contention rather
  // than scoping. Contention gets its own check below.
  const secondProject = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} second project` },
  });
  const secondDesign = await indexedDesign(secondProject.id, "AR-0002");
  await prisma.architectureRequest.update({
    where: { id: second.id },
    data: { ...COMPLETE, state: SUBMITTED, projectId: secondProject.id, documentId: secondDesign },
  });

  const elsewhere = await advanceSubmitted({ documentId: stranger.id });
  ok(
    "a push for one document leaves another request waiting",
    elsewhere.started === 0,
    JSON.stringify(elsewhere),
  );
  const stillWaiting = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: second.id },
    select: { state: true, runId: true },
  });
  ok("which is still submitted", stillWaiting.state === SUBMITTED, stillWaiting.state);
  ok("with no run", stillWaiting.runId === null);

  // Now name its own document, and it goes.
  const itsOwn = await advanceSubmitted({ documentId: secondDesign });
  ok("naming its own document starts it", itsOwn.started === 1, JSON.stringify(itsOwn));
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  console.log("\nTwo requests against one project");
  // A project may hold one live run, and both earlier runs are still queued.
  // A third request filed against the first project therefore has to wait for
  // them rather than fail: its design will be judged by the next run over that
  // project. The failure this pins down is the opposite one — a submission
  // closed as "failed" because somebody else's assessment happened to be
  // running when it landed.
  const contending = await createRequest(access, {
    projectId: project.id,
    title: "Filed while another is running",
  });
  await prisma.architectureRequest.update({
    where: { id: contending.id },
    data: COMPLETE,
  });
  const contendingDesign = await indexedDesign(project.id, "AR-0003");
  await prisma.architectureRequest.update({
    where: { id: contending.id },
    data: { ...COMPLETE, state: SUBMITTED, documentId: contendingDesign },
  });

  const contended = await advanceSubmitted({ documentId: contendingDesign });
  ok("it waits rather than starting", contended.started === 0, JSON.stringify(contended));
  ok("and is not failed", contended.failed === 0, JSON.stringify(contended));
  const held = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: contending.id },
    select: { state: true, failureReason: true },
  });
  ok("the request is still submitted", held.state === SUBMITTED, held.state);
  ok("with nothing held against it", held.failureReason === null, String(held.failureReason));

  console.log("\nDrafts are untouched by all of this");
  const third = await createRequest(access, { projectId: project.id, title: "Never submitted" });
  await advanceSubmitted({ organisationId: org.id });
  const untouched = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: third.id } });
  ok("a draft is never swept", untouched.state === DRAFT, untouched.state);
  ok("and gets no document", untouched.documentId === null);
  ok("and the references kept counting", third.reference === "AR-0004", third.reference);
} finally {
  // Ordered, children first, rather than one cascading delete of the
  // organisation. Removing an organisation cascades into a dozen tables at
  // once and deadlocked against its own cascade on Neon; doing it in
  // dependency order is both faster and deterministic.
  //
  // The blobs go first, while the rows that name them still exist. This really
  // does reach the storage service — STORAGE_BACKEND decides which — and a test
  // that leaves files in a customer's bucket costs somebody money every run.
  const stored = await prisma.document.findMany({
    where: { organisationId: org.id },
    select: { storageKey: true },
  });
  const removed = await remove(stored.map((d) => d.storageKey)).catch(() => 0);
  console.log(`\n  cleaned up ${removed}/${stored.length} stored files`);

  await prisma.job.deleteMany({ where: { organisationId: org.id } });
  await prisma.chunk.deleteMany({ where: { organisationId: org.id } });
  await prisma.architectureRequest.deleteMany({ where: { organisationId: org.id } });
  await prisma.assessmentRun.deleteMany({ where: { organisationId: org.id } });
  await prisma.document.deleteMany({ where: { organisationId: org.id } });
  await prisma.framework.deleteMany({ where: { organisationId: org.id } });
  await prisma.project.deleteMany({ where: { organisationId: org.id } });
  await prisma.organisation.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: user.id } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
