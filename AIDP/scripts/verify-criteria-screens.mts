/**
 * The criteria screens, fetched the way a browser fetches them.
 *
 * Two questions this answers that the library tests cannot: that the pages
 * render at all, and that the rule about who may change a customer's criteria
 * holds on the way in rather than only on the screen. Whoever controls these
 * decides which submissions a person ever reads, so "the button is hidden" is
 * not an answer — a member sending the action directly has to be refused.
 *
 * Needs the app running:  npm run dev
 * Run with:  npx tsx --env-file=.env.local scripts/verify-criteria-screens.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import type { Access } from "../src/lib/access/gate";
import { createRequest, updateRequest } from "../src/lib/ingest/requests";
import { criteriaFor, runCriteriaCheck, updateCriterion } from "../src/lib/significance/record";
import { CriteriaRefused } from "../src/lib/significance/record";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = `zz-crit-${Date.now()}`;
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

const org = await prisma.organisation.create({ data: { name: "ZZ Crit", slug: TAG } });

async function person(suffix: string, role: string) {
  const email = `${TAG}-${suffix}@test.invalid`;
  const account = await provisionAccount({ email, name: suffix, company: "ZZ Crit", password: PASSWORD });
  await prisma.membership.create({ data: { userId: account.userId, organisationId: org.id, role } });
  await prisma.rosterEntry.create({
    data: { organisationId: org.id, email, status: "active", role, userId: account.userId },
  });
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
  return {
    email,
    cookie,
    access: {
      user: { id: account.userId, name: suffix, email },
      organisation: { id: org.id, name: org.name, slug: org.slug, role },
    } as Access,
  };
}

const owner = await person("owner", "owner");
const member = await person("member", "member");

/**
 * React writes `<!-- -->` between adjacent text nodes when it renders on the
 * server, so a sentence assembled from an expression and a string — "9 of 9
 * categories are checked" — is not contiguous in the HTML. Stripping the
 * markers lets these checks read as the sentence a person sees rather than as
 * whatever the renderer happened to emit.
 */
const get = async (path: string, cookie: string) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const raw = await res.text();
  return { status: res.status, body: raw.replaceAll("<!-- -->", "") };
};

try {
  console.log("\nThe criteria page");

  const page = await get("/dashboard/criteria", owner.cookie);
  ok("it renders", page.status === 200, page.status);
  ok("showing all nine categories", page.body.includes("Major Technology Change") &&
    page.body.includes("Standards Change") && page.body.includes("Time Impact"));
  ok("with what each one checks, in words", page.body.includes("A new technology component is introduced."));
  ok(
    "and how many are active",
    page.body.includes("9 of 9 categories are checked on every submission"),
  );

  // The placeholder warning. The brief's own assumptions require this to be
  // configured before go-live, and a seeded number nobody chose is exactly the
  // thing that gets forgotten.
  ok(
    "it warns that the cost threshold is a placeholder",
    page.body.includes("still on its placeholder"),
  );
  ok("saying nobody chose it", page.body.includes("Nobody chose"));

  console.log("\nA member can read but not change");

  const memberPage = await get("/dashboard/criteria", member.cookie);
  ok("a member can read it", memberPage.status === 200, memberPage.status);
  ok(
    "and is told why there is nothing to press",
    memberPage.body.includes("Only an administrator can change them"),
  );
  ok("the restore button is not offered", !memberPage.body.includes("Restore the defaults"));
  ok("while an administrator gets it", page.body.includes("Restore the defaults"));

  // The check that matters: the library refuses, not just the screen.
  const criteria = await criteriaFor(org.id);
  const cost = criteria.find((c) => c.category === "cost_impact")!;
  let refusedForOtherCustomer = "";
  try {
    const stranger = await prisma.organisation.create({
      data: { name: "ZZ Crit B", slug: `${TAG}-b` },
    });
    await updateCriterion(stranger.id, cost.id, { active: false });
  } catch (error) {
    refusedForOtherCustomer = error instanceof CriteriaRefused ? error.message : String(error);
  }
  ok(
    "a criterion in another customer does not exist",
    refusedForOtherCustomer.includes("no longer exists"),
    refusedForOtherCustomer,
  );

  console.log("\nA classification on the request");

  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });
  const { id } = await createRequest(owner.access, { projectId: project.id, title: "Portal rebuild" });
  await updateRequest(owner.access, id, {
    plannedStart: "2026-12-01",
    problemStatement: "The portal is unsupported.",
    solutionOverview: "A React application backed by PostgreSQL.",
    technologies: "React, PostgreSQL 16",
    integrationPoints: "Billing over REST.",
    authMechanism: "Single sign-on.",
    dataStores: "PostgreSQL.",
    dataClassification: "Confidential",
    hostingEnvironment: "On-premises.",
    newTechnologyComponent: true,
    newTechnologyComponentName: "Redis",
    estimatedCost: "7,500,000",
  });

  const beforeCheck = await get(`/dashboard/requests/${id}`, owner.cookie);
  ok(
    "an unchecked request shows no classification",
    !beforeCheck.body.includes("Architecturally significant"),
  );

  await runCriteriaCheck(id);
  const afterCheck = await get(`/dashboard/requests/${id}`, owner.cookie);
  ok("once checked, it says so", afterCheck.body.includes("Architecturally significant"));
  ok("and that a person is needed", afterCheck.body.includes("needs a person before it proceeds"));
  ok("naming the categories that fired", afterCheck.body.includes("Major Technology Change") &&
    afterCheck.body.includes("Cost Impact"));
  // The working, which is the whole point of recording it.
  ok(
    "with what the request actually said",
    afterCheck.body.includes("The request says 7500000"),
    "",
  );

  console.log("\nAnd one that is not significant");

  const { id: quiet } = await createRequest(owner.access, { projectId: project.id, title: "Copy fix" });
  await updateRequest(owner.access, quiet, {
    plannedStart: "2026-12-01",
    problemStatement: "A typo.",
    solutionOverview: "One template changes.",
    technologies: "React",
    integrationPoints: "None.",
    authMechanism: "Unchanged.",
    dataStores: "Unchanged.",
    dataClassification: "Internal",
    hostingEnvironment: "Unchanged.",
  });
  await runCriteriaCheck(quiet);
  const quietPage = await get(`/dashboard/requests/${quiet}`, owner.cookie);
  ok("it says not significant", quietPage.body.includes("Not architecturally significant"));
  ok(
    "and that it can proceed on its findings",
    quietPage.body.includes("proceed on its findings alone"),
  );

  console.log("\nThe navigation");
  ok("Significance is in the rail", page.body.includes("Significance"));
} finally {
  const orgs = await prisma.organisation.findMany({
    where: { slug: { startsWith: TAG } }, select: { id: true },
  });
  for (const o of orgs) {
    await prisma.job.deleteMany({ where: { organisationId: o.id } });
    await prisma.significanceResult.deleteMany({ where: { request: { organisationId: o.id } } });
    await prisma.architectureRequest.deleteMany({ where: { organisationId: o.id } });
    await prisma.significanceCriterion.deleteMany({ where: { organisationId: o.id } });
    await prisma.project.deleteMany({ where: { organisationId: o.id } });
    await prisma.organisation.delete({ where: { id: o.id } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
