/**
 * Designs uploaded into a request, and the assessment somebody presses.
 *
 * A design used to be uploaded to a *project* from the library screens, and a
 * request was a form filed against the same project — two screens, two mental
 * models, and no way to tell from the request whether the thing it would be
 * judged on had been attached. The designs live inside the request now.
 *
 * The upload doors still store a design against a project, because that is what
 * a `Document` carries and what an assessment reads, so the id arriving from a
 * browser is a request's and something has to turn it into a project's.
 * `designTarget` is that something, and it is the only thing that is: this file
 * is mostly about what it refuses.
 *
 * It is checked against the real database rather than a mock, for the reason
 * verify-requests gives — what is being tested is that one layer meets another
 * correctly, and a mock would prove only that this file agrees with itself.
 *
 * **Every document here is a fixture, written straight into the table.** A
 * worker is running against this database and claims by stage, so it cannot
 * tell a test's document from a customer's; a fixture that never enters the
 * queue cannot be claimed, parsed, or billed for. The one job this file does
 * cause — the analyse job of the one assessment it starts — is deleted the
 * moment it has been counted.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-request-designs.mts
 */
import { prisma } from "../src/lib/prisma";
import type { Access } from "../src/lib/access/gate";
import { authorise } from "../src/lib/ingest/intake";
import { assessableDesigns } from "../src/lib/ingest/projects";
import {
  CHECKING,
  FAILED,
  READY,
  RequestRefused,
  SUBMITTED,
  advanceSubmitted,
  createRequest,
  designTarget,
  startAssessment,
} from "../src/lib/ingest/requests";

const TAG = `zz-designs-${Date.now()}`;

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

/** The error of a refusal, or "" when it was allowed. Both shapes come back
 *  from `designTarget` as data rather than as a throw, because its two callers
 *  are HTTP doors and a status is part of the answer. */
const refusal = (verdict: Awaited<ReturnType<typeof designTarget>>) =>
  "error" in verdict ? verdict.error : "";
const status = (verdict: Awaited<ReturnType<typeof designTarget>>) =>
  "error" in verdict ? verdict.status : 0;

const org = await prisma.organisation.create({
  data: { name: "ZZ Designs", slug: TAG },
});
const other = await prisma.organisation.create({
  data: { name: "ZZ Designs B", slug: `${TAG}-b` },
});

async function person(suffix: string, role?: string) {
  const user = await prisma.user.create({
    data: {
      id: `${TAG}-${suffix}`,
      name: `A. ${suffix}`,
      email: `${TAG}-${suffix}@test.invalid`,
      company: "ZZ Designs",
      country: "GB",
      phone: "",
    },
  });
  return {
    user,
    access: {
      user: { id: user.id, name: user.name, email: user.email },
      organisation: { id: org.id, ...(role ? { role } : {}) },
    } as Access,
  };
}

/**
 * A design already in the request's scope, built directly.
 *
 * `status` is the whole point of most of these: the readiness rules turn on
 * whether every document of a submission has finished indexing, and a fixture
 * is the only way to hold one half-way through without a worker moving it.
 */
async function design(
  projectId: string,
  name: string,
  state: "ready" | "failed" | "pending",
) {
  const document = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId,
      role: "assessed",
      title: name,
      storageKey: `${TAG}/${name}`,
      byteSize: 1,
      sha256: `${TAG}-${name}`,
      status: state,
    },
    select: { id: true },
  });
  if (state === "ready") {
    await prisma.chunk.create({
      data: {
        organisationId: org.id,
        documentId: document.id,
        sourceKind: "section",
        ordinal: 0,
        headingPath: `${name} › 1 Overview`,
        text: "The portal holds sessions in application memory.",
        contentHash: `${TAG}-${name}-chunk`,
      },
    });
  }
  return document.id;
}

const projectOf = async (id: string) =>
  (
    await prisma.architectureRequest.findUniqueOrThrow({
      where: { id },
      select: { projectId: true },
    })
  ).projectId;

const requestor = await person("requestor");
const colleague = await person("colleague");
const admin = await person("admin", "owner");

try {
  // --- where a design goes -------------------------------------------------
  console.log("\nWhere a design goes");

  const { id } = await createRequest(requestor.access, { title: "Portal Upgrade" });
  const project = await projectOf(id);

  const target = await designTarget(requestor.access, id);
  ok("a draft takes designs", refusal(target) === "", refusal(target));
  ok(
    "and they go to the project the request opened for itself",
    "projectId" in target && target.projectId === project,
    JSON.stringify(target),
  );

  // --- what it refuses -----------------------------------------------------
  console.log("\nWhat it refuses");

  const unknown = await designTarget(requestor.access, "no-such-request");
  ok("an id that is nothing is a 404", status(unknown) === 404, String(status(unknown)));

  // Another customer's request. Not a 403: saying "forbidden" would confirm it
  // exists, which is the one thing somebody guessing ids wants to learn.
  const theirs = await prisma.architectureRequest.create({
    data: {
      organisationId: other.id,
      reference: "AR-0001",
      projectId: (
        await prisma.project.create({
          data: { organisationId: other.id, name: `${TAG} theirs` },
        })
      ).id,
      title: "Not yours",
    },
    select: { id: true },
  });
  const crossTenant = await designTarget(requestor.access, theirs.id);
  ok(
    "another customer's request is a 404, not a 403",
    status(crossTenant) === 404,
    String(status(crossTenant)),
  );

  const notMine = await designTarget(colleague.access, id);
  ok("somebody else's draft is a 403", status(notMine) === 403, String(status(notMine)));
  ok(
    "and the refusal says who may",
    refusal(notMine).includes("raised this request"),
    refusal(notMine),
  );

  const byAdmin = await designTarget(admin.access, id);
  ok(
    "an administrator may add to it",
    "projectId" in byAdmin && byAdmin.projectId === project,
    refusal(byAdmin),
  );

  // --- once it has been submitted ------------------------------------------
  console.log("\nOnce it has been submitted");

  for (const state of [SUBMITTED, READY, CHECKING]) {
    await prisma.architectureRequest.update({ where: { id }, data: { state } });
    const closed = await designTarget(requestor.access, id);
    ok(`a request in "${state}" is a 409`, status(closed) === 409, String(status(closed)));
  }

  const closed = await designTarget(requestor.access, id);
  ok(
    "and says a changed design is a new request",
    refusal(closed).includes("new request"),
    refusal(closed),
  );

  // A failed request is editable again — it never reached a verdict, so there
  // is nothing yet for a late upload to contradict.
  await prisma.architectureRequest.update({ where: { id }, data: { state: FAILED } });
  const retry = await designTarget(requestor.access, id);
  ok("a failed request takes designs again", refusal(retry) === "", refusal(retry));

  // --- the door's other half -----------------------------------------------
  console.log("\nThe door's other half");

  // What both upload doors do with what comes back: `designTarget` resolves the
  // scope, `authorise` decides the role. Composed here because that composition
  // is the thing the doors are, and a door that called only one of them would
  // be the lenient one.
  const resolved = await designTarget(requestor.access, id);
  const asDesign = await authorise(
    requestor.access,
    "assessed",
    "projectId" in resolved ? resolved.projectId : "",
  );
  ok(
    "a design is accepted into the resolved project",
    !("error" in asDesign) && asDesign.projectId === project,
    JSON.stringify(asDesign),
  );

  // The same person, the same resolved project, asking to add a *standard* —
  // which is the administrator's to curate and not something a requestor gets
  // by way of their own request.
  const asStandard = await authorise(requestor.access, "reference", project);
  ok(
    "but a standard is not",
    "error" in asStandard && asStandard.status === 403,
    JSON.stringify(asStandard),
  );

  // --- what the assessment will read ---------------------------------------
  console.log("\nWhat the assessment will read");

  const rendered = await design(project, "AR-0001 Rendered intake", "ready");
  const uploaded = await design(project, "Portal diagram", "ready");
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: SUBMITTED, documentId: rendered },
  });

  const scope = await assessableDesigns(org.id, project);
  ok("both documents are in scope", scope.length === 2, String(scope.length));
  ok(
    "the uploaded design among them",
    scope.some((d) => d.id === uploaded),
    scope.map((d) => d.title).join("; "),
  );

  // --- a design still being read -------------------------------------------
  console.log("\nA design still being read");

  const slow = await design(project, "Sequence diagram", "pending");
  const held = await advanceSubmitted({ organisationId: org.id });
  ok("the request is not made ready", held.ready === 0, JSON.stringify(held));
  ok("it waits instead", held.waiting === 1, JSON.stringify(held));

  // The rule this protects. `startProjectRun` assesses what is ready and files
  // the rest under `unreadyDesignIds` — right for a project whose designs
  // arrive over days, a trap for a request whose documents were all uploaded
  // minutes ago as one submission. A run started here would have produced a
  // report that reads as complete and is not.
  await prisma.architectureRequest.update({ where: { id }, data: { state: READY } });
  let early = "";
  try {
    await startAssessment(requestor.access, id);
  } catch (error) {
    if (error instanceof RequestRefused) early = error.message;
  }
  ok("pressing it is refused", early !== "", early);
  ok("and says one document is still being read", early.includes("One of"), early);
  ok("rather than naming a count of none", !early.includes("0 of"), early);

  const notRun = await prisma.assessmentRun.count({ where: { organisationId: org.id } });
  ok("and no run was opened", notRun === 0, `got ${notRun}`);

  // --- a design that will never be read ------------------------------------
  console.log("\nA design that will never be read");

  // Failed is not "still being read": it will never be ready, and a request
  // whose every press is refused because one upload was corrupt would be
  // unassessable for ever. The run records it under `unreadyDesignIds`, which
  // is where a reader of the report finds out what was not read.
  await prisma.document.update({ where: { id: slow }, data: { status: "failed" } });

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

  // Somebody who is neither the requestor nor an administrator, before the
  // press that works — the refusal has to be about standing, not about state.
  let byStranger = "";
  try {
    await startAssessment(colleague.access, id);
  } catch (error) {
    if (error instanceof RequestRefused) byStranger = error.message;
  }
  ok("a colleague cannot start it", byStranger !== "", byStranger);
  ok(
    "and is told whose it is to start",
    byStranger.includes("raised this request"),
    byStranger,
  );

  const started = await startAssessment(requestor.access, id);
  ok("the requestor can", started.runId !== "", started.runId);
  ok("over the two designs that were read", started.scope.includes("2 designs"), started.scope);

  const run = await prisma.assessmentRun.findUniqueOrThrow({ where: { id: started.runId } });
  ok("the run names the request's own project", run.projectId === project);
  ok("it carries both readable designs", run.designIds.length === 2, run.designIds.join(","));
  ok(
    "and records the one it could not read",
    run.unreadyDesignIds.includes(slow),
    run.unreadyDesignIds.join(","),
  );

  // Counted, and now removed before a worker claims it: an analyse job would
  // judge every clause of the framework and bill for it.
  const analyse = await prisma.job.count({ where: { organisationId: org.id, stage: "analyse" } });
  ok("an analyse job was queued", analyse === 1, `got ${analyse}`);
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  const after = await prisma.architectureRequest.findUniqueOrThrow({ where: { id } });
  ok("and the request is checking", after.state === CHECKING, after.state);
} finally {
  // Children first, in dependency order. A cascading organisation delete
  // deadlocked against its own cascade on Neon; see verify-requests.
  //
  // No blobs to remove: every document here is a fixture with a storage key
  // that was never uploaded anywhere.
  for (const o of [org, other]) {
    await prisma.job.deleteMany({ where: { organisationId: o.id } });
    await prisma.chunk.deleteMany({ where: { organisationId: o.id } });
    await prisma.architectureRequest.deleteMany({ where: { organisationId: o.id } });
    await prisma.assessmentRun.deleteMany({ where: { organisationId: o.id } });
    await prisma.clause.deleteMany({
      where: { section: { document: { organisationId: o.id } } },
    });
    await prisma.documentSection.deleteMany({
      where: { document: { organisationId: o.id } },
    });
    await prisma.document.deleteMany({ where: { organisationId: o.id } });
    await prisma.framework.deleteMany({ where: { organisationId: o.id } });
    await prisma.project.deleteMany({ where: { organisationId: o.id } });
    await prisma.organisation.delete({ where: { id: o.id } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { id: { startsWith: TAG } } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
