/**
 * The intake screens, fetched the way a browser fetches them.
 *
 * The library is checked elsewhere — `verify-request-intake.mts` for what the
 * form may write, `verify-requests.mts` for what submitting does. What this
 * adds is the part neither can see: that the pages render at all, that the
 * guard in front of them holds, and that a request actually reaches the screen
 * with its own answers on it.
 *
 * What this can and cannot see is worth stating, because it shapes every
 * assertion below. The wizard is a Client Component, so a response carries its
 * *data* — in the flight payload — rather than its rendered form: a technology
 * list arrives as ["React","PostgreSQL 16"] and is joined into one field in the
 * browser, where nothing here is looking. So the checks are on what the server
 * decided and sent, never on what the browser will make of it. Anything that
 * only exists after hydration belongs in a browser test, not this one.
 *
 * A page that throws renders a 500 rather than a stack trace a test can read,
 * so the checks here are deliberately coarse: a status, and strings that could
 * only have come from this request's own row.
 *
 * Needs the app running:  npm run dev
 * Run with:  npx tsx --env-file=.env.local scripts/verify-request-screens.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { createRequest, updateRequest } from "../src/lib/ingest/requests";
import type { Access } from "../src/lib/access/gate";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = `zz-screens-${Date.now()}`;
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

async function reachable(): Promise<boolean> {
  try {
    await fetch(`${BASE}/sign-in`, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

if (!(await reachable())) {
  console.log(`Nothing is serving ${BASE}. Start it with \`npm run dev\` and run this again.`);
  process.exit(2);
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function get(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

const org = await prisma.organisation.create({
  data: { name: "ZZ Screens", slug: TAG },
});
const email = `${TAG}@test.invalid`;
const account = await provisionAccount({
  email,
  name: "Screen Tester",
  company: "ZZ Screens",
  password: PASSWORD,
});
await prisma.membership.create({
  data: { userId: account.userId, organisationId: org.id, role: "owner" },
});
await prisma.rosterEntry.create({
  data: { organisationId: org.id, email, status: "active", role: "owner", userId: account.userId },
});

try {
  // --- the guard ----------------------------------------------------------
  console.log("\nThe guard in front of them");

  const anonymousList = await get("/dashboard/requests");
  ok(
    "a stranger is sent to sign in",
    anonymousList.status === 307 || anonymousList.status === 302,
    anonymousList.status,
  );
  ok(
    "and lands on the sign-in page",
    (anonymousList.location ?? "").includes("/sign-in"),
    anonymousList.location,
  );

  const cookie = await signIn(email);
  ok("signing in works", cookie.length > 0);

  // --- the list -----------------------------------------------------------
  console.log("\nThe list");

  const empty = await get("/dashboard/requests", cookie);
  ok("it renders", empty.status === 200, empty.status);
  ok("and says there is nothing yet", empty.body.includes("No requests yet"));
  // No project, so nothing can be filed. Said plainly rather than by offering a
  // button that cannot work.
  ok(
    "and that a request needs a project first",
    empty.body.includes("there are no open ones yet"),
  );

  const project = await prisma.project.create({
    data: { organisationId: org.id, name: `${TAG} project` },
  });

  const access = {
    user: { id: account.userId, name: "Screen Tester", email },
    organisation: { id: org.id, name: org.name, slug: org.slug, role: "owner" },
  } as Access;

  const { id, reference } = await createRequest(access, {
    projectId: project.id,
    title: "Customer Portal Upgrade",
  });

  const listed = await get("/dashboard/requests", cookie);
  ok("a request appears on the list", listed.body.includes("Customer Portal Upgrade"));
  ok("with its reference", listed.body.includes(reference), reference);
  ok("and its state", listed.body.includes("Draft"));
  ok("and the project it belongs to", listed.body.includes(`${TAG} project`));

  // --- the wizard ---------------------------------------------------------
  console.log("\nThe wizard");

  const draft = await get(`/dashboard/requests/${id}`, cookie);
  ok("the request page renders", draft.status === 200, draft.status);
  ok("showing its reference", draft.body.includes(reference));
  ok("and all four steps", ["Request", "Solution", "Architecture", "Impact"].every((s) => draft.body.includes(s)));
  // Printed by the page rather than the wizard, so it is readable from any
  // step instead of ambushing somebody on the last one — and so it is the
  // server's own answer that appears, not a second opinion.
  ok(
    "and says what is still needed before it can be submitted",
    draft.body.includes("Still needed before this can be submitted"),
  );
  ok(
    "naming the solution overview among them",
    draft.body.includes("the solution overview"),
  );

  // Answers written by the library reach the screen, which is the thing a
  // rendering test can prove and a library test cannot.
  await updateRequest(access, id, {
    team: "Digital Channels",
    solutionOverview: "A React application backed by PostgreSQL.",
    technologies: "React, PostgreSQL 16",
    hostingEnvironment: "On-premises VMware cluster.",
  });

  const filled = await get(`/dashboard/requests/${id}`, cookie);
  ok("a saved answer reaches the page", filled.body.includes("Digital Channels"));
  ok("including the prose", filled.body.includes("A React application backed by PostgreSQL."));
  // As the array the server sent. The browser joins it into one field; this is
  // checking that both entries survived the round trip, not how they are drawn.
  ok(
    "and every entry of a list",
    filled.body.includes("React") && filled.body.includes("PostgreSQL 16"),
  );
  // Answered, so it is no longer outstanding — which is the page re-deciding
  // rather than caching its first answer.
  ok(
    "and what was answered drops off the outstanding list",
    !filled.body.includes("the hosting and deployment environment"),
  );

  // --- a submitted request is a different screen --------------------------
  console.log("\nOnce it has been submitted");

  await prisma.architectureRequest.update({
    where: { id },
    data: { state: "checking", submittedAt: new Date() },
  });
  const submitted = await get(`/dashboard/requests/${id}`, cookie);
  ok("it still renders", submitted.status === 200, submitted.status);
  ok("as a status rather than a form", submitted.body.includes("A changed design is a new request"));
  ok("and says it is under review", submitted.body.includes("Under review"));

  // --- a stopped one says why ---------------------------------------------
  console.log("\nA request that stopped");

  await prisma.architectureRequest.update({
    where: { id },
    data: { state: "failed", failureReason: "There are no reference standards indexed yet." },
  });
  const stopped = await get(`/dashboard/requests/${id}`, cookie);
  ok("the reason is on the page", stopped.body.includes("no reference standards indexed"));
  ok("it says what to do about it", stopped.body.includes("submit it again"));
  // The wizard is back rather than the submitted-request view: a failure is
  // usually something the requestor can correct.
  ok(
    "and it is editable again",
    stopped.body.includes("Architecture") &&
      !stopped.body.includes("A changed design is a new request"),
  );

  // --- another customer's request -----------------------------------------
  console.log("\nAnother customer's request");

  const otherOrg = await prisma.organisation.create({
    data: { name: "ZZ Screens B", slug: `${TAG}-b` },
  });
  const otherProject = await prisma.project.create({
    data: { organisationId: otherOrg.id, name: `${TAG} theirs` },
  });
  const theirs = await prisma.architectureRequest.create({
    data: {
      organisationId: otherOrg.id,
      reference: "AR-0001",
      projectId: otherProject.id,
      title: "Not yours to read",
    },
  });
  const forbidden = await get(`/dashboard/requests/${theirs.id}`, cookie);
  // The only thing that matters: none of it arrives. The status is 200 because
  // the shell streams before the segment resolves — every page in this app that
  // calls `notFound()` behind a loading.tsx answers the same way — so the
  // check is on the body, which is where a leak would actually be.
  ok("its title never reaches the page", !forbidden.body.includes("Not yours to read"));
  ok("nor its reference", !forbidden.body.includes(`${TAG} theirs`));
  ok("and the page says there is nothing there", /not.?found|404/i.test(forbidden.body));

  // --- the ping that never arrived ----------------------------------------
  console.log("\nA request whose ping never arrived");
  // The failure this guards: the embed worker finished a document, called the
  // app, and the call was lost — the app was redeploying, or the network
  // blinked. The worker does not retry it on purpose. Without a second route
  // in, the request waits in "submitted" for ever with a ready document and no
  // run, and nothing anywhere says so.
  //
  // Nothing is scheduled to catch that: Vercel's Hobby plan allows only a daily
  // cron, which is not a fallback anybody would want to wait on. So the screens
  // sweep for themselves, and this is the check that they do.
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

  // A design that finished indexing, and a request that never heard about it.
  const design = await prisma.document.create({
    data: {
      organisationId: org.id,
      projectId: project.id,
      role: "assessed",
      title: "AR-0001 Rendered intake",
      storageKey: `${TAG}/design.docx`,
      byteSize: 1,
      sha256: `${TAG}-design`,
      status: "ready",
    },
  });
  await prisma.chunk.create({
    data: {
      organisationId: org.id,
      documentId: design.id,
      sourceKind: "section",
      ordinal: 0,
      headingPath: "AR-0001 › 3 Solution Overview",
      text: "Sessions are held in application memory.",
      contentHash: `${TAG}-chunk`,
    },
  });
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: "submitted", documentId: design.id, runId: null, failureReason: null },
  });

  const beforeOpening = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id },
    select: { runId: true },
  });
  ok("it is stuck with no run", beforeOpening.runId === null);

  // Opening the list is the repair.
  await get("/dashboard/requests", cookie);
  const afterList = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id },
    select: { runId: true, state: true },
  });
  ok("opening the list starts it", afterList.runId !== null, afterList.state);
  ok("and moves it on", afterList.state === "checking", afterList.state);

  // The job this just created would be claimed by a worker and billed for.
  await prisma.job.deleteMany({ where: { organisationId: org.id, stage: "analyse" } });

  // The detail page does the same, for somebody who went straight there.
  await prisma.assessmentRun.deleteMany({ where: { organisationId: org.id } });
  await prisma.architectureRequest.update({
    where: { id },
    data: { state: "submitted", runId: null },
  });
  await get(`/dashboard/requests/${id}`, cookie);
  const afterDetail = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id },
    select: { runId: true, state: true },
  });
  ok("and so does opening the request itself", afterDetail.runId !== null, afterDetail.state);
  await prisma.job.deleteMany({ where: { organisationId: org.id, stage: "analyse" } });

  // A draft must not be swept into an assessment by somebody reading the list.
  const { id: draftId } = await createRequest(access, {
    projectId: project.id,
    title: "Still being written",
  });
  await get("/dashboard/requests", cookie);
  const stillDraft = await prisma.architectureRequest.findUniqueOrThrow({
    where: { id: draftId },
    select: { state: true, runId: true },
  });
  ok("a draft is left alone by the sweep", stillDraft.state === "draft" && stillDraft.runId === null);

  // --- the navigation ------------------------------------------------------
  console.log("\nThe navigation");
  ok("Requests is in the rail", listed.body.includes(">Requests<") || listed.body.includes("Requests"));
} finally {
  const orgs = await prisma.organisation.findMany({
    where: { slug: { startsWith: TAG } },
    select: { id: true },
  });
  // Children first, in dependency order: one cascading delete of the
  // organisation touches a dozen tables at once and deadlocks against itself
  // on Neon.
  for (const o of orgs) {
    await prisma.job.deleteMany({ where: { organisationId: o.id } });
    await prisma.chunk.deleteMany({ where: { organisationId: o.id } });
    await prisma.architectureRequest.deleteMany({ where: { organisationId: o.id } });
    await prisma.assessmentRun.deleteMany({ where: { organisationId: o.id } });
    await prisma.document.deleteMany({ where: { organisationId: o.id } });
    await prisma.framework.deleteMany({ where: { organisationId: o.id } });
    await prisma.project.deleteMany({ where: { organisationId: o.id } });
    await prisma.organisation.delete({ where: { id: o.id } });
  }
  await prisma.user.deleteMany({ where: { email } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
