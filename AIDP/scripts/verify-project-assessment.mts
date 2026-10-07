/**
 * A run over a whole project, from the app's side.
 *
 * The engine's half is Workers/tests/test_project_run.py. This is the half the
 * app owns: that a run names one scope and never both, that a project run's job
 * is found by the run on its payload rather than by a document it does not
 * have, that the project's report reads the run the project actually owns and
 * not one of its designs', and that a second run cannot be opened while one is
 * live. Against a throwaway organisation, removed at the end.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-project-assessment.mts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { OWNER } from "../src/lib/access/roles";
import { provisionAccount } from "../src/lib/access/provision";
import type { Access } from "../src/lib/access/gate";
import { runJobWhere } from "../src/lib/ingest/assessment";
import { readEvidence } from "../src/lib/ingest/verdicts";
import {
  ProjectRefused,
  assessableDesigns,
  createProject,
  latestProjectRun,
  startProjectRun,
} from "../src/lib/ingest/projects";

const TAG = `zz-projrun-${Date.now()}`;
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "a-throwaway-password";

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
  data: { name: "ZZ Project Run", slug: TAG },
});
// A real row: `createProject` records who opened it, by foreign key.
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
const access: Access = {
  user,
  organisation: { id: org.id, name: org.name, slug: TAG, role: OWNER },
  role: OWNER,
  isOwner: true,
};

/** A design in the project, as the pipeline would leave it. */
async function design(projectId: string, title: string, status: string, chunks: number) {
  const document = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId,
      role: "assessed",
      title,
      storageKey: `${TAG}/${title}`,
      byteSize: 10,
      sha256: randomUUID(),
      status,
    },
    select: { id: true },
  });
  for (let index = 0; index < chunks; index += 1) {
    await prisma.chunk.create({
      data: {
        organisationId: org.id,
        documentId: document.id,
        sourceKind: "section",
        ordinal: index + 1,
        headingPath: "A section",
        text: "Orders are stored in PostgreSQL.",
        tokenCount: 6,
        contentHash: randomUUID(),
      },
    });
  }
  return document.id;
}

try {
  console.log("\nA run names one scope, never both");
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

  const docA = await design(project.id, "Proposal", "ready", 2);
  const docB = await design(project.id, "Architecture", "ready", 1);
  const docC = await design(project.id, "Data Model", "chunking", 0);

  console.log("\nOpening one");
  const started = await startProjectRun(access, project.id);
  ok("it says what it covers", started.scope.startsWith("2 designs against 1 clause"), started.scope);

  const run = await prisma.assessmentRun.findUniqueOrThrow({
    where: { id: started.runId },
    select: { projectId: true, documentId: true, mode: true, state: true },
  });
  ok("the run names the project and no design", run.projectId === project.id && run.documentId === null, run);
  ok("by search, which is the only way several designs can be read", run.mode === "retrieval");

  const job = await prisma.job.findFirstOrThrow({
    where: { stage: "analyse", payload: { path: ["runId"], equals: started.runId } },
    select: { documentId: true, state: true, payload: true },
  });
  ok("its job has no document either", job.documentId === null, job);
  ok("and is queued for a worker", job.state === "queued");

  // Taken off the queue now that it has been asserted on. A live analyse worker
  // claims it within seconds otherwise and starts assessing this fixture for
  // real — paid model calls against two stub designs, and a foreign-key error
  // in the worker's log when the cleanup below removes the run underneath it.
  // The run stays live so the "one live run per project" check still bites.
  await prisma.job.deleteMany({
    where: { stage: "analyse", payload: { path: ["runId"], equals: started.runId } },
  });

  // Checked here rather than before the run, so this organisation's own
  // framework exists and is named by id — "the first framework in the table"
  // is whatever another test left behind.
  const ownFramework = await prisma.framework.findFirstOrThrow({
    where: { organisationId: org.id },
    select: { id: true },
  });
  const refusedByDb = async (columns: string, values: string) =>
    prisma
      .$executeRawUnsafe(
        `INSERT INTO "assessment_run" (id,"organisationId","frameworkId",state${columns})
         VALUES ('${TAG}-probe','${org.id}','${ownFramework.id}','queued'${values})`,
      )
      .then(() => false, () => true);
  ok("a run with no scope at all is refused by the database", await refusedByDb("", ""));
  ok(
    "and so is one claiming both",
    await refusedByDb(',"documentId","projectId"', `,'${docA}','${project.id}'`),
  );

  console.log("\nFinding it again");
  const latest = await latestProjectRun(org.id, project.id);
  ok("the project's own run is the one read", latest?.id === started.runId);
  // Its job was taken off the queue above, which is exactly what a run whose
  // job was lost looks like — so this is the orphan path, reported as one.
  ok("a live run whose job is gone is reported orphaned, not as progress",
     latest?.orphaned === true && latest?.job === null, [latest?.orphaned, latest?.job]);
  ok(
    "a design's run is not mistaken for the project's",
    await (async () => {
      const framework = await prisma.framework.findFirstOrThrow({ where: { organisationId: org.id } });
      await prisma.assessmentRun.create({
        data: {
          organisationId: org.id,
          documentId: docA,
          frameworkId: framework.id,
          state: "complete",
          totalClauses: 1,
        },
      });
      const again = await latestProjectRun(org.id, project.id);
      return again?.id === started.runId;
    })(),
  );

  console.log("\nThe job lookup follows the scope");
  ok(
    "a design run is found by its document",
    JSON.stringify(runJobWhere({ id: "r1", documentId: docA })) ===
      JSON.stringify({ documentId: docA, stage: "analyse" }),
  );
  ok(
    "a project run by the run on its payload",
    JSON.stringify(runJobWhere({ id: "r2", documentId: null })) ===
      JSON.stringify({ stage: "analyse", payload: { path: ["runId"], equals: "r2" } }),
  );

  console.log("\nOne live run per project");
  // Its job was deleted above, and `startProjectRun` clears a live run with no
  // job once it is a minute old. Stamped as new here so what this asserts is
  // the one-live-run guarantee rather than how long the script took to get here.
  await prisma.assessmentRun.update({
    where: { id: started.runId },
    data: { startedAt: new Date() },
  });
  let refused: unknown = null;
  try {
    await startProjectRun(access, project.id);
  } catch (error) {
    refused = error;
  }
  ok("a second run cannot be opened while one is live", refused !== null, refused);

  console.log("\nWhat is in scope");
  const inScope = await assessableDesigns(org.id, project.id);
  ok("every design in the project is listed", inScope.length === 3, inScope.length);
  ok(
    "with the one still processing marked, not hidden",
    inScope.filter((d) => d.status !== "ready").map((d) => d.id).join() === docC,
    inScope.map((d) => [d.title, d.status]),
  );
  ok("and the standard is not one of them", !inScope.some((d) => d.id === standard.id));

  console.log("\nAn empty project is refused with a reason");
  const empty = await createProject(access, { name: "Nothing in it" });
  let why: unknown = null;
  try {
    await startProjectRun(access, empty.id);
  } catch (error) {
    why = error;
  }
  ok(
    "and the reason says to add a design",
    why instanceof ProjectRefused && why.message.includes("Add a design"),
    why,
  );

  console.log("\nThe report page renders for a reviewer");
  // The pages above are library calls. This is the route itself, fetched with a
  // real session: a 307 proves only that the file exists, and the render is
  // where a null documentId would actually throw.
  const member = await provisionAccount({
    email: `${TAG}-reviewer@test.invalid`,
    name: "Reviewer",
    company: org.name,
    password: PASSWORD,
  });
  await prisma.membership.create({
    data: { userId: member.userId, organisationId: org.id, role: OWNER },
  });
  await prisma.rosterEntry.create({
    data: {
      organisationId: org.id,
      email: `${TAG}-reviewer@test.invalid`,
      status: "active",
      role: OWNER,
      userId: member.userId,
    },
  });
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: `${TAG}-reviewer@test.invalid`, password: PASSWORD }),
  });
  if (!signIn.ok) {
    ok(`signed in against ${BASE}`, false, `${signIn.status} — is the dev server up on this port?`);
  } else {
    const cookie = (signIn.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

    // A finished run with a finding, so the report has something to draw.
    const framework = await prisma.framework.findFirstOrThrow({
      where: { organisationId: org.id },
    });
    const finished = await prisma.assessmentRun.create({
      data: {
        organisationId: org.id,
        projectId: project.id,
        frameworkId: framework.id,
        state: "complete",
        totalClauses: 1,
        completedClauses: 1,
        model: "openai/gpt-4.1-mini",
        completedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.finding.create({
      data: {
        runId: finished.id,
        clauseId: "zz-clause",
        clauseRef: "9.3",
        clauseTitle: "Retention",
        clauseStatement: "Records are kept for a stated period.",
        verdict: "partial",
        confidence: 0.8,
        rationale: "Stated for orders, not for telemetry.",
        evidence: [
          {
            chunkId: "zz-chunk",
            headingPath: "4 Data",
            page: 12,
            excerpt: "Orders are stored in PostgreSQL.",
            sourceKind: "clause",
            documentId: docB,
            documentTitle: "Architecture",
          },
        ],
      },
    });

    const page = await fetch(`${BASE}/dashboard/projects/${project.id}/assessment`, {
      headers: { cookie },
      redirect: "manual",
    });
    const html = page.ok ? await page.text() : "";
    ok("the project's report renders", page.status === 200, page.status);
    ok("titled with the project", html.includes("Customer Portal"));
    ok("listing the designs it covers", html.includes("Proposal") && html.includes("Architecture"));
    ok("with the finding on it", html.includes("Retention"));
    ok(
      "and the evidence naming the design it came from",
      html.includes("Orders are stored in PostgreSQL."),
    );
    ok(
      "the design still being processed is called out",
      html.includes("still being processed"),
      html.length,
    );

    // A run stopped after its last clause still has its coverage, suggestions
    // and technology dates: those three passes run after the clause loop and
    // write whatever they worked out. The report used to gate both sections on
    // the run's own state, so a reviewer who pressed Stop at "14 of 14" lost
    // finished suggestions they had already paid for.
    const stopped = await prisma.assessmentRun.create({
      data: {
        organisationId: org.id,
        projectId: project.id,
        frameworkId: framework.id,
        state: "failed",
        failureReason: "Stopped by a reviewer after 1 of 1 clauses.",
        totalClauses: 1,
        completedClauses: 1,
        model: "openai/gpt-4.1-mini",
        completedAt: new Date(),
        advice: {
          version: 1,
          state: "complete",
          note: null,
          suggestions: [
            {
              title: "Externalise the session store",
              kind: "improve",
              category: "resilience",
              priority: "high",
              section: 1,
              headingPath: "2 Architecture",
              sectionTitle: "2 Architecture",
              pageStart: 2,
              pageEnd: 2,
              quote: "Session state is held in process.",
              page: 2,
              recommendation: "Move session state to a shared cache outside the process.",
              why: "One instance restarting signs every user out.",
              clauses: [],
            },
          ],
          dropped: {},
          source: "model",
          generatedAt: new Date().toISOString(),
          refreshing: false,
        },
        lifecycle: {
          version: 1,
          state: "complete",
          note: null,
          source: "endoflife.date",
          soonDays: 180,
          technologies: [
            {
              name: "PostgreSQL",
              product: "postgresql",
              label: "PostgreSQL",
              version: "11",
              status: "ended",
              section: 1,
              sectionTitle: "3 Data",
              headingPath: "3 Data",
              pageStart: 3,
              quote: "Orders are stored in a single PostgreSQL 11 instance.",
              documentTitle: "Proposal",
            },
          ],
          dropped: {},
          corrected: {},
        },
      },
      select: { id: true },
    });
    const afterStop = await fetch(`${BASE}/dashboard/projects/${project.id}/assessment`, {
      headers: { cookie },
      redirect: "manual",
    });
    const stoppedHtml = afterStop.ok ? await afterStop.text() : "";
    ok("a stopped run's report renders", afterStop.status === 200, afterStop.status);
    ok(
      "its finished suggestions are still shown",
      stoppedHtml.includes("Suggested improvements")
        && stoppedHtml.includes("Externalise the session store"),
    );
    ok(
      "and so are its technology dates",
      stoppedHtml.includes("Technology support") && stoppedHtml.includes("PostgreSQL"),
    );
    ok(
      "while the run still reads as stopped, not complete",
      stoppedHtml.includes("Stopped by a reviewer"),
    );
    await prisma.assessmentRun.delete({ where: { id: stopped.id } });

    const projectPage = await fetch(`${BASE}/dashboard/projects/${project.id}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const projectHtml = projectPage.ok ? await projectPage.text() : "";
    ok("the project page renders", projectPage.status === 200, projectPage.status);
    ok(
      "offering the whole-project assessment",
      projectHtml.includes("Assess the whole project"),
    );
  }

  console.log("\nEvidence says which design it came from");
  const read = readEvidence([
    {
      chunkId: "c1",
      headingPath: "4 Data",
      page: 12,
      excerpt: "Orders are stored in PostgreSQL.",
      sourceKind: "clause",
      documentId: docB,
      documentTitle: "Architecture",
    },
    { chunkId: "c2", headingPath: "1 Scope", page: 1, excerpt: "x", sourceKind: "clause" },
  ]);
  ok("the design is carried through", read[0].documentId === docB && read[0].documentTitle === "Architecture", read[0]);
  ok("and a finding from before projects reads as having none", read[1].documentTitle === "" && read[1].documentId === "");
} finally {
  await prisma.organisation.deleteMany({ where: { slug: TAG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: `${TAG}@test.invalid` } });
  await prisma.assessmentRun.deleteMany({ where: { id: { startsWith: TAG } } });
  await prisma.framework.deleteMany({ where: { organisationId: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
