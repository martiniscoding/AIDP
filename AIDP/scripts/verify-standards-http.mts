/**
 * Can a member actually upload a standards document?
 *
 * Asks the real endpoint over HTTP as a real signed-in member, because the
 * guard lives on a Route Handler that accepts direct POSTs — testing the policy
 * function alone would be testing the test.
 *
 * No file is attached on purpose. The standards guard runs *before* the file
 * checks, so the two outcomes separate cleanly and nothing is written to
 * storage or to the document table:
 *
 *   member + role=reference  -> 403, refused by the guard
 *   owner  + role=reference  -> 400, guard passed and it got as far as "no file"
 *
 * Creates a throwaway organisation with two accounts and deletes it afterwards.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-standards-http.mts
 */
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { OWNER, MEMBER } from "../src/lib/access/roles";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = "zz-stdhttp";
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
    // Better Auth refuses a request with no Origin as a CSRF precaution, and
    // a browser always sends one. Supplied here so this exercises the same
    // path a real sign-in takes rather than a weaker one.
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function upload(cookie: string, role: string) {
  const form = new FormData();
  form.set("role", role);
  const res = await fetch(`${BASE}/api/documents/upload`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

const org = await prisma.organisation.create({
  data: { name: "ZZ Standards HTTP", slug: `${TAG}-${Date.now()}` },
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

  console.log("\n1. MEMBER tries to upload a company standard");
  const staffCookie = await signIn(staffEmail);
  const refused = await upload(staffCookie, "reference");
  ok("refused with 403", refused.status === 403, `got ${refused.status}`);
  ok("told why", /administrator/i.test(refused.body.error ?? ""), refused.body.error ?? "");

  console.log("\n2. MEMBER uploads a design — still allowed");
  const design = await upload(staffCookie, "assessed");
  ok("NOT refused by the standards guard", design.status !== 403, `got ${design.status}`);
  ok("reached the file check instead", design.status === 400, `got ${design.status}`);

  console.log("\n3. A missing role falls back to 'reference', so it fails closed");
  const blank = await upload(staffCookie, "");
  ok("member still refused", blank.status === 403, `got ${blank.status}`);

  console.log("\n4. ADMINISTRATOR uploads a company standard");
  const bossCookie = await signIn(bossEmail);
  const allowed = await upload(bossCookie, "reference");
  ok("NOT refused by the standards guard", allowed.status !== 403, `got ${allowed.status}`);
  ok("reached the file check instead", allowed.status === 400, `got ${allowed.status}`);

  console.log("\n5. Nothing was written");
  ok("no documents created", (await prisma.document.count({ where: { organisationId: org.id } })) === 0);
} finally {
  await prisma.organisation.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
