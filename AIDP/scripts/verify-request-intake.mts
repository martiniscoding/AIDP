/**
 * Filling in a request: what the form may write, and what it may not.
 *
 * The wizard saves as the requestor goes, one group at a time, so the rule that
 * matters most here is the dull one: a step that does not carry a field must
 * not blank it. Everything else follows from the two things these answers
 * become — a document the engine quotes word for word, and a significance
 * classification that lands in an audit record. Neither can be built on a value
 * nobody typed.
 *
 * Needs no worker and queues no job: nothing here submits.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-request-intake.mts
 */
import { prisma } from "../src/lib/prisma";
import type { Access } from "../src/lib/access/gate";
import {
  DRAFT,
  FAILED,
  RequestRefused,
  SUBMITTED,
  canEditRequest,
  createRequest,
  updateRequest,
  whatIsMissing,
} from "../src/lib/ingest/requests";

const TAG = `zz-intake-${Date.now()}`;

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

const refuses = async (name: string, work: () => Promise<unknown>, fragment: string) => {
  try {
    await work();
    ok(name, false, "it was allowed");
  } catch (error) {
    const message = error instanceof RequestRefused ? error.message : String(error);
    ok(name, message.includes(fragment), message);
  }
};

const org = await prisma.organisation.create({
  data: { name: "ZZ Intake", slug: TAG },
});
const person = async (suffix: string, role: string) => {
  const user = await prisma.user.create({
    data: {
      id: `${TAG}-${suffix}`,
      name: suffix,
      email: `${TAG}-${suffix}@test.invalid`,
      company: "ZZ Intake",
      country: "GB",
      phone: "",
    },
  });
  return {
    user: { id: user.id, name: user.name, email: user.email },
    organisation: { id: org.id, name: org.name, slug: org.slug, role },
  } as Access;
};

const requestor = await person("requestor", "member");
const colleague = await person("colleague", "member");
const admin = await person("admin", "owner");

try {
  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });
  const { id } = await createRequest(requestor, {
    projectId: project.id,
    title: "Portal Upgrade",
  });
  const read = () => prisma.architectureRequest.findUniqueOrThrow({ where: { id } });

  // --- a step writes only its own group ------------------------------------
  console.log("\nA step writes only its own group");

  await updateRequest(requestor, id, {
    plannedStart: "2028-03-01",
    team: "Digital Channels",
  });
  await updateRequest(requestor, id, {
    problemStatement: "The portal runs on an unsupported framework.",
    solutionOverview: "A React application backed by PostgreSQL.",
  });

  const afterTwoSteps = await read();
  ok("the first step is still there", afterTwoSteps.team === "Digital Channels");
  ok("and its date", afterTwoSteps.plannedStart?.toISOString().startsWith("2028-03-01") === true);
  ok("beside the second", afterTwoSteps.solutionOverview.includes("React"));

  // The failure this is really about: a later step blanking an earlier one.
  await updateRequest(requestor, id, { hostingEnvironment: "On-premises VMware." });
  const afterThird = await read();
  ok("a third step blanks nothing", afterThird.team === "Digital Channels");
  ok("and keeps the prose", afterThird.problemStatement.includes("unsupported"));
  ok("while writing its own field", afterThird.hostingEnvironment.includes("VMware"));

  // Explicitly clearing is a different instruction from not mentioning.
  await updateRequest(requestor, id, { team: "" });
  ok("an empty string does clear a field", (await read()).team === "");

  // --- answers that have to be read, not stored --------------------------
  console.log("\nAnswers the form has to read rather than store");

  await updateRequest(requestor, id, {
    technologies: " React , PostgreSQL 11 ,, react ,NGINX ",
    linesOfBusiness: ["Retail", "Retail", " Wholesale "],
  });
  const lists = await read();
  ok(
    "a typed list is split and trimmed",
    JSON.stringify(lists.technologies) === JSON.stringify(["React", "PostgreSQL 11", "NGINX"]),
    lists.technologies,
  );
  ok(
    "duplicates go, case-insensitively, order kept",
    JSON.stringify(lists.linesOfBusiness) === JSON.stringify(["Retail", "Wholesale"]),
    lists.linesOfBusiness,
  );

  await updateRequest(requestor, id, { estimatedCost: "7,500,000" });
  ok("a cost keeps its grouping separators out of the column", (await read()).estimatedCost?.toString() === "7500000");

  await refuses(
    "a cost that is not a number is refused, not coerced",
    () => updateRequest(requestor, id, { estimatedCost: "about five million" }),
    "as a number",
  );
  await refuses(
    "and so is a negative one",
    () => updateRequest(requestor, id, { estimatedCost: "-100" }),
    "as a number",
  );
  ok("the earlier cost survives a refusal", (await read()).estimatedCost?.toString() === "7500000");

  await updateRequest(requestor, id, { estimatedCost: "" });
  ok("and it can be cleared", (await read()).estimatedCost === null);

  await refuses(
    "a date the form cannot read is refused",
    () => updateRequest(requestor, id, { plannedStart: "next spring" }),
    "not a date",
  );

  // Checkboxes arrive as "on" from a form post and as true from an action.
  await updateRequest(requestor, id, {
    newTechnologyComponent: "on",
    regulatoryImpact: true,
    securityDomainChange: "false",
  });
  const flags = await read();
  ok('"on" is a yes', flags.newTechnologyComponent === true);
  ok("true is a yes", flags.regulatoryImpact === true);
  ok('"false" is a no', flags.securityDomainChange === false);

  // The significance criterion reads this by name; an unknown value would make
  // it compare against something the form never offered.
  await updateRequest(requestor, id, { applicationCriticality: "mission_critical" });
  ok("a known criticality is kept", (await read()).applicationCriticality === "mission_critical");
  await updateRequest(requestor, id, { applicationCriticality: "extremely-critical" });
  ok(
    "and an unknown one falls to the safe answer",
    (await read()).applicationCriticality === "standard",
    (await read()).applicationCriticality,
  );

  await refuses(
    "a title cannot be emptied",
    () => updateRequest(requestor, id, { title: "   " }),
    "Give the request a title",
  );

  // --- who may change it ---------------------------------------------------
  console.log("\nWho may change it");

  ok("the requestor may", canEditRequest(requestor, { requestedById: requestor.user.id }));
  ok("an administrator may", canEditRequest(admin, { requestedById: requestor.user.id }));
  ok("a colleague may not", !canEditRequest(colleague, { requestedById: requestor.user.id }));

  await refuses(
    "and the library refuses them, not just the screen",
    () => updateRequest(colleague, id, { team: "Theirs" }),
    "whoever raised it",
  );
  await updateRequest(admin, id, { team: "Moved by an administrator" });
  ok("while an administrator gets through", (await read()).team.includes("administrator"));

  // Another customer's request is not found rather than refused: saying
  // "forbidden" would confirm it exists.
  const otherOrg = await prisma.organisation.create({
    data: { name: "ZZ Intake B", slug: `${TAG}-b` },
  });
  const outsider = {
    user: requestor.user,
    organisation: { id: otherOrg.id, name: "ZZ Intake B", slug: `${TAG}-b`, role: "owner" },
  } as Access;
  await refuses(
    "a request in another customer does not exist",
    () => updateRequest(outsider, id, { team: "Theirs" }),
    "no longer exists",
  );

  // --- once submitted, the answers are the thing that was assessed ---------
  console.log("\nOnce it has been submitted");

  await prisma.architectureRequest.update({ where: { id }, data: { state: SUBMITTED } });
  await refuses(
    "a submitted request cannot be edited",
    () => updateRequest(requestor, id, { solutionOverview: "Something else entirely." }),
    "Raise a new one",
  );

  // A failed one is the exception, and has to be: its reason is usually
  // something the requestor can fix.
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: FAILED, failureReason: "No standards indexed." },
  });
  await updateRequest(requestor, id, { solutionOverview: "A corrected overview." });
  ok("a failed one can be corrected", (await read()).solutionOverview === "A corrected overview.");

  // --- and it adds up to something submittable -----------------------------
  console.log("\nIt adds up to something submittable");

  await prisma.architectureRequest.update({ where: { id }, data: { state: DRAFT } });
  const before = await read();
  ok(
    "it is not submittable yet",
    whatIsMissing({ ...before, estimatedCost: null }).length > 0,
  );

  await updateRequest(requestor, id, {
    plannedStart: "2028-03-01",
    problemStatement: "The portal runs on an unsupported framework.",
    solutionOverview: "A React application backed by PostgreSQL.",
    technologies: "React, PostgreSQL 11",
    integrationPoints: "Calls the billing system over REST.",
    authMechanism: "Username and password, no second factor.",
    dataStores: "PostgreSQL holds customer profiles.",
    dataClassification: "Confidential",
    hostingEnvironment: "On-premises VMware.",
  });
  const filled = await read();
  const missing = whatIsMissing({ ...filled, estimatedCost: null });
  ok("and now it is", missing.length === 0, missing.join("; "));
} finally {
  await prisma.architectureRequest.deleteMany({ where: { organisationId: org.id } });
  await prisma.project.deleteMany({ where: { organisationId: org.id } });
  await prisma.organisation.deleteMany({ where: { slug: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: TAG } } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
