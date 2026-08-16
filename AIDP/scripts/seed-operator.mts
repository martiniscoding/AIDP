/**
 * One-off: create the platform operator account.
 *
 * This is the "super admin" — the account that runs the product rather than
 * using it. It deliberately belongs to *no company*: no membership, no roster
 * entry, nothing to found one with. That is what keeps it out of every
 * customer's tenant, and `admit()` in src/lib/access/gate.ts refuses to create
 * an organisation for a platform admin precisely so that clicking through to a
 * dashboard cannot quietly turn the operator into a customer.
 *
 * The account can see every company's people and spend, and no customer's
 * documents — see the note at the top of src/lib/access/platform.ts.
 *
 * Run with:  npx tsx --env-file=.env.local scripts/seed-operator.mts
 */
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { requireEnv } from "./require-env.mts";

const EMAIL = process.env.OPERATOR_EMAIL ?? "superadmin@orivinex.com";
// Never written here: scripts/ is tracked and this repository is public.
const PASSWORD = requireEnv("OPERATOR_PASSWORD", "The platform operator's password.");
const NAME = "Super Admin";

const ctx = await (
  auth as unknown as {
    $context: Promise<{
      password: { hash: (p: string) => Promise<string> };
      internalAdapter: {
        createUser: (u: Record<string, unknown>) => Promise<{ id: string }>;
        linkAccount: (a: Record<string, unknown>) => Promise<unknown>;
        updatePassword: (id: string, hash: string) => Promise<unknown>;
      };
    }>;
  }
).$context;

// Better Auth's own hashing, so this account verifies through exactly the same
// sign-in path as a self-registered one. Set directly rather than through
// `provisionAccount` because the chosen password is shorter than that guard
// allows; only the guard is skipped, not the hashing.
const hash = await ctx.password.hash(PASSWORD);

const existing = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });

let userId: string;
if (existing) {
  await ctx.internalAdapter.updatePassword(existing.id, hash);
  userId = existing.id;
  console.log(`1. ${EMAIL} already existed — password reset`);
} else {
  // `company`, `country` and `phone` are NOT NULL because the sign-up form
  // collects them. An operator has no company, and saying so is more honest
  // than inventing one that would then show up in their profile.
  const user = await ctx.internalAdapter.createUser({
    email: EMAIL,
    name: NAME,
    emailVerified: false,
    company: "",
    country: "",
    phone: "",
  });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });
  userId = user.id;
  console.log(`1. Created ${EMAIL}`);
}

console.log("2. Granting platform operator rights");
await prisma.user.update({ where: { id: userId }, data: { isPlatformAdmin: true } });

// Belt and braces. If this account ever picked up a membership it would appear
// inside a customer's workspace, which is not what it is for.
const memberships = await prisma.membership.count({ where: { userId } });
const rosterRows = await prisma.rosterEntry.count({ where: { email: EMAIL } });
console.log(`   memberships: ${memberships}, roster entries: ${rosterRows} (both should be 0)`);

console.log("\nPlatform operators:");
for (const operator of await prisma.user.findMany({
  where: { isPlatformAdmin: true },
  select: { email: true, name: true },
})) {
  console.log(`  ${operator.email} (${operator.name})`);
}

console.log("\nCompanies this account can see:");
for (const organisation of await prisma.organisation.findMany({
  select: { name: true, _count: { select: { memberships: true, documents: true } } },
})) {
  console.log(
    `  ${organisation.name} — ${organisation._count.memberships} people, ${organisation._count.documents} documents`,
  );
}

await prisma.$disconnect();
