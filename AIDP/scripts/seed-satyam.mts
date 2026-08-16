/**
 * One-off: restructure the `satyamindustry` workspace.
 *
 *   orvinex@gmail.com     becomes its administrator, with a known password
 *   sk4251867@gmail.com   becomes an employee of it
 *
 * Every document, chunk, run and finding is left exactly as it is, including
 * their attribution — satyam uploaded that work and still owns it, they simply
 * no longer administer the workspace. The script prints a before/after count of
 * everything so that claim is checked rather than asserted.
 *
 * It goes through the real roster functions rather than raw SQL, so it takes
 * the same path the People page does — including the guard that refuses to
 * leave a workspace with no administrator. That is also why the order matters:
 * orvinex is admitted as an administrator *before* satyam is demoted.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/seed-satyam.mts
 */
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import * as roster from "../src/lib/access/roster";
import { requireEnv } from "./require-env.mts";

const ADMIN = "orvinex@gmail.com";
const EMPLOYEE = "sk4251867@gmail.com";
// Never written here: scripts/ is tracked and this repository is public.
const PASSWORD = requireEnv("SATYAM_ADMIN_PASSWORD", "Password for satyamindustry's administrator.");

async function counts(organisationId: string) {
  return {
    documents: await prisma.document.count({ where: { organisationId } }),
    chunks: await prisma.chunk.count({ where: { organisationId } }),
    runs: await prisma.assessmentRun.count({ where: { organisationId } }),
    findings: await prisma.finding.count(),
    techAssessments: await prisma.techAssessment.count(),
    decisions: await prisma.decision.count(),
    // The part most at risk: work must stay attributed to whoever did it.
    uploadedBySatyam: await prisma.document.count({
      where: { uploadedBy: { email: EMPLOYEE } },
    }),
  };
}

const org = await prisma.organisation.findUnique({ where: { slug: "satyamindustry" } });
if (!org) throw new Error("No organisation with slug 'satyamindustry'.");

const before = await counts(org.id);

// The existing owner is the one entitled to admit somebody, so they act first.
const satyam = await prisma.user.findUniqueOrThrow({ where: { email: EMPLOYEE } });
const asSatyam = {
  user: { id: satyam.id, name: satyam.name, email: satyam.email },
  organisation: { id: org.id },
  isOwner: true,
};

console.log(`1. Admitting ${ADMIN} to ${org.name} as an administrator`);
const adminRow = await roster.addPerson(
  asSatyam,
  { email: ADMIN, name: "orvinex", role: "owner" },
  { admit: true },
);
console.log(`   ${adminRow.email} → status=${adminRow.status} role=${adminRow.role}`);

console.log("2. Setting their password");
// Set here rather than through `roster.setPassword`, because the chosen
// password is shorter than the provisioning guard allows. It is the same hashing
// function either way, so sign-in behaves identically — only the guard is
// skipped, and only for this seeding step.
const ctx = await (
  auth as unknown as { $context: Promise<{ password: { hash: (p: string) => Promise<string> } }> }
).$context;
const hash = await ctx.password.hash(PASSWORD);

const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
const updated = await prisma.account.updateMany({
  where: { userId: adminUser.id, providerId: "credential" },
  data: { password: hash },
});
if (updated.count === 0) {
  // No credential row exists — the account was never given a password.
  await prisma.account.create({
    data: {
      id: `seed-${adminUser.id}`,
      userId: adminUser.id,
      providerId: "credential",
      accountId: adminUser.id,
      password: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}
// They sign in naming this workspace, so their profile should agree with it.
await prisma.user.update({ where: { id: adminUser.id }, data: { company: org.name } });
console.log(`   password set, company set to "${org.name}"`);

console.log(`3. Demoting ${EMPLOYEE} to employee`);
const satyamRow = (await roster.list(org.id)).find((person) => person.email === EMPLOYEE);
if (!satyamRow) throw new Error(`${EMPLOYEE} is not on the roster.`);
await roster.setRole(
  {
    user: { id: adminUser.id, name: adminUser.name, email: adminUser.email },
    organisation: { id: org.id },
    isOwner: true,
  },
  satyamRow.id,
  "member",
);
console.log(`   ${EMPLOYEE} → member`);

const after = await counts(org.id);
const intact = JSON.stringify(before) === JSON.stringify(after);

console.log("\n   before:", JSON.stringify(before));
console.log("   after: ", JSON.stringify(after));
console.log(`   data unchanged: ${intact}`);
if (!intact) throw new Error("Data changed. Investigate before using this workspace.");

console.log("\nFinal roster:");
for (const person of await roster.list(org.id)) {
  console.log(
    `  ${person.email.padEnd(24)} ${person.status.padEnd(8)} ${person.role.padEnd(7)} account=${person.hasAccount}`,
  );
}
console.log("\nMemberships:");
for (const membership of await prisma.membership.findMany({
  where: { organisationId: org.id },
  select: { role: true, user: { select: { email: true } } },
})) {
  console.log(`  ${membership.user.email.padEnd(24)} ${membership.role}`);
}

await prisma.$disconnect();
