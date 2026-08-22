/**
 * Profile replaces the technology reference: administrators only, employees
 * never, and the retired route is actually gone.
 *
 * Driven over HTTP against a throwaway organisation, because the page and its
 * Server Action both guard themselves and a member could otherwise reach the
 * action directly. Cleans up after itself.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-profile.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { OWNER, MEMBER } from "../src/lib/access/roles";
import { load, save, ProfileRefused } from "../src/lib/access/profile";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = "zz-profile";
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

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    // Better Auth refuses a request with no Origin as a CSRF precaution.
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

/**
 * Fetch a page and report what the caller actually receives.
 *
 * Status alone is not the answer here. The dashboard layout resolves before the
 * page does, so it commits a 200 and starts streaming — and a redirect raised
 * by the page afterwards travels inside that stream rather than as a 307. The
 * question worth asking is therefore "did the content reach them?", not "what
 * was the status line?".
 */
const visit = async (cookie: string, path: string) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const body = await res.text();
  return {
    status: res.status,
    location: res.headers.get("location"),
    body,
    redirected: res.status === 307 || body.includes("NEXT_REDIRECT"),
  };
};

const org = await prisma.organisation.create({
  data: { name: "ZZ Profile Co", slug: `${TAG}-${Date.now()}` },
});

try {
  const bossEmail = `${TAG}-boss@test.invalid`;
  const staffEmail = `${TAG}-staff@test.invalid`;
  const boss = await provisionAccount({ email: bossEmail, name: "Boss", company: org.name, password: PASSWORD });
  const staff = await provisionAccount({ email: staffEmail, name: "Staff", company: org.name, password: PASSWORD });
  await prisma.membership.createMany({
    data: [
      { userId: boss.userId, organisationId: org.id, role: OWNER },
      { userId: staff.userId, organisationId: org.id, role: MEMBER },
    ],
  });
  await prisma.rosterEntry.createMany({
    data: [
      { organisationId: org.id, email: bossEmail, status: "active", role: OWNER, userId: boss.userId },
      { organisationId: org.id, email: staffEmail, status: "active", role: MEMBER, userId: staff.userId },
    ],
  });

  console.log("\n1. The technology reference is gone");
  const bossCookie = await signIn(bossEmail);
  const retired = await visit(bossCookie, "/dashboard/tech-stack");
  ok("route no longer exists", retired.status === 404, `got ${retired.status}`);

  console.log("\n2. Profile is reachable by an administrator");
  const asOwner = await visit(bossCookie, "/dashboard/profile");
  ok("administrator gets the page", asOwner.status === 200, `got ${asOwner.status}`);
  ok("and the editable form", asOwner.body.includes("Save changes"));
  ok("with the company details on it", asOwner.body.includes("Primary contact"));

  console.log("\n3. An employee cannot reach it");
  const staffCookie = await signIn(staffEmail);
  const asMember = await visit(staffCookie, "/dashboard/profile");
  ok("the form never reaches them", !asMember.body.includes("Save changes"));
  ok("nor any of the fields", !asMember.body.includes("Primary contact"));
  ok("and they are redirected away", asMember.redirected);

  console.log("\n4. Saving, and what it refuses");
  await save(org.id, {
    name: "ZZ Profile Co",
    primaryContact: "Asha Patel",
    contactEmail: "asha@example.com",
    contactPhone: "+44 20 7946 0000",
    country: "United Kingdom",
    industry: "Energy",
    notes: "Pilot customer.",
  });
  const saved = await load(org.id);
  ok("details persist", saved.primaryContact === "Asha Patel" && saved.industry === "Energy");
  ok("slug is left alone", saved.slug === org.slug, saved.slug);

  const blank = {
    name: "",
    primaryContact: "",
    contactEmail: "",
    contactPhone: "",
    country: "",
    industry: "",
    notes: "",
  };
  for (const [label, input] of [
    ["a blank name", { ...blank, name: "  " }],
    ["a malformed contact email", { ...blank, name: "ZZ", contactEmail: "not-an-email" }],
  ] as const) {
    try {
      await save(org.id, input);
      ok(`${label} refused`, false);
    } catch (error) {
      ok(`${label} refused`, error instanceof ProfileRefused, (error as Error).message);
    }
  }

  console.log("\n5. Nothing anywhere still points at the retired feature");
  const leftover = await prisma.$queryRaw<{ n: number | bigint }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'tech%'`;
  ok("no tech_assessment table", Number(leftover[0].n) === 0);
} finally {
  await prisma.organisation.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
