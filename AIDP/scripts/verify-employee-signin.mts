/**
 * Walk the path a client's employee actually takes.
 *
 * Uses a throwaway account created through the People page's own functions and
 * removed at the end, so no real account's password is touched. The point is to
 * exercise the whole journey once: admitted by an administrator, given
 * credentials, signs in, gets in — and is shut out the moment they are revoked.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-employee-signin.mts
 */
import { randomBytes } from "node:crypto";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { admit } from "../src/lib/access/gate";
import * as roster from "../src/lib/access/roster";

const EMAIL = "zz-temp-employee@test.invalid";
// Generated per run rather than written down. The account is deleted at the end
// either way, but a password literal in a tracked file is a habit worth not
// having — see scripts/require-env.mts.
const PASSWORD = `zz-${randomBytes(18).toString("base64url")}`;

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

const signsIn = async (password: string) => {
  try {
    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password },
      asResponse: true,
    });
    return res.status === 200;
  } catch {
    return false;
  }
};

const org = await prisma.organisation.findUniqueOrThrow({ where: { slug: "satyamindustry" } });
const admin = await prisma.user.findUniqueOrThrow({ where: { email: "orvinex@gmail.com" } });
const actor = {
  user: { id: admin.id, name: admin.name, email: admin.email },
  organisation: { id: org.id },
  isOwner: true,
};

try {
  console.log("\n1. Administrator adds them, without access");
  const person = await roster.addPerson(actor, { email: EMAIL, name: "Temp Employee" }, { admit: false });
  ok("on the list", person.status === "imported", person.status);
  ok("no account yet", !person.hasAccount);
  ok("cannot sign in", !(await signsIn(PASSWORD)));

  console.log("\n2. Administrator issues credentials");
  const { created } = await roster.setPassword(actor, person.id, PASSWORD);
  ok("account created", created);
  ok("correct password works", await signsIn(PASSWORD));
  ok("wrong password does not", !(await signsIn("not-the-password")));

  console.log("\n3. They land in the right workspace, as a member");
  const employee = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const outcome = await admit(employee);
  ok("joins satyamindustry", "organisation" in outcome && outcome.organisation.id === org.id);
  ok("as a member, not an administrator", "role" in outcome && outcome.role === "member");

  console.log("\n4. Revoking shuts them out immediately");
  await roster.revoke(actor, [person.id]);
  const afterRevoke = await admit(employee);
  ok("refused", "reason" in afterRevoke && afterRevoke.reason === "revoked", JSON.stringify(afterRevoke));
  ok("membership gone", (await prisma.membership.count({ where: { userId: employee.id } })) === 0);
  ok("sessions gone", (await prisma.session.count({ where: { userId: employee.id } })) === 0);
  // The password still works — nothing about revocation invalidates it. That is
  // exactly why admission is checked separately from authentication.
  ok("password still valid, but access is not", await signsIn(PASSWORD));
} finally {
  const temp = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (temp) await prisma.user.delete({ where: { id: temp.id } });
  await prisma.rosterEntry.deleteMany({ where: { email: EMAIL } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
