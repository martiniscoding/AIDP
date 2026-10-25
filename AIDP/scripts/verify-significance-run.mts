/**
 * The criteria check against the database: what a submission leaves behind.
 *
 * `verify-significance.mts` proves the arithmetic. This proves the record — the
 * part a governance audit actually reads, and the part that has to keep making
 * sense after an administrator has rewritten the rule it was reached under.
 *
 * Nothing here queues work: the one job a submission creates is checked and
 * removed, because a worker runs against this database and cannot tell a test's
 * document from a customer's.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-significance-run.mts
 */
import { prisma } from "../src/lib/prisma";
import type { Access } from "../src/lib/access/gate";
import { remove } from "../src/lib/ingest/storage";
import { createRequest, submitRequest, updateRequest } from "../src/lib/ingest/requests";
import { criteriaFor, resultsFor, runCriteriaCheck } from "../src/lib/significance/record";

const TAG = `zz-sig-${Date.now()}`;

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

const org = await prisma.organisation.create({ data: { name: "ZZ Sig", slug: TAG } });
const user = await prisma.user.create({
  data: {
    id: `${TAG}-user`, name: "Sig Tester", email: `${TAG}@test.invalid`,
    company: "ZZ Sig", country: "GB", phone: "",
  },
});
const access = {
  user: { id: user.id, name: user.name, email: user.email },
  organisation: { id: org.id, name: org.name, slug: org.slug, role: "owner" },
} as Access;

/** Everything a submission needs, with nothing that would make it significant. */
const ROUTINE = {
  plannedStart: new Date("2026-12-01"),
  problemStatement: "A small correction to an internal page.",
  solutionOverview: "One template is changed. No new components, no new stores.",
  technologies: ["React"],
  integrationPoints: "None beyond those already in place.",
  authMechanism: "The existing single sign-on, unchanged.",
  dataStores: "The existing PostgreSQL instance, unchanged.",
  dataClassification: "Internal",
  hostingEnvironment: "The existing cluster.",
};

try {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });

  // --- seeding --------------------------------------------------------------
  console.log("\nA customer with no criteria yet");

  const seeded = await criteriaFor(org.id);
  ok("the brief's nine are seeded on first use", seeded.length === 9, seeded.length);
  ok("and all of them active", seeded.every((c) => c.active));

  const again = await criteriaFor(org.id);
  ok("asking twice does not seed twice", again.length === 9, again.length);

  // An administrator's edit must survive the next submission.
  const costCriterion = seeded.find((c) => c.category === "cost_impact")!;
  await prisma.significanceCriterion.update({
    where: { id: costCriterion.id },
    data: { conditions: [{ field: "estimatedCost", operator: "at_least", value: 1_000_000, text: "Estimated cost is at least 1,000,000." }] },
  });
  const edited = await criteriaFor(org.id);
  const editedCost = edited.find((c) => c.category === "cost_impact")!;
  ok(
    "an administrator's threshold is not overwritten",
    JSON.stringify(editedCost.conditions).includes("1000000"),
    editedCost.conditions,
  );

  // --- a routine change -----------------------------------------------------
  console.log("\nA routine change");

  const quiet = await createRequest(access, { projectId: project.id, title: "Copy fix" });
  await updateRequest(access, quiet.id, ROUTINE);
  const quietResult = await runCriteriaCheck(quiet.id);

  ok("it is classified", quietResult !== null);
  ok("as not significant", quietResult?.significance === "not_significant", quietResult?.triggered.map((t) => t.category));
  const quietRow = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: quiet.id } });
  ok("and the request says so", quietRow.significance === "not_significant", quietRow.significance);
  ok("with the moment it was decided", quietRow.significanceAt !== null);

  const quietRows = await resultsFor(quiet.id);
  ok("every active category is recorded", quietRows.length === 9, quietRows.length);
  ok("none triggered", quietRows.every((r) => !r.triggered));
  ok(
    "and each says which rule it was checked against",
    quietRows.every((r) => r.conditionText.length > 0),
    quietRows.filter((r) => !r.conditionText).map((r) => r.category),
  );

  // --- a significant change -------------------------------------------------
  console.log("\nA change the board should see");

  const loud = await createRequest(access, { projectId: project.id, title: "Portal rebuild" });
  await updateRequest(access, loud.id, {
    ...ROUTINE,
    newTechnologyComponent: true,
    newTechnologyComponentName: "Redis",
    newLicenceRequired: true,
    newLicenceVendor: "Redis Ltd",
    estimatedCost: "7,500,000",
    linesOfBusiness: ["Retail", "Wholesale"],
  });
  const loudResult = await runCriteriaCheck(loud.id);
  ok("it is significant", loudResult?.significance === "significant");
  ok(
    "on the four categories that fired",
    (loudResult?.triggered.map((t) => t.category) ?? []).sort().join(",") ===
      "business_impact,cost_impact,licensing,major_technology_change",
    loudResult?.triggered.map((t) => t.category),
  );

  const loudRows = await resultsFor(loud.id);
  ok("all nine are still recorded", loudRows.length === 9, loudRows.length);
  ok("four of them triggered", loudRows.filter((r) => r.triggered).length === 4);
  ok("and the triggered ones sort first", loudRows[0]!.triggered === true);

  // The working. This is the line a review board reads.
  const costRow = loudRows.find((r) => r.category === "cost_impact")!;
  const working = costRow.triggeredBy as { field: string; value: unknown; actual: string }[];
  ok("a triggered category carries its working", working.length === 1, working);
  ok("naming the field", working[0]!.field === "estimatedCost", working[0]!.field);
  ok("the threshold it was measured against", working[0]!.value === 1_000_000, working[0]!.value);
  ok("and what the request actually said", working[0]!.actual === "7500000", working[0]!.actual);
  ok(
    "against the administrator's edited rule, not the default",
    costRow.conditionText.includes("1,000,000"),
    costRow.conditionText,
  );

  // A category that did not fire carries no working — there is nothing to show.
  const untriggered = loudRows.find((r) => !r.triggered)!;
  ok("an untriggered category carries none", (untriggered.triggeredBy as unknown[]).length === 0);

  // --- the record outlives the rule ----------------------------------------
  console.log("\nAfter the rules change");

  await prisma.significanceCriterion.update({
    where: { id: costCriterion.id },
    data: { label: "Cost Impact (revised)", conditions: [] },
  });
  const kept = (await resultsFor(loud.id)).find((r) => r.category === "cost_impact")!;
  ok("the result keeps the label it was judged under", kept.categoryLabel === "Cost Impact", kept.categoryLabel);
  ok("and the rule", kept.conditionText.includes("1,000,000"), kept.conditionText);

  await prisma.significanceCriterion.delete({ where: { id: costCriterion.id } });
  const survived = (await resultsFor(loud.id)).find((r) => r.category === "cost_impact");
  ok("and survives the rule being deleted", survived !== undefined);

  // --- switching one off ----------------------------------------------------
  console.log("\nA category switched off");

  const licensing = (await criteriaFor(org.id)).find((c) => c.category === "licensing")!;
  await prisma.significanceCriterion.update({
    where: { id: licensing.id },
    data: { active: false },
  });
  await runCriteriaCheck(loud.id);
  const afterOff = await resultsFor(loud.id);
  ok("it is no longer checked", !afterOff.some((r) => r.category === "licensing"), afterOff.map((r) => r.category));
  // Eight: nine less the deleted cost rule, less the one switched off.
  ok("so one fewer row is written", afterOff.length === 7, afterOff.length);
  ok(
    "and no stale row claims it was checked",
    afterOff.every((r) => r.category !== "licensing" && r.category !== "cost_impact"),
  );
  const stillLoud = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: loud.id } });
  ok("the submission is still significant on the rest", stillLoud.significance === "significant");

  // --- submitting runs it ---------------------------------------------------
  console.log("\nSubmitting runs the check");

  const submitted = await createRequest(access, { projectId: project.id, title: "Submitted properly" });
  await updateRequest(access, submitted.id, { ...ROUTINE, securityDomainChange: true });
  const before = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: submitted.id } });
  ok("a draft has no classification", before.significance === null);

  await submitRequest(access, submitted.id);
  // Removed before a worker claims it; this test is not paying for a parse.
  await prisma.job.deleteMany({ where: { organisationId: org.id } });

  const after = await prisma.architectureRequest.findUniqueOrThrow({ where: { id: submitted.id } });
  ok("submitting classifies it", after.significance === "significant", after.significance);
  ok("and it has a document too", after.documentId !== null);
  const securityRow = (await resultsFor(submitted.id)).find((r) => r.category === "security_impact")!;
  ok("on the category that fired", securityRow.triggered === true);

  // --- time is pinned -------------------------------------------------------
  console.log("\nTime is measured from the submission");

  const far = await createRequest(access, { projectId: project.id, title: "Far off" });
  await updateRequest(access, far.id, { ...ROUTINE, plannedStart: "2030-01-01" });
  await prisma.architectureRequest.update({
    where: { id: far.id },
    data: { submittedAt: new Date("2026-10-24T00:00:00Z") },
  });
  const farResult = await runCriteriaCheck(far.id);
  ok(
    "a start beyond the window triggers Time Impact",
    farResult?.triggered.some((t) => t.category === "time_impact") === true,
    farResult?.triggered.map((t) => t.category),
  );
  ok(
    "measured from the submission, not from today",
    farResult?.asOf.toISOString() === "2026-10-24T00:00:00.000Z",
    farResult?.asOf,
  );

  const near = await createRequest(access, { projectId: project.id, title: "Soon" });
  await updateRequest(access, near.id, { ...ROUTINE, plannedStart: "2027-01-01" });
  await prisma.architectureRequest.update({
    where: { id: near.id },
    data: { submittedAt: new Date("2026-10-24T00:00:00Z") },
  });
  const nearResult = await runCriteriaCheck(near.id);
  ok("a start inside it does not", !nearResult?.triggered.some((t) => t.category === "time_impact"));

  // --- another customer -----------------------------------------------------
  console.log("\nAnother customer's criteria are their own");

  const otherOrg = await prisma.organisation.create({
    data: { name: "ZZ Sig B", slug: `${TAG}-b` },
  });
  const theirs = await criteriaFor(otherOrg.id);
  ok("they get their own nine", theirs.length === 9);
  ok(
    "at the default threshold, not this customer's edit",
    JSON.stringify(theirs.find((c) => c.category === "cost_impact")!.conditions).includes("5000000"),
  );
  const missing = await runCriteriaCheck(`${TAG}-nonexistent`);
  ok("and a request that does not exist is not an error", missing === null);
} finally {
  const orgs = await prisma.organisation.findMany({
    where: { slug: { startsWith: TAG } }, select: { id: true },
  });
  for (const o of orgs) {
    const stored = await prisma.document.findMany({
      where: { organisationId: o.id }, select: { storageKey: true },
    });
    await remove(stored.map((d) => d.storageKey)).catch(() => 0);
    await prisma.job.deleteMany({ where: { organisationId: o.id } });
    await prisma.significanceResult.deleteMany({ where: { request: { organisationId: o.id } } });
    await prisma.architectureRequest.deleteMany({ where: { organisationId: o.id } });
    await prisma.significanceCriterion.deleteMany({ where: { organisationId: o.id } });
    await prisma.document.deleteMany({ where: { organisationId: o.id } });
    await prisma.project.deleteMany({ where: { organisationId: o.id } });
    await prisma.organisation.delete({ where: { id: o.id } });
  }
  await prisma.user.deleteMany({ where: { id: user.id } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
