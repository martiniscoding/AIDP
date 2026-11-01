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
  READY,
  RequestRefused,
  SUBMITTED,
  advanceSubmitted,
  createRequest,
  startAssessment,
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

/**
 * The project a request opened for itself.
 *
 * Never shown to anybody, and the scope every assessment of that request runs
 * over: an `AssessmentRun` names a project, not a request. Read back off the
 * row rather than created here, because the thing most of what follows is
 * about is that `createRequest` makes one — see its note for why it must.
 */
async function projectOf(requestId: string): Promise<string> {
  const row = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { projectId: true },
  });
  return row.projectId;
}

try {
  // --- references ---------------------------------------------------------
  console.log("\nReferences");

  const first = await createRequest(access, { title: "Portal Upgrade" });
  const second = await createRequest(access, { title: "Portal Upgrade" });
  ok("the first request is AR-0001", first.reference === "AR-0001", first.reference);
  ok("the second is AR-0002", second.reference === "AR-0002", second.reference);
  ok("two requests may share a title", first.id !== second.id);

  // --- the project a request keeps to itself -------------------------------
  console.log("\nThe project a request keeps to itself");

  const project = await projectOf(first.id);
  const secondProject = await projectOf(second.id);
  ok("a request opens with a project of its own", project !== "");
  ok("and no two requests share one", project !== secondProject);

  const named = await prisma.project.findUniqueOrThrow({ where: { id: project } });
  // The reference, not the title alone: `Project` is unique on name per
  // customer and both requests above are called "Portal Upgrade". Without the
  // reference in it the second would have collided, which is the whole reason
  // the name is built this way.
  ok("its name carries the reference", named.name.startsWith("AR-0001 "), named.name);
  ok("and the title, so it can be recognised", named.name.includes("Portal Upgrade"), named.name);
  ok("it is attributed to the requestor", named.createdById === user.id);
  // Not "alternatives": the designs in one request describe a single solution
  // between them, rather than rival candidates to be judged against each other.
  ok(
    "its designs are read as one solution",
    named.designRelationship === "components",
    named.designRelationship,
  );

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
  ok("it is in the request's project", document.projectId === project);
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
    where: { projectId: project, role: "assessed" },
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
    where: { projectId: project, role: "assessed" },
  });
  ok("and still no second design", stillOne === 1, `got ${stillOne}`);

  // --- the sweep -----------------------------------------------------------
  console.log("\nThe sweep, while the document is still indexing");

  const indexing = await advanceSubmitted({ organisationId: org.id });
  ok("nothing is made ready", indexing.ready === 0, JSON.stringify(indexing));
  ok("and the request is left waiting", indexing.waiting === 1, JSON.stringify(indexing));

  // From here the sweep's fixtures stand in for the real thing, so the document
  // `submitRequest` really rendered goes. Its parse job was deleted above, so it
  // would sit at "pending" for ever — and the sweep will not call a request
  // ready while any of its documents is still unread, which is exactly the rule
  // being relied on later.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });
  // Its blob goes with it. The cleanup at the end collects storage keys from
  // the rows that still exist, so a row deleted here would leave its file
  // behind in the bucket — paid for, every run.
  const rendered = await prisma.document.findUniqueOrThrow({
    where: { id: submitted.documentId },
    select: { storageKey: true },
  });
  await remove([rendered.storageKey]).catch(() => 0);
  await prisma.chunk.deleteMany({ where: { documentId: submitted.documentId } });
  await prisma.document.delete({ where: { id: submitted.documentId } });

  const design = await indexedDesign(project, "AR-0001");
  await prisma.architectureRequest.update({
    where: { id: first.id },
    data: { documentId: design },
  });

  console.log("\nThe sweep, once the document is in");

  const swept = await advanceSubmitted({ organisationId: org.id });
  ok("the request is made ready", swept.ready === 1, JSON.stringify(swept));
  const readied = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: first.id } });
  ok("it is in the ready state", readied.state === READY, readied.state);
  // The sweep's whole job now. It used to open the run itself; a person does
  // that, so until they do there must be no run and nothing for a worker.
  ok("with no run against it yet", readied.runId === null);
  const nothingQueued = await prisma.job.count({
    where: { organisationId: org.id, stage: "analyse" },
  });
  ok("and nothing queued for a worker", nothingQueued === 0, `got ${nothingQueued}`);

  console.log("\nThe sweep does not repeat itself");
  const resweep = await advanceSubmitted({ organisationId: org.id });
  ok("a request already ready is left alone", resweep.ready === 0, JSON.stringify(resweep));

  // --- pressing it ---------------------------------------------------------
  console.log("\nStarting the assessment, with no standards indexed");

  // Ready, with chunks, but the customer's library is empty. This used to fail
  // the request outright, which was the only option while the run opened itself
  // with nobody watching. Somebody is standing here now, so they are told — and
  // the request stays where it is, so the same press works once the standards
  // are in. A submission must not be closed over a library its requestor may
  // not even be allowed to fill.
  let noStandards = "";
  try {
    await startAssessment(access, first.id);
  } catch (error) {
    if (error instanceof RequestRefused) noStandards = error.message;
  }
  ok("the press is refused", noStandards !== "", noStandards);
  ok("and says what is missing", noStandards.includes("reference standards"), noStandards);
  const survived = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: first.id },
  });
  ok("the request is not failed", survived.state === READY, survived.state);
  ok(
    "and nothing is held against it",
    survived.failureReason === null,
    String(survived.failureReason),
  );

  console.log("\nStarting the assessment, with a standard indexed");
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

  const opened = await startAssessment(access, first.id);
  ok("it opens a run", opened.runId !== "", opened.runId);
  ok("and says what it is assessing", opened.scope.includes("1 design"), opened.scope);

  const running = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: first.id } });
  ok("the request is checking", running.state === CHECKING, running.state);
  ok("and carries its run", running.runId !== null);

  const run = await prisma.assessmentRun.findUniqueOrThrow({
    where: { id: running.runId! },
  });
  ok("the run is over the request's own project", run.projectId === project);
  ok("it counted the clause", run.totalClauses === 1, String(run.totalClauses));
  const analyse = await prisma.job.count({
    where: { organisationId: org.id, stage: "analyse" },
  });
  ok("and an analyse job is queued", analyse === 1, `got ${analyse}`);

  // The expensive one. A worker claiming this would judge every clause of the
  // framework against the rendered document and bill for it.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  console.log("\nPressing it a second time");
  let twice = "";
  try {
    await startAssessment(access, first.id);
  } catch (error) {
    if (error instanceof RequestRefused) twice = error.message;
  }
  ok("the second press is refused", twice !== "", twice);
  ok("and points at the report instead", twice.includes("report"), twice);
  const runCount = await prisma.assessmentRun.count({ where: { organisationId: org.id } });
  ok("no second run is opened", runCount === 1, `got ${runCount}`);

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
    pushed.ready === 0 && pushed.waiting === 0 && pushed.failed === 0,
    JSON.stringify(pushed),
  );

  // And a push naming one document must not advance another request. The second
  // request is made submittable here, with its own indexed design, and then the
  // push names the stranger's document instead.
  const secondDesign = await indexedDesign(secondProject, "AR-0002");
  await prisma.architectureRequest.update({
    where: { id: second.id },
    data: { ...COMPLETE, state: SUBMITTED, documentId: secondDesign },
  });

  const elsewhere = await advanceSubmitted({ documentId: stranger.id });
  ok(
    "a push for one document leaves another request waiting",
    elsewhere.ready === 0,
    JSON.stringify(elsewhere),
  );
  const stillWaiting = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: second.id },
    select: { state: true, runId: true },
  });
  ok("which is still submitted", stillWaiting.state === SUBMITTED, stillWaiting.state);
  ok("with no run", stillWaiting.runId === null);

  // Now name its own document, and it is made ready — still not assessed.
  const itsOwn = await advanceSubmitted({ documentId: secondDesign });
  ok("naming its own document readies it", itsOwn.ready === 1, JSON.stringify(itsOwn));

  console.log("\nTwo requests sharing one project");
  // This can no longer arise through `createRequest`: every request opens a
  // project of its own, so two of them never contend for the single live-run
  // slot a project has ("assessment_run_live_project_idx"). The invariant is
  // pinned down anyway, by putting a second request onto the first one's
  // project by hand — because what it guards against is severe and silent: a
  // submission closed as "failed" because somebody else's assessment happened
  // to be running when it landed. If projects are ever shared again, this is
  // the check that notices.
  const contending = await createRequest(access, { title: "Filed while another is running" });
  const contendingDesign = await indexedDesign(project, "AR-0003");
  await prisma.architectureRequest.update({
    where: { id: contending.id },
    data: { ...COMPLETE, state: READY, projectId: project, documentId: contendingDesign },
  });

  let contended = "";
  try {
    await startAssessment(access, contending.id);
  } catch (error) {
    if (error instanceof RequestRefused) contended = error.message;
  }
  ok("the press is refused rather than the request failed", contended !== "", contended);
  const held = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: contending.id },
    select: { state: true, failureReason: true },
  });
  ok("the request is still ready", held.state === READY, held.state);
  ok("with nothing held against it", held.failureReason === null, String(held.failureReason));

  console.log("\nDrafts are untouched by all of this");
  const third = await createRequest(access, { title: "Never submitted" });
  await advanceSubmitted({ organisationId: org.id });
  const untouched = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: third.id } });
  ok("a draft is never swept", untouched.state === DRAFT, untouched.state);
  ok("and gets no document", untouched.documentId === null);
  ok("and the references kept counting", third.reference === "AR-0004", third.reference);

  // Nor can a draft be assessed, and the refusal says what to do about it
  // rather than naming a state nobody outside this file has heard of.
  let draftPress = "";
  try {
    await startAssessment(access, third.id);
  } catch (error) {
    if (error instanceof RequestRefused) draftPress = error.message;
  }
  ok("pressing a draft is refused", draftPress !== "", draftPress);
  ok("and asks for it to be submitted first", draftPress.includes("submit"), draftPress);
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
