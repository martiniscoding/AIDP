/**
 * Projects: employees open them, everyone in the workspace sees them, and a
 * design cannot be filed into somebody else's.
 *
 * Uses the real library functions and the real upload endpoint, against two
 * throwaway organisations so the tenant boundary is actually exercised rather
 * than assumed. Both are removed at the end.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-projects.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { OWNER, MEMBER } from "../src/lib/access/roles";
import type { Access } from "../src/lib/access/gate";
import {
  ProjectRefused,
  canEditProject,
  createProject,
  getProject,
  listProjects,
  setProjectStatus,
  updateProject,
} from "../src/lib/ingest/projects";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = "zz-projects";
const PASSWORD = "a-throwaway-password";

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

const orgA = await prisma.organisation.create({
  data: { name: "ZZ Projects A", slug: `${TAG}-a-${Date.now()}` },
});
const orgB = await prisma.organisation.create({
  data: { name: "ZZ Projects B", slug: `${TAG}-b-${Date.now()}` },
});

async function person(org: { id: string; name: string }, suffix: string, role: string) {
  const email = `${TAG}-${suffix}@test.invalid`;
  const account = await provisionAccount({ email, name: suffix, company: org.name, password: PASSWORD });
  await prisma.membership.create({
    data: { userId: account.userId, organisationId: org.id, role },
  });
  await prisma.rosterEntry.create({
    data: { organisationId: org.id, email, status: "active", role, userId: account.userId },
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const access: Access = {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      company: user.company,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    organisation: { id: org.id, name: org.name, slug: `${suffix}`, role },
    role: role === OWNER ? OWNER : MEMBER,
    isOwner: role === OWNER,
  };
  return { email, access };
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

try {
  const boss = await person(orgA, "boss", OWNER);
  const staff = await person(orgA, "staff", MEMBER);
  const other = await person(orgB, "other", MEMBER);

  console.log("\n1. An employee can open a project");
  const project = await createProject(staff.access, {
    name: "Customer Portal",
    description: "Phase one.",
  });
  ok("created", Boolean(project.id));
  ok("attributed to them", (await getProject(orgA.id, project.id))?.createdByName === "staff");

  console.log("\n2. Names are unique inside a workspace, not across them");
  try {
    await createProject(staff.access, { name: "Customer Portal" });
    ok("duplicate refused", false);
  } catch (error) {
    ok("duplicate refused", error instanceof ProjectRefused, (error as Error).message);
  }
  const twin = await createProject(other.access, { name: "Customer Portal" });
  ok("another company may use the same name", Boolean(twin.id));

  console.log("\n3. Everyone in the workspace sees it; nobody outside does");
  ok("the administrator sees it", (await listProjects(orgA.id)).some((p) => p.id === project.id));
  ok("the other company does not", !(await listProjects(orgB.id)).some((p) => p.id === project.id));
  ok("and cannot fetch it by id", (await getProject(orgB.id, project.id)) === null);

  console.log("\n4. Who may change it");
  const row = (await getProject(orgA.id, project.id))!;
  ok("the person who opened it may", canEditProject(staff.access, row));
  ok("the administrator may", canEditProject(boss.access, row));
  const colleague = await person(orgA, "colleague", MEMBER);
  ok("another employee may not", !canEditProject(colleague.access, row));
  try {
    await updateProject(colleague.access, project.id, { name: "Hijacked" });
    ok("and is refused when they try", false);
  } catch (error) {
    ok("and is refused when they try", error instanceof ProjectRefused);
  }

  console.log("\n5. Uploading a design into a project");
  const cookie = await signIn(staff.email);
  const post = async (projectId: string) => {
    const form = new FormData();
    form.set("role", "assessed");
    if (projectId) form.set("projectId", projectId);
    const res = await fetch(`${BASE}/api/documents/upload`, {
      method: "POST",
      headers: { cookie, origin: BASE },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  // No file is attached, so the project checks separate cleanly from the file
  // checks and nothing reaches storage.
  const noProject = await post("");
  ok("a design with no project is refused", noProject.status === 400, noProject.body.error ?? "");
  ok("and told to choose one", /project/i.test(noProject.body.error ?? ""));

  const foreign = await post(twin.id);
  ok("another company's project is not found", foreign.status === 404, String(foreign.status));

  const mine = await post(project.id);
  ok("their own project passes the check", mine.status === 400, String(mine.status));
  ok("reaching the file check instead", /file/i.test(mine.body.error ?? ""), mine.body.error ?? "");

  console.log("\n6. Archiving closes it to new designs, and destroys nothing");
  await setProjectStatus(staff.access, project.id, "archived");
  const archived = await post(project.id);
  ok("archived project refuses designs", archived.status === 409, String(archived.status));
  ok("the project still exists", (await getProject(orgA.id, project.id))?.status === "archived");
  await setProjectStatus(staff.access, project.id, "active");
  ok("and reopens", (await getProject(orgA.id, project.id))?.status === "active");

  console.log("\n7. Standards stay out of projects");
  const standards = await prisma.document.count({
    where: { role: "reference", projectId: { not: null } },
  });
  ok("no reference standard belongs to a project", standards === 0, String(standards));
} finally {
  await prisma.organisation.deleteMany({ where: { slug: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
