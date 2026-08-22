/**
 * Signing in takes an email and a password. Nothing else.
 *
 * The workspace is resolved from the address through the roster an
 * administrator controls, so there is no company field to get wrong. What still
 * has to hold: an operator lands on their console, an employee on their
 * workspace, and a revoked account is turned away even though its password is
 * still perfectly correct.
 *
 * Driven through the real Server Action over HTTP, against throwaway
 * organisations that are removed at the end.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-signin.mts
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { provisionAccount } from "../src/lib/access/provision";
import { MEMBER } from "../src/lib/access/roles";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TAG = "zz-signin";
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

/**
 * The action id Next assigns to verifyWorkspace, read from the dev manifest so
 * this drives the same endpoint the browser does.
 *
 * Read once, after the route has been requested. The dev server compiles a
 * route on first hit, so reading the manifest before that returns a stale file
 * and the first call fails with "Server action not found" while every later one
 * succeeds — a confusing way for a test to be wrong about the code.
 */
function actionId(): string {
  const manifest = JSON.parse(
    readFileSync(".next/dev/server/server-reference-manifest.json", "utf8"),
  ) as { node: Record<string, { workers: Record<string, unknown> }> };
  for (const [id, entry] of Object.entries(manifest.node)) {
    if (Object.keys(entry.workers).some((worker) => worker.includes("sign-in"))) return id;
  }
  throw new Error("could not find the sign-in action");
}

async function signIn(email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return {
    status: res.status,
    cookie: (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

async function verify(cookie: string) {
  const res = await fetch(`${BASE}/sign-in`, {
    method: "POST",
    headers: {
      cookie,
      origin: BASE,
      "Next-Action": ACTION,
      "content-type": "text/plain;charset=UTF-8",
    },
    // No arguments: the action takes none any more.
    body: "[]",
  });
  const text = await res.text();
  return (/\{"ok".*\}/.exec(text)?.[0] ?? text.slice(0, 200)) as string;
}

// Warm the route so the manifest below is the compiled one.
await fetch(`${BASE}/sign-in`);
await new Promise((resolve) => setTimeout(resolve, 2500));
const ACTION = actionId();

const org = await prisma.organisation.create({
  data: { name: "ZZ Signin Co", slug: `${TAG}-${Date.now()}` },
});

try {
  const staffEmail = `${TAG}-staff@test.invalid`;
  const opEmail = `${TAG}-operator@test.invalid`;

  const staff = await provisionAccount({ email: staffEmail, name: "Staff", company: org.name, password: PASSWORD });
  await prisma.membership.create({ data: { userId: staff.userId, organisationId: org.id, role: MEMBER } });
  const seat = await prisma.rosterEntry.create({
    data: { organisationId: org.id, email: staffEmail, status: "active", role: MEMBER, userId: staff.userId },
  });

  const operator = await provisionAccount({ email: opEmail, name: "Op", company: "", password: PASSWORD });
  await prisma.user.update({ where: { id: operator.userId }, data: { isPlatformAdmin: true } });

  console.log("\n1. An employee: email and password only");
  const staffIn = await signIn(staffEmail);
  ok("password accepted", staffIn.status === 200, String(staffIn.status));
  const staffCheck = await verify(staffIn.cookie);
  ok("sent to their workspace", staffCheck.includes('"redirectTo":"/dashboard"'), staffCheck);
  ok("never asked for a company", !/company/i.test(staffCheck), staffCheck);

  console.log("\n2. The operator lands on the console");
  const opIn = await signIn(opEmail);
  const opCheck = await verify(opIn.cookie);
  ok("sent to /admin", opCheck.includes('"redirectTo":"/admin"'), opCheck);

  console.log("\n3. A revoked employee is refused, password notwithstanding");
  await prisma.rosterEntry.update({ where: { id: seat.id }, data: { status: "revoked" } });
  await prisma.membership.deleteMany({ where: { userId: staff.userId } });
  const revokedIn = await signIn(staffEmail);
  ok("their password is still correct", revokedIn.status === 200, String(revokedIn.status));
  const revokedCheck = await verify(revokedIn.cookie);
  ok("but they are turned away", revokedCheck.includes('"ok":false'), revokedCheck);
  ok("and told why", /withdrawn|administrator/i.test(revokedCheck), revokedCheck);

  console.log("\n4. The sign-in page no longer offers a company field");
  const form = await (await fetch(`${BASE}/sign-in`)).text();
  ok('no name="company" input', !form.includes('name="company"'));
  ok("no organization autocomplete", !form.includes('autoComplete="organization"') && !form.includes('autocomplete="organization"'));
} finally {
  await prisma.organisation.deleteMany({ where: { slug: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
