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
import { companyMatches } from "../src/lib/access/company-name";
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

console.log("\n2. The company name they will type");
for (const typed of ["satyamindustry", "Satyam Industry", "satyam industry", "SATYAMINDUSTRY"]) {
  ok(`"${typed}" accepted`, companyMatches(typed, org.name, org.slug));
}
ok('"northwind" rejected', !companyMatches("northwind", org.name, org.slug));

console.log("\n3. Where each account lands");
const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
const adminAccess = await admit(adminUser);
ok("orvinex lands in satyamindustry", "organisation" in adminAccess && adminAccess.organisation.id === org.id);
ok("orvinex is an administrator", "role" in adminAccess && adminAccess.role === "owner");
ok("no second organisation was created", (await prisma.organisation.count()) === 1);

const employeeUser = await prisma.user.findUniqueOrThrow({ where: { email: EMPLOYEE } });
const employeeAccess = await admit(employeeUser);
ok("satyam still gets in", "organisation" in employeeAccess && employeeAccess.organisation.id === org.id);
ok("satyam is now a member", "role" in employeeAccess && employeeAccess.role === "member");

console.log("\n4. Satyam keeps their work");
ok("still sees 3 documents", (await prisma.document.count({ where: { organisationId: org.id } })) === 3);
ok(
  "all 3 still attributed to them",
  (await prisma.document.count({ where: { uploadedBy: { email: EMPLOYEE } } })) === 3,
);
ok("the assessment run survives", (await prisma.assessmentRun.count()) === 1);
ok("all 28 findings survive", (await prisma.finding.count()) === 28);
ok("the technology reference survives", (await prisma.techAssessment.count({ where: { organisationId: org.id } })) === 1);

console.log("\n5. Neither is a platform operator");
ok("orvinex is not", !adminUser.isPlatformAdmin);
ok("satyam is not", !employeeUser.isPlatformAdmin);

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
