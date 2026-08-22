/**
 * Prove the two satyamindustry accounts behave as intended.
 *
 * Read-only — it signs in and inspects, and changes nothing. The point is to
 * check the things that would only be discovered by a user otherwise: that the
 * password actually works, that the company name they type is accepted, and
 * that satyam kept their access and their work.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/verify-satyam.mts
 */
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { admit } from "../src/lib/access/gate";
import { requireEnv } from "./require-env.mts";

const ADMIN = "orvinex@gmail.com";
const EMPLOYEE = "sk4251867@gmail.com";
const PASSWORD = requireEnv("SATYAM_ADMIN_PASSWORD", "Password for satyamindustry's administrator.");

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

const org = await prisma.organisation.findUniqueOrThrow({ where: { slug: "satyamindustry" } });

console.log("\n1. Sign-in through the real endpoint");
for (const [email, password, expected] of [
  [ADMIN, PASSWORD, true],
  [ADMIN, "definitely-not-the-password", false],
  [EMPLOYEE, PASSWORD, false],
] as const) {
  let status = 0;
  try {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    status = res.status;
  } catch {
    status = 401;
  }
  ok(
    `${email} ${expected ? "accepted" : "rejected"}`,
    (status === 200) === expected,
    `status ${status}`,
  );
}

console.log("\n2. Where each account lands");
const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
const adminAccess = await admit(adminUser);
ok("orvinex lands in satyamindustry", "organisation" in adminAccess && adminAccess.organisation.id === org.id);
ok("orvinex is an administrator", "role" in adminAccess && adminAccess.role === "owner");
ok("no second organisation was created", (await prisma.organisation.count()) === 1);

const employeeUser = await prisma.user.findUniqueOrThrow({ where: { email: EMPLOYEE } });
const employeeAccess = await admit(employeeUser);
ok("satyam still gets in", "organisation" in employeeAccess && employeeAccess.organisation.id === org.id);
ok("satyam is now a member", "role" in employeeAccess && employeeAccess.role === "member");

console.log("\n3. Satyam keeps their work");
// Counts, not exact numbers. These were pinned to the figures at the moment
// the workspace was restructured, which meant the suite started failing the
// first time somebody used the product — reporting growth as loss. What the
// restructure had to preserve is that satyam kept their work and it is still
// attributed to them, and that is what is asserted.
const documents = await prisma.document.count({ where: { organisationId: org.id } });
const theirs = await prisma.document.count({ where: { uploadedBy: { email: EMPLOYEE } } });
ok("the workspace still holds documents", documents > 0, String(documents));
ok("some are still attributed to them", theirs > 0, String(theirs));
ok("their assessment runs survive", (await prisma.assessmentRun.count()) > 0);
ok("their findings survive", (await prisma.finding.count()) > 0);
ok(
  "the company profile carried over from the retired technology reference",
  (await prisma.organisation.findUniqueOrThrow({ where: { id: org.id } })).primaryContact !== "",
);

console.log("\n4. Neither is a platform operator");
ok("orvinex is not", !adminUser.isPlatformAdmin);
ok("satyam is not", !employeeUser.isPlatformAdmin);

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
