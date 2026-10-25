/**
 * The combined report, fetched the way a browser fetches it.
 *
 * The brief's Step 4. What it adds over the two screens it replaces is the
 * pairing: neither the significance classification nor the compliance findings
 * decides anything alone, and until this page existed a reviewer joined them in
 * their head.
 *
 * The checks here are on what the page *says*, because that is what a reviewer
 * acts on — above all the line naming which route the submission takes, and the
 * two places the report must say "not assessed" rather than implying "nothing
 * wrong".
 *
 * Needs the app running:  npm run dev
 * Run with:  npx tsx --env-file=.env.local scripts/verify-report-screen.mts
 */
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import type { Access } from "../src/lib/access/gate";
import { createRequest, updateRequest } from "../src/lib/ingest/requests";
import { runCriteriaCheck } from "../src/lib/significance/record";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = `zz-report-${Date.now()}`;
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

try {
  await fetch(`${BASE}/sign-in`, { redirect: "manual" });
} catch {
  console.log(`Nothing is serving ${BASE}. Start it with \`npm run dev\`.`);
  process.exit(2);
}

const org = await prisma.organisation.create({ data: { name: "ZZ Report", slug: TAG } });
const email = `${TAG}@test.invalid`;
const account = await provisionAccount({ email, name: "Reporter", company: "ZZ Report", password: PASSWORD });
await prisma.membership.create({ data: { userId: account.userId, organisationId: org.id, role: "owner" } });
await prisma.rosterEntry.create({
  data: { organisationId: org.id, email, status: "active", role: "owner", userId: account.userId },
});
const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email, password: PASSWORD }),
});
const cookie = (signIn.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
const access = {
  user: { id: account.userId, name: "Reporter", email },
  organisation: { id: org.id, name: org.name, slug: org.slug, role: "owner" },
} as Access;

/** React writes `<!-- -->` between adjacent text nodes on the server, so a
 *  sentence built from an expression and a string is not contiguous. */
const get = async (path: string) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, body: (await res.text()).replaceAll("<!-- -->", "") };
};

let draftIdForExport = "";

const COMPLETE = {
  plannedStart: new Date("2026-12-01"),
  problemStatement: "The portal is unsupported.",
  solutionOverview: "A React application backed by PostgreSQL.",
  technologies: "React, PostgreSQL 16",
  integrationPoints: "Billing over REST.",
  authMechanism: "Single sign-on.",
  dataStores: "PostgreSQL.",
  dataClassification: "Confidential",
  hostingEnvironment: "On-premises.",
};

/** A run with findings, built directly: this is about the report, and going
 *  through the engine would cost a hundred model calls to prove a layout. */
async function reportFor(
  title: string,
  intake: Record<string, unknown>,
  findings: { ref: string; verdict: string; obligation: string }[],
  runExtras: Record<string, unknown> = {},
) {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} ${title}` },
  });
  const { id } = await createRequest(access, { projectId: project.id, title });
  await updateRequest(access, id, { ...COMPLETE, ...intake });
  await runCriteriaCheck(id);

  // Named per report: Framework carries `@@unique([organisationId, name,
  // version])`, so a shared name refuses the second one.
  const framework = await prisma.framework.create({
    data: { organisationId: org.id, name: `${TAG} ${title} fw`, version: 1 },
  });
  const run = await prisma.assessmentRun.create({
    data: {
      organisationId: org.id,
      projectId: project.id,
      frameworkId: framework.id,
      state: "complete",
      totalClauses: findings.length,
      completedClauses: findings.length,
      ...runExtras,
    },
  });
  for (const [index, f] of findings.entries()) {
    await prisma.finding.create({
      data: {
        runId: run.id,
        clauseId: `${TAG}-c${index}`,
        clauseRef: f.ref,
        clauseTitle: `Clause ${f.ref}`,
        verdict: f.verdict,
        obligation: f.obligation,
      },
    });
  }
  await prisma.architectureRequest.update({
    where: { id },
    data: { runId: run.id, state: "reported" },
  });
  return { id, runId: run.id };
}

try {
  // -------------------------------------------------------------------------
  console.log("\nA significant change with a Critical breach");

  const big = await reportFor(
    "Portal rebuild",
    { newTechnologyComponent: true, estimatedCost: "7,500,000" },
    [
      { ref: "Security §2.2", verdict: "contradicts", obligation: "must" },
      { ref: "Data §4.1", verdict: "partial", obligation: "should" },
      { ref: "Arch §6.1", verdict: "covered", obligation: "must" },
    ],
    {
      advice: {
        // `readAdvice` refuses a payload without a state, exactly as the worker
        // writes one. A fixture missing it reads as "no advice at all", which
        // is indistinguishable from a run that produced none.
        state: "complete",
        suggestions: [
          // An "improve" has to quote the design's own words — `readAdvice`
          // refuses one without, exactly as the worker's contract requires
          // ("a change quotes what it would change"). A fixture with a null
          // quote is silently dropped and reads as a run with less advice.
          { title: "x", kind: "improve", category: "security", priority: "high",
            section: 1, component: "API", sectionTitle: "s", headingPath: "h",
            pageStart: null, pageEnd: null,
            quote: "Users sign in with a username and password.", page: 2,
            recommendation: "r", why: "w", clauses: ["Security §2.2"] },
          { title: "y", kind: "add", category: "resilience", priority: "medium",
            section: 1, component: "DB", sectionTitle: "s", headingPath: "h",
            pageStart: null, pageEnd: null, quote: null, page: null,
            recommendation: "r", why: "w", clauses: [] },
        ],
      },
    },
  );

  const page = await get(`/dashboard/requests/${big.id}/report`);
  ok("the report renders", page.status === 200, page.status);

  ok("it states the significance", page.body.includes("Architecturally significant"));
  ok("naming the categories that fired", page.body.includes("Major Technology Change"));
  ok("and the compliance grades beside it", page.body.includes("1 Critical"));
  ok("with the covered ones counted", page.body.includes("1 covered"));
  ok("and the worst finding named", page.body.includes("Security §2.2"));

  // The line that is the whole point of the page.
  ok("it says what happens next", page.body.includes("Escalate to the architecture review board"));
  ok(
    "and why, in both halves",
    page.body.includes("architecturally significant and carries 1 Critical finding"),
    "",
  );

  console.log("\nThe risk view");

  ok("all five dimensions are shown", ["Single points of failure", "Security exposure",
    "Scalability", "Vendor lock-in", "Data residency"].every((d) => page.body.includes(d)));
  ok("a dimension with a finding is graded", page.body.includes("Security exposure"));
  // The rule the whole file defends.
  ok("a dimension nothing spoke to says 'Not assessed'", page.body.includes("Not assessed"));
  ok(
    "and lock-in explains that support dates are not evidence about it",
    page.body.includes("Support dates are not evidence about it"),
  );
  // The header counts what could be answered, which is the honest summary: two
  // of five, not "three dimensions are clear".
  ok(
    "the header says how many could be assessed at all",
    page.body.includes("2 of 5 dimensions could be assessed from this submission"),
    "",
  );
  // And the two states are drawn differently: a dimension nothing reached says
  // "Not assessed", never a dash that reads as clear.
  ok(
    "an assessed dimension carries a grade rather than a question",
    page.body.includes("Security exposure") && page.body.includes("Critical"),
  );

  // -------------------------------------------------------------------------
  console.log("\nA routine change with nothing breached");

  const quiet = await reportFor("Copy fix", {}, [
    { ref: "Arch §1.1", verdict: "covered", obligation: "must" },
  ]);
  const quietPage = await get(`/dashboard/requests/${quiet.id}/report`);
  ok("it says not significant", quietPage.body.includes("Not architecturally significant"));
  ok("and that it can be approved", quietPage.body.includes("can be approved without a review"));

  // -------------------------------------------------------------------------
  console.log("\nThe case the brief's table gets wrong");

  // Every finding unsettled: read literally, "no Critical or High findings"
  // takes the fast path. The engine is saying nobody has looked at this.
  const unsettled = await reportFor("All unsettled", {}, [
    { ref: "Data §9.1", verdict: "needs_review", obligation: "unstated" },
    { ref: "Data §9.2", verdict: "needs_review", obligation: "unstated" },
  ]);
  const unsettledPage = await get(`/dashboard/requests/${unsettled.id}/report`);
  ok(
    "it is NOT approved",
    !unsettledPage.body.includes("can be approved without a review"),
  );
  ok("an architect has to review it", unsettledPage.body.includes("An architect has to review this"));
  ok(
    "because the engine says a person has to look",
    unsettledPage.body.includes("a person has to look"),
  );
  ok(
    "and it counts how many could not be graded",
    unsettledPage.body.includes("could not be graded from the document"),
  );

  // -------------------------------------------------------------------------
  console.log("\nA breach below the significance threshold");

  const small = await reportFor("Small but broken", {}, [
    { ref: "Security §5.1", verdict: "contradicts", obligation: "must" },
  ]);
  const smallPage = await get(`/dashboard/requests/${small.id}/report`);
  ok("it still goes to an architect", smallPage.body.includes("An architect has to review this"));
  ok(
    "because a breach is never waived for being small",
    smallPage.body.includes("never waived for being small"),
  );

  // -------------------------------------------------------------------------
  console.log("\nBefore there is anything to report");

  const draftProject = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} draft` },
  });
  const { id: draftId } = await createRequest(access, {
    projectId: draftProject.id, title: "Not submitted",
  });
  const draftPage = await get(`/dashboard/requests/${draftId}/report`);
  ok("a draft says so rather than drawing an empty report", draftPage.body.includes("has not been submitted yet"));
  draftIdForExport = draftId;

  // -------------------------------------------------------------------------
  console.log("\nRecommendations");

  // The brief's Step 4 assembles recommendations into the report too. The full
  // set lives on the findings screen beside the passages they quote; what the
  // report carries is the shape of them, for somebody reading it in a board
  // pack.
  ok("the report carries them", page.body.includes("Recommendations"));
  ok(
    "saying plainly that they are advice",
    page.body.includes("Advice, never a verdict"),
  );
  ok("with the category that raised each", page.body.includes("Security"));

  console.log("\nThe report as a file");

  // The brief attaches the report to its notifications and to the ARB
  // invitation, so it has to leave the screen — and has to carry the same
  // answers, including the two it would be easiest to flatten.
  const download = await fetch(`${BASE}/dashboard/requests/${big.id}/report/export`, {
    headers: { cookie },
  });
  ok("it downloads", download.status === 200, download.status);
  ok(
    "as a workbook",
    (download.headers.get("content-type") ?? "").includes("spreadsheetml"),
    download.headers.get("content-type"),
  );
  ok(
    "named for the request",
    (download.headers.get("content-disposition") ?? "").includes("AR-0001"),
    download.headers.get("content-disposition"),
  );

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await download.arrayBuffer());
  ok(
    "with a sheet for each question the report answers",
    ["Summary", "Findings", "Risk", "Significance"].every((name) => book.getWorksheet(name)),
    book.worksheets.map((w) => w.name),
  );

  const cells = (name: string) =>
    (book.getWorksheet(name)?.getSheetValues() ?? [])
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .map((cell) => String(cell ?? ""));

  const summary = cells("Summary").join(" | ");
  ok("the summary states the significance", summary.includes("Architecturally significant"));
  ok("counts the Critical findings", summary.includes("Critical findings"));
  ok("and says what happens next", summary.includes("Escalate to the architecture review board"));

  const findingRows = cells("Findings");
  ok("the findings sheet lists the breach", findingRows.includes("Security §2.2"));
  ok("graded", findingRows.includes("Critical"));
  // The column that stops "Low" being read as "small".
  ok("with whether the grade is settled", book.getWorksheet("Findings")!.getRow(1).values!.toString().includes("Settled"));

  const riskRows = cells("Risk").join(" | ");
  ok("the risk sheet keeps the two answers apart", riskRows.includes("Not assessed"));
  ok("naming every dimension", riskRows.includes("Vendor lock-in"));

  const sig = cells("Significance").join(" | ");
  ok("the significance sheet states the rule as it stood", sig.includes("Estimated cost is at least"));
  ok("and why it fired", sig.includes("The request says 7500000"));

  // A request with no run has no report, and the file says so rather than
  // downloading an empty workbook.
  const noReport = await fetch(`${BASE}/dashboard/requests/${draftIdForExport}/report/export`, {
    headers: { cookie },
  });
  ok("a request with no run cannot be downloaded", noReport.status === 409, noReport.status);

  // -------------------------------------------------------------------------
  console.log("\nAnother customer's report");

  const otherOrg = await prisma.organisation.create({
    data: { name: "ZZ Report B", slug: `${TAG}-b` },
  });
  const otherProject = await prisma.project.create({
    data: { organisationId: otherOrg.id, name: `${TAG} theirs` },
  });
  const theirs = await prisma.architectureRequest.create({
    data: {
      organisationId: otherOrg.id, reference: "AR-0001",
      projectId: otherProject.id, title: "Not yours to read",
    },
  });
  const forbidden = await get(`/dashboard/requests/${theirs.id}/report`);
  ok("its title never reaches the page", !forbidden.body.includes("Not yours to read"));
  ok("and the page says there is nothing there", /not.?found|404/i.test(forbidden.body));
} finally {
  const orgs = await prisma.organisation.findMany({
    where: { slug: { startsWith: TAG } }, select: { id: true },
  });
  for (const o of orgs) {
    await prisma.job.deleteMany({ where: { organisationId: o.id } });
    await prisma.finding.deleteMany({ where: { run: { organisationId: o.id } } });
    await prisma.significanceResult.deleteMany({ where: { request: { organisationId: o.id } } });
    await prisma.architectureRequest.deleteMany({ where: { organisationId: o.id } });
    await prisma.assessmentRun.deleteMany({ where: { organisationId: o.id } });
    await prisma.significanceCriterion.deleteMany({ where: { organisationId: o.id } });
    await prisma.framework.deleteMany({ where: { organisationId: o.id } });
    await prisma.document.deleteMany({ where: { organisationId: o.id } });
    await prisma.project.deleteMany({ where: { organisationId: o.id } });
    await prisma.organisation.delete({ where: { id: o.id } });
  }
  await prisma.user.deleteMany({ where: { email } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
